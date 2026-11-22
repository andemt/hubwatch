using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using HubWatch.Config;
using HubWatch.Data;
using HubWatch.Realtime;
using HubWatch.Systems;
using static HubWatch.Hue.Json;

namespace HubWatch.Hue;

/// <summary>
/// Philips Hue: connects to a bridge, takes a snapshot of all resources and then records every event
/// from the CLIP v2 event stream. The supervisor reconnects when this returns or throws.
/// </summary>
public sealed class HueAdapter(Database db, EventBroadcaster broadcaster, ConfigStore config, ILogger<HueAdapter> logger) : ISystemAdapter, ISystemControl
{
    public const string KindName = "hue";

    private static readonly TimeSpan SnapshotInterval = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(30);

    private readonly ConcurrentDictionary<string, PendingCommands> _pending = new();

    public string Kind => KindName;

    /// <summary>Shared by all systems connected to the same bridge, so each of them marks the change it records.</summary>
    private PendingCommands PendingFor(SystemRuntime system) =>
        _pending.GetOrAdd(system.Config.Address, _ => new PendingCommands());

    public async Task SetOnAsync(SystemRuntime system, string targetId, bool on, CancellationToken ct)
    {
        var cache = (ResourceCache)system.Resources;
        if (cache.PowerTarget(targetId) is not { } target)
            throw new KeyNotFoundException($"{targetId} is not a light, room or zone in {system.DisplayName}.");

        // Expect before sending: the event can arrive before the bridge has answered the request.
        var pending = PendingFor(system);
        pending.Expect(target.Affected, on);
        try
        {
            using var client = HueClient.ForSystem(system.Config);
            try
            {
                await client.UpdateResourceAsync(target.Type, target.Id, new JsonObject { ["on"] = new JsonObject { ["on"] = on } }, ct);
            }
            catch (Exception) when (!ct.IsCancellationRequested)
            {
                client.ThrowIfCertificateChanged();
                throw;
            }
            logger.LogInformation("{System}: switched {Name} {State}", system.DisplayName,
                cache.Describe(targetId).Name ?? targetId, on ? "on" : "off");
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            pending.Forget(target.Affected);
            throw ex switch
            {
                HueCommandException => new ControlFailedException(ex.Message, ex),
                CertificateChangedException => new ControlFailedException($"{system.DisplayName}: {ex.Message}", ex),
                UnauthorizedAccessException => new ControlFailedException(ex.Message, ex),
                _ => new ControlFailedException($"Could not reach {system.DisplayName}: {ex.Message}", ex),
            };
        }
    }

    public ISystemResources CreateResources(string systemId) => new ResourceCache(systemId);

    public async Task RunAsync(SystemRuntime system, Action onConnected, CancellationToken ct)
    {
        var cache = (ResourceCache)system.Resources;
        using var client = HueClient.ForSystem(system.Config);
        try
        {
            await RecordAsync(system, cache, client, onConnected, ct);
        }
        catch (Exception) when (!ct.IsCancellationRequested)
        {
            client.ThrowIfCertificateChanged();
            throw;
        }
    }

    private async Task RecordAsync(SystemRuntime system, ResourceCache cache, HueClient client, Action onConnected, CancellationToken ct)
    {
        var resources = await client.GetResourcesAsync(ct);
        PinCertificateOnFirstUse(system, client);
        cache.Load(resources);
        RecordSnapshot(system, cache, resources);
        broadcaster.Publish("snapshot", new { systemId = system.Id, at = Now() });

        long? sessionId = null;
        using var background = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var maintenance = MaintenanceLoopAsync(system, cache, client, () => sessionId, background.Token);

        try
        {
            await foreach (var batch in client.StreamEventsAsync(() =>
            {
                sessionId = db.StartSession(system.Id, Now());
                system.SetState(SystemState.Connected);
                onConnected();
                logger.LogInformation("Connected to Hue bridge {Name} ({Address})", system.DisplayName, system.Config.Address);
            }, ct))
            {
                HandleBatch(system, cache, batch);
            }
        }
        finally
        {
            await background.CancelAsync();
            try { await maintenance; } catch (OperationCanceledException) { }
            if (sessionId is { } id) db.EndSession(id, Now());
        }
    }

    /// <summary>
    /// Systems paired before certificate pinning existed have no pin yet: pin the key the bridge presents now.
    /// From then on a different key is refused (see <see cref="HueClient"/>).
    /// </summary>
    private void PinCertificateOnFirstUse(SystemRuntime system, HueClient client)
    {
        if (system.Config.CertPin is not null || client.ObservedCertPin is not { } pin) return;
        var updated = system.Config with { CertPin = pin };
        config.SaveSystem(updated);
        system.ReplaceConfig(updated);
        logger.LogInformation("{System}: pinned the bridge's TLS certificate", system.DisplayName);
    }

    /// <summary>Keeps the session alive in the database and refreshes the resource snapshot periodically.</summary>
    private async Task MaintenanceLoopAsync(SystemRuntime system, ResourceCache cache, HueClient client, Func<long?> sessionId,
        CancellationToken ct)
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
                    cache.Load(await client.GetResourcesAsync(ct));
                    broadcaster.Publish("snapshot", new { systemId = system.Id, at = Now() });
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogDebug(ex, "Periodic snapshot failed");
                }
            }
        }
    }

    private void HandleBatch(SystemRuntime system, ResourceCache cache, JsonArray batch)
    {
        var events = new List<StoredEvent>();
        var readings = new List<(long, Reading)>();
        var pending = PendingFor(system);

        foreach (var envelope in batch)
        {
            var eventType = Str(envelope?["type"]) ?? "update";
            var ts = UnixMs(envelope?["creationtime"]) ?? Now();

            foreach (var node in envelope?["data"] as JsonArray ?? [])
            {
                if (node is not JsonObject item || Str(item["id"]) is not { } resourceId) continue;

                var current = cache.Apply(eventType, item);
                var summary = EventInterpreter.Summarize(eventType, item, current, out var reading);
                var (name, room) = cache.Describe(resourceId);

                var origin = eventType == "update" && pending.TryMatch(system.Id, resourceId, Bool(item["on"]?["on"]))
                    ? Origins.HubWatch
                    : null;

                events.Add(new StoredEvent(0, system.Id, ts, eventType, resourceId, Str(item["type"]) ?? "unknown",
                    name, room, summary, item.ToJsonString(), origin));
                if (reading is not null) readings.Add((ts, reading));
            }
        }

        if (events.Count == 0) return;
        var stored = db.InsertEvents(system.Id, events, readings);
        system.TouchEvent(stored[^1].Ts);
        broadcaster.Publish("events", stored);
    }

    /// <summary>
    /// The bridge keeps the time of the last change for many sensors. When we (re)connect we record
    /// those as "backfill" events if they happened while we were not listening, and store current
    /// readings so charts start with a value.
    /// </summary>
    private void RecordSnapshot(SystemRuntime system, ResourceCache cache, JsonArray resources)
    {
        var events = new List<StoredEvent>();
        var readings = new List<(long, Reading)>();
        var now = Now();

        foreach (var node in resources)
        {
            if (node is not JsonObject r || Str(r["id"]) is not { } id) continue;
            var type = Str(r["type"]);

            var changedAt = type switch
            {
                "motion" => UnixMs(r["motion"]?["motion_report"]?["changed"]),
                "button" => UnixMs(r["button"]?["button_report"]?["updated"]),
                "contact" => UnixMs(r["contact_report"]?["changed"]),
                "temperature" => UnixMs(r["temperature"]?["temperature_report"]?["changed"]),
                "light_level" => UnixMs(r["light"]?["light_level_report"]?["changed"]),
                "relative_rotary" => UnixMs(r["relative_rotary"]?["rotary_report"]?["updated"]),
                _ => null,
            };

            var summary = EventInterpreter.Summarize("update", r, r, out var reading);
            if (reading is not null) readings.Add((now, reading));

            if (changedAt is not { } ts) continue;
            var last = db.LastEventTs(system.Id, id);
            if (last is not null && ts <= last + 2000) continue; // already recorded live

            var (name, room) = cache.Describe(id);
            events.Add(new StoredEvent(0, system.Id, ts, "backfill", id, type ?? "unknown", name, room, summary, r.ToJsonString()));
        }

        if (events.Count > 0 || readings.Count > 0)
            db.InsertEvents(system.Id, events, readings);
        if (events.Count > 0)
            logger.LogInformation("{System}: recorded {Count} events that happened while the app was not running",
                system.DisplayName, events.Count);
    }

    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}
