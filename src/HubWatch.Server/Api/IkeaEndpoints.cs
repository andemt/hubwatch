using System.Collections.Concurrent;
using System.Net;
using HubWatch.Config;
using HubWatch.Ikea;
using HubWatch.Systems;
using static HubWatch.Hue.Json;

namespace HubWatch.Api;

/// <param name="Ip">The hub's IP address or host name (e.g. gw2-xxxxxxxxxxxx.local).</param>
/// <param name="Start">True on the first call of a pairing attempt: starts afresh even if one is in progress.</param>
public sealed record IkeaPairRequest(string Ip, bool Start = false);

/// <summary>Pairing IKEA DIRIGERA hubs.</summary>
public static class IkeaEndpoints
{
    private static readonly TimeSpan PairWindow = TimeSpan.FromSeconds(90);

    /// <summary>A pairing in progress: the hub has handed out a code that becomes a token once its button is pressed.</summary>
    private sealed record PendingPairing(string Verifier, string Code, string? CertPin, DateTimeOffset StartedAt);

    private static readonly ConcurrentDictionary<string, PendingPairing> Pending = new(StringComparer.OrdinalIgnoreCase);

    public static void MapIkeaApi(this RouteGroupBuilder api)
    {
        var ikea = api.MapGroup("/ikea");

        // Adds a hub. The first call (start = true) asks the hub for a pairing code; poll afterwards while the user
        // presses the action button on the bottom of the hub: it answers paired = false until then.
        ikea.MapPost("/pair", async (IkeaPairRequest request, ConfigStore config, SystemSupervisor supervisor,
            ILoggerFactory loggers, CancellationToken ct) =>
        {
            var logger = loggers.CreateLogger("HubWatch.Ikea.Pairing");
            var ip = request.Ip?.Trim() ?? "";
            if (await CheckLocalAddressAsync(ip, ct) is { } problem) return problem;

            if (request.Start || !Pending.TryGetValue(ip, out var pending) || DateTimeOffset.UtcNow - pending.StartedAt > PairWindow)
            {
                Pending.TryRemove(ip, out _);
                using var client = new DirigeraClient(ip);
                var verifier = DirigeraClient.NewCodeVerifier();
                string code;
                try
                {
                    code = await client.AuthorizeAsync(verifier, ct);
                }
                catch (Exception ex) when (!ct.IsCancellationRequested)
                {
                    logger.LogInformation("No DIRIGERA hub answered at {Ip}: {Error}", ip, ex.Message);
                    return Results.Problem($"Could not reach a DIRIGERA hub at {ip}.", statusCode: StatusCodes.Status502BadGateway);
                }
                var certPin = client.ObservedCertPin;

                // The hub's id is only readable after pairing, so a hub HubWatch already has is recognised by its key.
                if (certPin is not null &&
                    config.Systems.FirstOrDefault(s => s.Kind == DirigeraAdapter.KindName && s.CertPin == certPin) is { } existing)
                {
                    if (string.Equals(existing.Address, ip, StringComparison.OrdinalIgnoreCase))
                        return Results.Problem($"HubWatch is already connected to {existing.Name ?? "this hub"}.",
                            statusCode: StatusCodes.Status409Conflict);
                    config.SaveSystem(existing with { Address = ip });
                    await supervisor.ReconcileAsync();
                    return Results.Ok(new { paired = true, systemId = existing.Id, name = existing.Name, alreadyPaired = true });
                }

                Pending[ip] = new PendingPairing(verifier, code, certPin, DateTimeOffset.UtcNow);
                return Results.Ok(new { paired = false, reason = "action_button" });
            }

            string? token;
            try
            {
                using var client = new DirigeraClient(ip, certPin: pending.CertPin);
                token = await client.TryGetTokenAsync(pending.Code, pending.Verifier, TokenName(), ct);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                return Results.Problem($"Pairing failed: {ex.Message}", statusCode: StatusCodes.Status502BadGateway);
            }
            if (token is null) return Results.Ok(new { paired = false, reason = "action_button" });
            Pending.TryRemove(ip, out _);

            // Now the hub can be asked who it is.
            string nativeId;
            string name;
            try
            {
                using var client = new DirigeraClient(ip, token, pending.CertPin);
                var devices = await client.GetDevicesAsync(ct);
                var gateway = devices.OfType<System.Text.Json.Nodes.JsonObject>()
                    .FirstOrDefault(d => Str(d["deviceType"]) == "gateway");
                nativeId = Str(gateway?["id"]) ?? pending.CertPin ?? ip;
                name = (Str(gateway?["attributes"]?["customName"]) is { Length: > 0 } custom ? custom : null) ?? "DIRIGERA";
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                return Results.Problem($"Paired, but the hub did not answer afterwards: {ex.Message}",
                    statusCode: StatusCodes.Status502BadGateway);
            }

            var systemId = SystemIdFor(nativeId);
            config.SaveSystem(new SystemConfig(systemId, DirigeraAdapter.KindName, ip, nativeId, name, token, pending.CertPin));
            await supervisor.ReconcileAsync();
            logger.LogInformation("Paired with DIRIGERA hub {Name} ({Ip})", name, ip);
            return Results.Ok(new { paired = true, systemId, name });
        });
    }

    /// <summary>A hub's system id is derived from its own id, so pairing it again finds the same history.</summary>
    public static string SystemIdFor(string nativeId)
    {
        var slug = new string(nativeId.ToLowerInvariant().Select(c => char.IsAsciiLetterOrDigit(c) ? c : '-').ToArray()).Trim('-');
        return $"{DirigeraAdapter.KindName}-{slug}";
    }

    /// <summary>How HubWatch shows up in the hub's list of connected apps.</summary>
    private static string TokenName()
    {
        var machine = new string(Environment.MachineName.Where(char.IsLetterOrDigit).Take(24).ToArray());
        return machine.Length > 0 ? $"HubWatch {machine}" : "HubWatch";
    }

    /// <summary>A hub is always on the local network; don't let this endpoint probe anything else.</summary>
    private static async Task<IResult?> CheckLocalAddressAsync(string ip, CancellationToken ct)
    {
        if (!IPAddress.TryParse(ip, out _) && Uri.CheckHostName(ip) is not UriHostNameType.Dns)
            return Results.Problem("That does not look like an IP address.", statusCode: StatusCodes.Status400BadRequest);

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
            return Results.Problem("The hub must have an address on your local network (for example 192.168.x.x).",
                statusCode: StatusCodes.Status400BadRequest);
        return null;
    }
}
