using System.Net;
using System.Net.Sockets;

namespace HubWatch.Api;

/// <summary>
/// Protects the API from web pages the user happens to visit while HubWatch is running.
/// Browsers can reach localhost, so without this a malicious site could:
/// - use DNS rebinding (its own domain name resolving to 127.0.0.1) to read data and call the API, and
/// - fire cross-site POST/PUT/DELETE requests ("simple" requests skip the CORS preflight).
///
/// Rules:
/// - The Host header must be an IP address, localhost, or this computer's own name. A rebinding attack always
///   arrives with the attacker's domain name in Host, so it is rejected; LAN access via
///   --urls=http://0.0.0.0:5080 and http://192.168.x.y:5080 keeps working.
/// - A state-changing request with an Origin header must come from the same host name (any port, so the Vite
///   dev server on :5173 works) or from loopback.
/// Extra host names (e.g. a local DNS name for this computer) can be allowed with --ExtraAllowedHosts=name1;name2.
/// </summary>
public static class LocalRequestGuard
{
    public static IApplicationBuilder UseLocalRequestGuard(this IApplicationBuilder app)
    {
        var config = app.ApplicationServices.GetRequiredService<IConfiguration>();
        var logger = app.ApplicationServices.GetRequiredService<ILoggerFactory>().CreateLogger("HubWatch.RequestGuard");

        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "localhost" };
        foreach (var name in new[] { Environment.MachineName, SafeHostName() })
        {
            if (string.IsNullOrWhiteSpace(name)) continue;
            names.Add(name);
            names.Add(name + ".local");
        }
        foreach (var extra in (config["ExtraAllowedHosts"] ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            names.Add(extra);

        return app.Use(async (context, next) =>
        {
            var request = context.Request;
            var host = request.Host.Host;

            if (!IsAllowedHost(host, names))
            {
                logger.LogWarning("Rejected request with unexpected Host header {Host}", host);
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                return;
            }

            if (!HttpMethods.IsGet(request.Method) && !HttpMethods.IsHead(request.Method) && !HttpMethods.IsOptions(request.Method)
                && request.Headers.Origin.ToString() is { Length: > 0 } origin
                && !IsAllowedOrigin(origin, host))
            {
                logger.LogWarning("Rejected {Method} {Path} from origin {Origin}", request.Method, request.Path, origin);
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return;
            }

            await next();
        });
    }

    private static bool IsAllowedHost(string host, HashSet<string> names)
    {
        if (string.IsNullOrEmpty(host)) return false;
        if (IPAddress.TryParse(host.Trim('[', ']'), out _)) return true;
        return names.Contains(host) || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsAllowedOrigin(string origin, string requestHost)
    {
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")) return false;
        var originHost = uri.Host.Trim('[', ']');
        if (string.Equals(originHost, requestHost.Trim('[', ']'), StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(originHost, "localhost", StringComparison.OrdinalIgnoreCase)) return true;
        return IPAddress.TryParse(originHost, out var ip) && IPAddress.IsLoopback(ip);
    }

    private static string? SafeHostName()
    {
        try { return Dns.GetHostName(); } catch (SocketException) { return null; }
    }

    /// <summary>Loopback, private (RFC 1918 / unique local) or link-local: addresses a Hue bridge can have.</summary>
    public static bool IsLocalNetworkAddress(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip)) return true;
        if (ip.AddressFamily == AddressFamily.InterNetworkV6)
            return ip.IsIPv6LinkLocal || ip.IsIPv6UniqueLocal || ip.IsIPv6SiteLocal;
        var b = ip.GetAddressBytes();
        return b[0] == 10
            || (b[0] == 172 && b[1] >= 16 && b[1] <= 31)
            || (b[0] == 192 && b[1] == 168)
            || (b[0] == 169 && b[1] == 254);
    }

    /// <summary>True if http(s) URL; ntfy topics are never anything else.</summary>
    public static bool IsHttpUrl(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https";
}
