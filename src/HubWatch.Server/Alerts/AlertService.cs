using System.Text;
using HubWatch.Config;
using HubWatch.Data;
using HubWatch.Realtime;
using HubWatch.Systems;

namespace HubWatch.Alerts;

/// <summary>
/// Checks once a minute, for every connected system, for conditions worth alerting about and opens/resolves alerts.
/// New and resolved alerts are pushed to browsers (Server-Sent Events) and optionally to ntfy.
///
/// Checks: low battery, device unreachable for a while, system unreachable for a while.
/// Open alerts of systems that are no longer connected are resolved.
/// </summary>
public sealed class AlertService(
    ConfigStore config,
    Database db,
    SystemRegistry registry,
    EventBroadcaster broadcaster,
    ILogger<AlertService> logger) : BackgroundService
{
    public const string LowBattery = "low_battery";
    public const string DeviceUnreachable = "device_unreachable";
    public const string SystemUnreachable = "system_unreachable";

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(10) };
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);

    // When we first saw a problem, so short blips don't alert. Keyed by system id (and device id).
    private readonly Dictionary<(string System, string Device), long> _deviceDownSince = new();
    private readonly Dictionary<string, long> _systemDownSince = new();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Give the collectors a moment to load their first snapshots.
        await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await CheckAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Alert check failed");
            }
            await Task.Delay(Interval, stoppingToken);
        }
    }

    private async Task CheckAsync(CancellationToken ct)
    {
        var settings = config.Alerts;
        var systems = registry.All;
        var multiple = systems.Count > 1;

        foreach (var system in systems)
            await CheckSystemAsync(system, settings, multiple, ct);

        // Systems that were removed (or whose adapter is gone) can't recover any more: close their alerts.
        var connected = systems.Select(s => s.Id).ToHashSet();
        foreach (var id in _systemDownSince.Keys.Where(id => !connected.Contains(id)).ToList()) _systemDownSince.Remove(id);
        foreach (var key in _deviceDownSince.Keys.Where(k => !connected.Contains(k.System)).ToList()) _deviceDownSince.Remove(key);
        foreach (var systemId in db.SystemsWithOpenAlerts().Where(id => !connected.Contains(id)))
        {
            foreach (var alert in db.ResolveAllAlerts(systemId, Now()))
            {
                logger.LogInformation("Resolved (system no longer connected): {Title}", alert.Title);
                broadcaster.Publish("alert", alert);
            }
        }
    }

    private async Task CheckSystemAsync(SystemRuntime system, AlertSettings settings, bool multiple, CancellationToken ct)
    {
        var now = Now();
        var state = system.State;

        // ----- the system itself -----
        if (settings.SystemUnreachableEnabled && state is SystemState.Reconnecting or SystemState.Offline or SystemState.Error)
        {
            var since = _systemDownSince.TryGetValue(system.Id, out var s) ? s : _systemDownSince[system.Id] = now;
            if (now - since >= settings.SystemUnreachableMinutes * 60_000L)
                await OpenAsync(system, SystemUnreachable, system.Id, "critical", $"{system.DisplayName} is unreachable",
                    $"HubWatch has not been able to reach {system.DisplayName} for {settings.SystemUnreachableMinutes}+ minutes. " +
                    "Nothing is being recorded from it.", ct);
        }
        else if (state == SystemState.Connected || !settings.SystemUnreachableEnabled)
        {
            _systemDownSince.Remove(system.Id);
            await ResolveAsync(system, SystemUnreachable, system.Id, ct);
        }

        // Device checks need fresh data from the system.
        if (state != SystemState.Connected || !system.Resources.IsLoaded) return;
        var devices = system.Resources.GetDevices();
        var where = multiple ? $" on {system.DisplayName}" : "";

        // ----- low battery -----
        var lowBattery = settings.LowBatteryEnabled
            ? devices.Where(d => d.Battery < settings.LowBatteryPercent).ToDictionary(d => d.Id)
            : new Dictionary<string, DeviceDto>();
        foreach (var d in lowBattery.Values)
            await OpenAsync(system, LowBattery, d.Id, "warning", $"Low battery: {d.Name}",
                $"{d.Name}{InRoom(d)}{where} is at {d.Battery:0}% battery.", ct);
        foreach (var key in db.OpenAlertKeys(system.Id, LowBattery))
        {
            // Resolve with a little hysteresis so a battery hovering at the threshold doesn't flap.
            var device = devices.FirstOrDefault(d => d.Id == key);
            if (!lowBattery.ContainsKey(key) &&
                (device?.Battery is null || device.Battery >= settings.LowBatteryPercent + 3 || !settings.LowBatteryEnabled))
                await ResolveAsync(system, LowBattery, key, ct);
        }

        // ----- device unreachable -----
        var unreachable = settings.DeviceUnreachableEnabled
            ? devices.Where(d => d.Connectivity is not null && d.Connectivity != "connected").ToDictionary(d => d.Id)
            : new Dictionary<string, DeviceDto>();
        foreach (var key in _deviceDownSince.Keys.Where(k => k.System == system.Id && !unreachable.ContainsKey(k.Device)).ToList())
            _deviceDownSince.Remove(key);
        foreach (var d in unreachable.Values)
        {
            var key = (system.Id, d.Id);
            var since = _deviceDownSince.TryGetValue(key, out var s) ? s : _deviceDownSince[key] = now;
            if (now - since >= settings.DeviceUnreachableMinutes * 60_000L)
                await OpenAsync(system, DeviceUnreachable, d.Id, d.Connectivity == "disconnected" ? "critical" : "warning",
                    $"{d.Name} is unreachable",
                    $"{d.Name}{InRoom(d)}{where} reports \"{d.Connectivity!.Replace('_', ' ')}\". " +
                    "Check that it has power and is not too far from other devices.", ct);
        }
        foreach (var key in db.OpenAlertKeys(system.Id, DeviceUnreachable))
            if (!unreachable.ContainsKey(key))
                await ResolveAsync(system, DeviceUnreachable, key, ct);
    }

    private static string InRoom(DeviceDto d) => d.Room is null || d.Room == d.Name ? "" : $" ({d.Room})";

    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private async Task OpenAsync(SystemRuntime system, string kind, string key, string severity, string title, string message,
        CancellationToken ct)
    {
        var alert = db.OpenAlert(system.Id, kind, key, severity, title, message, Now());
        if (alert is null) return; // already open
        logger.LogInformation("Alert: {Title}", title);
        broadcaster.Publish("alert", alert);
        await SendNtfyAsync(title, message, severity, ct);
    }

    private async Task ResolveAsync(SystemRuntime system, string kind, string key, CancellationToken ct)
    {
        var alert = db.ResolveAlert(system.Id, kind, key, Now());
        if (alert is null) return;
        logger.LogInformation("Resolved: {Title}", alert.Title);
        broadcaster.Publish("alert", alert);
        await SendNtfyAsync($"Resolved: {alert.Title}", "The problem is gone.", "resolved", ct);
    }

    /// <summary>Sends a push notification via ntfy (https://ntfy.sh), if a topic URL is configured.</summary>
    public async Task<bool> SendNtfyAsync(string title, string message, string severity, CancellationToken ct, string? urlOverride = null)
    {
        var url = urlOverride ?? config.Alerts.NtfyUrl;
        if (string.IsNullOrWhiteSpace(url)) return false;
        if (!Api.LocalRequestGuard.IsHttpUrl(url))
        {
            logger.LogWarning("Ignoring ntfy URL that is not http(s)");
            return false;
        }
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = new StringContent(message, Encoding.UTF8, "text/plain"),
            };
            // Header values must be ASCII; ntfy accepts RFC 2047 encoding for anything else.
            request.Headers.TryAddWithoutValidation("Title", $"=?UTF-8?B?{Convert.ToBase64String(Encoding.UTF8.GetBytes(title))}?=");
            request.Headers.TryAddWithoutValidation("Priority", severity == "critical" ? "high" : "default");
            request.Headers.TryAddWithoutValidation("Tags", severity switch
            {
                "critical" => "rotating_light",
                "resolved" => "white_check_mark",
                _ => "warning",
            });
            using var response = await Http.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
                logger.LogWarning("ntfy returned {Status}", (int)response.StatusCode);
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Could not send ntfy notification");
            return false;
        }
    }
}
