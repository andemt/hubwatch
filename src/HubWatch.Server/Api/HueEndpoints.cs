using System.Net;
using HubWatch.Config;
using HubWatch.Hue;
using HubWatch.Systems;

namespace HubWatch.Api;

public sealed record HuePairRequest(string Ip);

/// <summary>Finding and pairing Philips Hue bridges.</summary>
public static class HueEndpoints
{
    public static void MapHueApi(this RouteGroupBuilder api)
    {
        var hue = api.MapGroup("/hue");

        hue.MapGet("/discover", async (ILoggerFactory loggers, CancellationToken ct) =>
        {
            var logger = loggers.CreateLogger("HubWatch.Discovery");
            try
            {
                return Results.Ok(await HueDiscovery.DiscoverAsync(logger, ct));
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                logger.LogWarning("Bridge discovery failed: {Error}", ex.Message);
                return Results.Problem(
                    "Automatic discovery failed. Enter the bridge's IP address manually " +
                    "(you can find it in the Hue app under Settings → Bridges).",
                    statusCode: StatusCodes.Status502BadGateway);
            }
        });

        // Adds a bridge. Poll this while the user presses the link button: it answers paired = false until then.
        hue.MapPost("/pair", async (HuePairRequest request, ConfigStore config, SystemSupervisor supervisor, CancellationToken ct) =>
        {
            var ip = request.Ip?.Trim() ?? "";
            if (!IPAddress.TryParse(ip, out _) && Uri.CheckHostName(ip) is not (UriHostNameType.Dns))
                return Results.Problem("That does not look like an IP address.", statusCode: StatusCodes.Status400BadRequest);

            // A Hue bridge is always on the local network; don't let this endpoint probe anything else.
            IPAddress[] addresses;
            try
            {
                addresses = IPAddress.TryParse(ip, out var literal) ? [literal] : await Dns.GetHostAddressesAsync(ip, ct);
            }
            catch (Exception) when (!ct.IsCancellationRequested)
            {
                return Results.Problem($"Could not find {ip} on the network.", statusCode: StatusCodes.Status400BadRequest);
            }
            if (addresses.Length == 0 || !addresses.All(LocalRequestGuard.IsLocalNetworkAddress))
                return Results.Problem("The bridge must have an address on your local network (for example 192.168.x.x).",
                    statusCode: StatusCodes.Status400BadRequest);

            using var client = new HueClient(ip);

            BridgeInfo? info;
            try
            {
                info = await client.GetBridgeInfoAsync(ct);
            }
            catch (Exception) when (!ct.IsCancellationRequested)
            {
                return Results.Problem($"Could not reach a Hue bridge at {ip}.", statusCode: StatusCodes.Status502BadGateway);
            }
            if (info?.Id is not { Length: > 0 } bridgeId)
                return Results.Problem($"The device at {ip} did not identify itself as a Hue bridge.",
                    statusCode: StatusCodes.Status502BadGateway);

            var systemId = SystemIdFor(bridgeId);
            // Pinned on first use: the key presented now is the one HubWatch will trust for this bridge.
            var certPin = client.ObservedCertPin;

            // Don't pair a bridge we already have: that would only create another application key on it.
            // If it has moved to a new IP address, keep the existing key and just follow it.
            if (config.Systems.FirstOrDefault(s => s.Id == systemId) is { } existing)
            {
                if (string.Equals(existing.Address, ip, StringComparison.OrdinalIgnoreCase))
                    return Results.Problem($"HubWatch is already connected to {existing.Name ?? "this bridge"}.",
                        statusCode: StatusCodes.Status409Conflict);

                // Following a bridge to a new address hands it the stored key, so it must be the same bridge.
                if (existing.CertPin is not null && existing.CertPin != certPin)
                    return Results.Problem(
                        $"The device at {ip} says it is {existing.Name ?? "this bridge"}, but its security certificate is different. " +
                        "HubWatch did not send it the bridge's key.",
                        statusCode: StatusCodes.Status409Conflict);

                config.SaveSystem(existing with { Address = ip, Name = info.Name ?? existing.Name, CertPin = existing.CertPin ?? certPin });
                await supervisor.ReconcileAsync();
                return Results.Ok(new { paired = true, systemId, name = info.Name ?? existing.Name, alreadyPaired = true });
            }

            PairResult result;
            try
            {
                result = await client.PairAsync(ct);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                return Results.Problem($"Pairing failed: {ex.Message}", statusCode: StatusCodes.Status502BadGateway);
            }

            switch (result.Status)
            {
                case PairStatus.Paired:
                    config.SaveSystem(new SystemConfig(systemId, HueAdapter.KindName, ip, bridgeId, info.Name, result.AppKey!, certPin));
                    await supervisor.ReconcileAsync();
                    return Results.Ok(new { paired = true, systemId, name = info.Name });
                case PairStatus.LinkButtonNotPressed:
                    return Results.Ok(new { paired = false, reason = "link_button" });
                default:
                    return Results.Problem($"The bridge refused pairing: {result.Error}", statusCode: StatusCodes.Status502BadGateway);
            }
        });
    }

    /// <summary>A bridge's system id is derived from its own id, so pairing it again always finds the same history.</summary>
    public static string SystemIdFor(string bridgeId) => $"{HueAdapter.KindName}-{bridgeId.ToLowerInvariant()}";
}
