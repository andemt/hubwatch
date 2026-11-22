using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using HubWatch.Config;
using HubWatch.Data;
using HubWatch.Hue;
using HubWatch.Realtime;
using HubWatch.Systems;
using static HubWatch.Hue.Json;

namespace HubWatch.Ikea;

/// <summary>
/// IKEA DIRIGERA: connects to a hub, takes a snapshot of its devices, rooms and scenes and then records every message
/// from its event websocket. The hub keeps no history either, so everything comes from listening while HubWatch runs.
/// </summary>
public sealed class DirigeraAdapter(Database db, EventBroadcaster broadcaster, ConfigStore config, ILogger<DirigeraAdapter> logger)
    : ISystemAdapter, ISystemControl
{
    public const string KindName = "dirigera";

    private static readonly TimeSpan SnapshotInterval = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(30);
    // The hub now and then closes the websocket "due to inactivity". Reconnect at once and keep the session,
    // unless it keeps closing right away (then something is wrong and the supervisor takes over with back-off).
    private static readonly TimeSpan ShortConnection = TimeSpan.FromSeconds(10);
    private const int MaxShortConnections = 3;

    private readonly ConcurrentDictionary<string, PendingCommands> _pending = new();

    public string Kind => KindName;

    private PendingCommands PendingFor(SystemRuntime system) =>
        _pending.GetOrAdd(system.Config.Address, _ => new PendingCommands());

    public ISystemResources CreateResources(string systemId) => new IkeaResources(systemId);

    public async Task SetOnAsync(SystemRuntime system, string targetId, bool on, CancellationToken ct)
    {
        var resources = (IkeaResources)system.Resources;
        var lights = resources.LightsOf(targetId);
        if (lights.Count == 0)
            throw new KeyNotFoundException($"{targetId} is not a light or a room with lights in {system.DisplayName}.");

        var pending = PendingFor(system);
        pending.Expect(lights, on);
        try
        {
            using var client = DirigeraClient.ForSystem(system.Config);
            try
            {
                // DIRIGERA has no documented room-wide switch; switch the room's lights one by one.
                foreach (var light in lights)
                    await client.SetAttributesAsync(light, new JsonObject { ["isOn"] = on }, ct);
            }
            catch (Exception) when (!ct.IsCancellationRequested)
            {
                client.ThrowIfCertificateChanged();
                throw;
            }
            logger.LogInformation("{System}: switched {Name} {State}", system.DisplayName,
                resources.Describe(targetId).Name ?? targetId, on ? "on" : "off");
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            pending.Forget(lights);
            throw ex switch
            {
                DirigeraCommandException => new ControlFailedException(ex.Message, ex),
                CertificateChangedException => new ControlFailedException($"{system.DisplayName}: {ex.Message}", ex),
                UnauthorizedAccessException => new ControlFailedException(ex.Message, ex),
                _ => new ControlFailedException($"Could not reach {system.DisplayName}: {ex.Message}", ex),
            };
        }
    }

    public async Task RunAsync(SystemRuntime system, Action onConnected, CancellationToken ct)
    {
        var resources = (IkeaResources)system.Resources;
        using var client = DirigeraClient.ForSystem(system.Config);
        try
        {
            await RecordAsync(system, resources, client, onConnected, ct);
        }
        catch (Exception) when (!ct.IsCancellationRequested)
        {
            client.ThrowIfCertificateChanged();
            throw;
        }
    }

    private async Task RecordAsync(SystemRuntime system, IkeaResources resources, DirigeraClient client, Action onConnected,
        CancellationToken ct)
    {
        await LoadSnapshotAsync(system, resources, client, ct);
        PinCertificateOnFirstUse(system, client);
        RecordReadings(system, resources);

        long? sessionId = null;
        using var background = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var maintenance = MaintenanceLoopAsync(system, resources, client, () => sessionId, background.Token);

        try
        {
            var shortConnections = 0;
            while (!ct.IsCancellationRequested)
            {
                var connectedAt = DateTimeOffset.UtcNow;
                await foreach (var message in client.StreamEventsAsync(() =>
                {
                    connectedAt = DateTimeOffset.UtcNow;
                    if (sessionId is not null) return;
                    sessionId = db.StartSession(system.Id, Now());
                    system.SetState(SystemState.Connected);
                    onConnected();
                    logger.LogInformation("Connected to DIRIGERA hub {Name} ({Address})", system.DisplayName, system.Config.Address);
                }, ct))
                {
                    HandleMessage(system, resources, message);
                }

                if (DateTimeOffset.UtcNow - connectedAt < ShortConnection)
                {
                    if (++shortConnections >= MaxShortConnections) return;
                }
                else
                {
                    shortConnections = 0;
                }
                logger.LogDebug("{System}: the hub closed the event connection; reconnecting", system.DisplayName);

                // Anything that changed while reconnecting is not in the log, but the current state should be right.
                try { await LoadSnapshotAsync(system, resources, client, ct); }
                catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogDebug(ex, "Snapshot after reconnect failed"); }
            }
        }
        finally
        {
            await background.CancelAsync();
            try { await maintenance; } catch (OperationCanceledException) { }
            if (sessionId is { } id) db.EndSession(id, Now());
        }
    }

    private async Task LoadSnapshotAsync(SystemRuntime system, IkeaResources resources, DirigeraClient client, CancellationToken ct)
    {
        var devices = await client.GetDevicesAsync(ct);
        JsonArray? rooms = null, scenes = null;
        try { rooms = await client.GetRoomsAsync(ct); }
        catch (Exception ex) when (ex is not (OperationCanceledException or UnauthorizedAccessException)) { logger.LogDebug(ex, "Could not read rooms"); }
        try { scenes = await client.GetScenesAsync(ct); }
        catch (Exception ex) when (ex is not (OperationCanceledException or UnauthorizedAccessException)) { logger.LogDebug(ex, "Could not read scenes"); }

        resources.Load(devices, rooms, scenes);
        broadcaster.Publish("snapshot", new { systemId = system.Id, at = Now() });
    }

    private void PinCertificateOnFirstUse(SystemRuntime system, DirigeraClient client)
    {
        if (system.Config.CertPin is not null || client.ObservedCertPin is not { } pin) return;
        var updated = system.Config with { CertPin = pin };
        config.SaveSystem(updated);
        system.ReplaceConfig(updated);
        logger.LogInformation("{System}: pinned the hub's TLS certificate", system.DisplayName);
    }

    private async Task MaintenanceLoopAsync(SystemRuntime system, IkeaResources resources, DirigeraClient client,
        Func<long?> sessionId, CancellationToken ct)
    {
        var lastSnapshot = DateTimeOffset.UtcNow;
        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(HeartbeatInterval, ct);
            if (sessionId() is { } id) db.TouchSession(id, Now());

            if (DateTimeOffset.UtcNow - lastSnapshot >= SnapshotInterval)
            {
                lastSnapshot = DateTimeOffset.UtcNow;
                try
                {
                    await LoadSnapshotAsync(system, resources, client, ct);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogDebug(ex, "Periodic snapshot failed");
                }
            }
        }
    }

    private void HandleMessage(SystemRuntime system, IkeaResources resources, JsonObject message)
    {
        if (Str(message["type"]) is not { } type || message["data"] is not JsonObject data) return;
        var ts = UnixMs(message["time"]) ?? Now();
        var raw = data.ToJsonString();
        var events = new List<StoredEvent>();
        var readings = new List<Reading>();

        if (type.StartsWith("device", StringComparison.Ordinal) && Str(data["id"]) is { } deviceId)
        {
            var (before, after) = resources.ApplyDevice(type, data);
            (string? name, string? room) = after is not null ? resources.Describe(deviceId)
                : before is not null ? (IkeaResources.NameOf(before), null) : (null, null);
            var pending = PendingFor(system);

            foreach (var change in IkeaEventInterpreter.Interpret(type, data, before, after, readings))
            {
                var origin = change.ResourceType == "light"
                             && pending.TryMatch(system.Id, deviceId, Bool(data["attributes"]?["isOn"]))
                    ? Origins.HubWatch
                    : null;
                events.Add(new StoredEvent(0, system.Id, ts, change.EventType, deviceId, change.ResourceType,
                    name, room, change.Summary, raw, origin));
            }
        }
        else
        {
            var id = Str(data["id"]) ?? Str(message["id"]) ?? type;
            var sceneName = resources.SceneName(id);
            resources.ApplyOther(type, data);
            if (IkeaEventInterpreter.InterpretOther(type, data, sceneName) is { } change)
            {
                var (name, room) = resources.Describe(id);
                events.Add(new StoredEvent(0, system.Id, ts, change.EventType, id, change.ResourceType,
                    name ?? sceneName, room, change.Summary, raw));
            }
        }

        if (events.Count == 0 && readings.Count == 0) return;
        var stored = db.InsertEvents(system.Id, events, [.. readings.Select(r => (ts, r))]);
        if (stored.Count == 0) return;
        system.TouchEvent(stored[^1].Ts);
        broadcaster.Publish("events", stored);
    }

    /// <summary>Stores the current values at connect, so charts start with a value.</summary>
    private void RecordReadings(SystemRuntime system, IkeaResources resources)
    {
        var now = Now();
        var readings = new List<(long, Reading)>();
        foreach (var d in resources.GetDevices())
        {
            if (d.On is { } on && d.Services.Light is not null) readings.Add((now, new Reading(d.Id, "on", on ? 1 : 0)));
            if (d.Temperature is { } t) readings.Add((now, new Reading(d.Id, "temperature", t)));
            if (d.Lux is { } lux) readings.Add((now, new Reading(d.Id, "lux", lux)));
            if (d.Battery is { } b) readings.Add((now, new Reading(d.Id, "battery", b)));
        }
        if (readings.Count > 0) db.InsertEvents(system.Id, [], readings);
    }

    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}
