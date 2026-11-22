using HubWatch.Alerts;
using HubWatch.Config;
using HubWatch.Data;
using HubWatch.Hue;
using HubWatch.Realtime;
using HubWatch.Stats;
using HubWatch.Systems;
using Microsoft.AspNetCore.Http.Features;

namespace HubWatch.Api;

/// <summary>
/// The HTTP API. Data endpoints return data from every connected system; each item carries its systemId.
/// Pass ?systems=id1,id2 to limit them to some of the connected systems (unknown ids are ignored).
/// </summary>
public static class Endpoints
{
    /// <summary>The connected systems a request asks for: all of them, or those listed in ?systems=.</summary>
    private static IReadOnlyList<SystemRuntime> Selected(SystemRegistry registry, string? systems)
    {
        if (string.IsNullOrWhiteSpace(systems)) return registry.All;
        var wanted = systems.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet();
        return [.. registry.All.Where(s => wanted.Contains(s.Id))];
    }

    private static IReadOnlyList<string> SelectedIds(SystemRegistry registry, string? systems) =>
        [.. Selected(registry, systems).Select(s => s.Id)];

    public static void MapHubWatchApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/status", (SystemRegistry registry) => registry.Status());

        // ----- systems -----

        api.MapHueApi();
        api.MapIkeaApi();

        // Disconnects a system. Its recorded history is kept unless deleteData is true.
        api.MapDelete("/systems/{id}", async (string id, ConfigStore config, SystemSupervisor supervisor, Database db,
            bool? deleteData) =>
        {
            if (!config.RemoveSystem(id))
                return Results.Problem("No such system.", statusCode: StatusCodes.Status404NotFound);

            // Waits until its collector has stopped and closed its session, so nothing is written afterwards.
            await supervisor.ReconcileAsync();
            if (deleteData == true)
                db.DeleteSystemData(id);
            return Results.NoContent();
        });

        // Trusts the new TLS certificate a system presented after its pinned one stopped matching (state "error",
        // problem "certificate_changed"). Pins exactly the key that was refused, not whatever is presented next.
        api.MapPost("/systems/{id}/trust-certificate", async (string id, SystemRegistry registry, ConfigStore config,
            SystemSupervisor supervisor) =>
        {
            if (registry.Get(id) is not { } system || config.Systems.FirstOrDefault(s => s.Id == id) is not { } stored)
                return Results.Problem("No such system.", statusCode: StatusCodes.Status404NotFound);
            if (system.OfferedCertPin is not { } pin)
                return Results.Problem("This system has not presented a new certificate.", statusCode: StatusCodes.Status409Conflict);

            config.SaveSystem(stored with { CertPin = pin });
            await supervisor.ReconcileAsync(); // the config changed, so its collector restarts with the new pin
            return Results.NoContent();
        });

        // Starts connecting again to a system that gave up after failing for a while (state "offline").
        api.MapPost("/systems/{id}/reconnect", (string id, SystemRegistry registry) =>
        {
            if (registry.Get(id) is not { } system)
                return Results.Problem("No such system.", statusCode: StatusCodes.Status404NotFound);
            return system.RequestRetry()
                ? Results.NoContent()
                : Results.Problem("This system is not offline.", statusCode: StatusCodes.Status409Conflict);
        });

        // Stops trying to connect to a system (state "connecting" or "reconnecting"); it goes "offline" until reconnected.
        api.MapPost("/systems/{id}/stop", (string id, SystemRegistry registry) =>
        {
            if (registry.Get(id) is not { } system)
                return Results.Problem("No such system.", statusCode: StatusCodes.Status404NotFound);
            return system.RequestStop()
                ? Results.NoContent()
                : Results.Problem("This system is not trying to connect.", statusCode: StatusCodes.Status409Conflict);
        });

        // Switches a light, a device's light, a room or a zone on or off. The change is recorded when the system
        // reports it back, with origin "hubwatch".
        api.MapPost("/systems/{id}/power", async (string id, PowerRequest request, SystemRegistry registry,
            IEnumerable<ISystemAdapter> adapters, CancellationToken ct) =>
        {
            if (registry.Get(id) is not { } system)
                return Results.Problem("No such system.", statusCode: StatusCodes.Status404NotFound);
            if (adapters.FirstOrDefault(a => a.Kind == system.Kind) is not ISystemControl control)
                return Results.Problem("This kind of system cannot be controlled.", statusCode: StatusCodes.Status400BadRequest);
            if (string.IsNullOrWhiteSpace(request.Target))
                return Results.Problem("Missing target.", statusCode: StatusCodes.Status400BadRequest);

            try
            {
                await control.SetOnAsync(system, request.Target, request.On, ct);
                return Results.NoContent();
            }
            catch (KeyNotFoundException ex)
            {
                return Results.Problem(ex.Message, statusCode: StatusCodes.Status404NotFound);
            }
            catch (ControlFailedException ex)
            {
                return Results.Problem(ex.Message, statusCode: StatusCodes.Status502BadGateway);
            }
        });

        // ----- data -----

        api.MapGet("/events", (Database db, SystemRegistry registry, long? beforeTs, long? beforeId, int? limit, string? type,
                string? q, string? resource, string? device, string? systems) =>
        {
            IReadOnlyList<string>? ids = device is not null
                ? registry.FindByDevice(device)?.Resources.ResourceIdsOfDevice(device) ?? new List<string> { device }
                : resource is not null ? [resource]
                : null;
            return db.QueryEvents(SelectedIds(registry, systems), beforeTs, beforeId, limit ?? 200, type, q, ids);
        });

        api.MapGet("/events/{id:long}", (Database db, SystemRegistry registry, long id, string? systems) =>
            db.GetEvent(SelectedIds(registry, systems), id) is { } e ? Results.Ok(e) : Results.NotFound());

        api.MapGet("/event-types", (Database db, SystemRegistry registry, string? systems) =>
            db.ResourceTypes(SelectedIds(registry, systems)));

        api.MapGet("/sessions", (Database db, SystemRegistry registry, long? from, string? systems) =>
            db.QuerySessions(SelectedIds(registry, systems), from ?? DateTimeOffset.UtcNow.AddDays(-7).ToUnixTimeMilliseconds()));

        api.MapGet("/devices", (SystemRegistry registry, string? systems) =>
            Selected(registry, systems).SelectMany(s => s.Resources.GetDevices()).ToList());

        api.MapGet("/groups", (SystemRegistry registry, string? systems) =>
            Selected(registry, systems).SelectMany(s => s.Resources.GetGroups()).ToList());

        api.MapGet("/automations", (SystemRegistry registry, string? systems) =>
            Selected(registry, systems).SelectMany(s => s.Resources.GetAutomations()).ToList());

        api.MapGet("/readings", (Database db, SystemRegistry registry, string resource, string kind, int? hours, string? systems) =>
        {
            var range = Math.Clamp(hours ?? 24, 1, 24 * 366);
            // Up to two days: every reading. Longer: about 600 averaged points.
            var bucket = range <= 48 ? 0 : range * 3_600_000L / 600;
            return db.QueryReadings(SelectedIds(registry, systems), resource, kind,
                DateTimeOffset.UtcNow.AddHours(-range).ToUnixTimeMilliseconds(), bucket);
        });

        // Each system's own raw resource data, for troubleshooting.
        api.MapGet("/resources", (SystemRegistry registry, string? systems) =>
            Selected(registry, systems).Select(s => new { systemId = s.Id, resources = s.Resources.Raw() }).ToList());

        // Hue rules and schedules only exist in the bridge's v1 API, so they are read live from each bridge.
        api.MapGet("/rules", async (SystemRegistry registry, string? systems, CancellationToken ct) =>
        {
            var bridges = Selected(registry, systems).Where(s => s.Kind == HueAdapter.KindName).ToList();
            var results = await Task.WhenAll(bridges.Select(async system =>
            {
                try
                {
                    using var client = HueClient.ForSystem(system.Config);
                    var names = ((ResourceCache)system.Resources).NamesByV1Id();
                    try
                    {
                        return (Ok: await RulesReader.ReadAsync(system.Id, client, names, ct), Error: (string?)null);
                    }
                    catch (Exception) when (!ct.IsCancellationRequested)
                    {
                        client.ThrowIfCertificateChanged();
                        throw;
                    }
                }
                catch (Exception ex) when (!ct.IsCancellationRequested)
                {
                    return (Ok: (Rules: new List<RuleDto>(), Schedules: new List<ScheduleDto>()),
                        Error: $"Could not read rules from {system.DisplayName}: {ex.Message}");
                }
            }));

            var errors = results.Select(r => r.Error).OfType<string>().ToList();
            if (bridges.Count > 0 && errors.Count == bridges.Count)
                return Results.Problem(string.Join(" ", errors), statusCode: StatusCodes.Status502BadGateway);

            return Results.Ok(new RulesResponse(
                [.. results.SelectMany(r => r.Ok.Rules).OrderByDescending(r => r.LastTriggered ?? 0)],
                [.. results.SelectMany(r => r.Ok.Schedules).OrderBy(s => s.Name)],
                errors));
        });

        // ----- statistics -----

        api.MapGet("/stats", (StatsService stats, SystemRegistry registry, int? days, string? systems) =>
            stats.Compute(Selected(registry, systems), Math.Clamp(days ?? 7, 1, 90)));

        // ----- alerts -----

        api.MapGet("/alerts", (Database db, SystemRegistry registry, int? limit, string? systems) =>
            db.QueryAlerts(SelectedIds(registry, systems), Math.Clamp(limit ?? 100, 1, 500)));

        api.MapPost("/alerts/{id:long}/ack", (Database db, long id) =>
        {
            db.AcknowledgeAlert(id);
            return Results.NoContent();
        });

        api.MapPost("/alerts/ack-all", (Database db, SystemRegistry registry, string? systems) =>
        {
            db.AcknowledgeAllAlerts(SelectedIds(registry, systems));
            return Results.NoContent();
        });

        api.MapGet("/settings/alerts", (ConfigStore config) => config.Alerts);

        api.MapPut("/settings/alerts", (ConfigStore config, AlertSettings settings) =>
        {
            if (!string.IsNullOrWhiteSpace(settings.NtfyUrl) && !LocalRequestGuard.IsHttpUrl(settings.NtfyUrl.Trim()))
                return Results.Problem("The ntfy URL must be an http:// or https:// address.", statusCode: StatusCodes.Status400BadRequest);
            config.SetAlerts(settings with
            {
                LowBatteryPercent = Math.Clamp(settings.LowBatteryPercent, 1, 99),
                DeviceUnreachableMinutes = Math.Clamp(settings.DeviceUnreachableMinutes, 1, 1440),
                SystemUnreachableMinutes = Math.Clamp(settings.SystemUnreachableMinutes, 1, 1440),
                NtfyUrl = string.IsNullOrWhiteSpace(settings.NtfyUrl) ? null : settings.NtfyUrl.Trim(),
            });
            return Results.Ok(config.Alerts);
        });

        api.MapPost("/settings/alerts/test-ntfy", async (AlertService alerts, HttpRequest request, CancellationToken ct) =>
        {
            // ?url= lets the settings form test a URL before it is saved. Cross-site callers are stopped by LocalRequestGuard.
            var url = request.Query["url"].ToString().Trim();
            if (url.Length > 0 && !LocalRequestGuard.IsHttpUrl(url))
                return Results.Problem("The ntfy URL must be an http:// or https:// address.", statusCode: StatusCodes.Status400BadRequest);
            var ok = await alerts.SendNtfyAsync("HubWatch test", "Notifications are working.", "warning", ct,
                string.IsNullOrWhiteSpace(url) ? null : url);
            return ok ? Results.NoContent() : Results.Problem("Could not send to ntfy. Check the URL.", statusCode: StatusCodes.Status502BadGateway);
        });

        // ----- live updates (Server-Sent Events) -----

        api.MapGet("/stream", async (HttpContext context, EventBroadcaster broadcaster, SystemRegistry registry) =>
        {
            var ct = context.RequestAborted;
            context.Response.Headers.ContentType = "text/event-stream";
            context.Response.Headers.CacheControl = "no-cache";
            context.Response.Headers["X-Accel-Buffering"] = "no";
            context.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

            var (id, reader) = broadcaster.Subscribe();
            try
            {
                await context.Response.WriteAsync(EventBroadcaster.Format("status", registry.Status()), ct);
                await context.Response.Body.FlushAsync(ct);

                while (!ct.IsCancellationRequested)
                {
                    using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    wait.CancelAfter(TimeSpan.FromSeconds(15));
                    string message;
                    try
                    {
                        message = await reader.ReadAsync(wait.Token);
                    }
                    catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                    {
                        // A real event (not an SSE comment), so the browser can tell a quiet stream from a dead one.
                        message = "event: ping\ndata: {}\n\n";
                    }
                    await context.Response.WriteAsync(message, ct);
                    await context.Response.Body.FlushAsync(ct);
                }
            }
            catch (OperationCanceledException)
            {
                // browser went away
            }
            finally
            {
                broadcaster.Unsubscribe(id);
            }
        });
    }
}
