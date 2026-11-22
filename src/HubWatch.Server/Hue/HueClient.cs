using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json.Nodes;
using HubWatch.Systems;

namespace HubWatch.Hue;

public sealed record DiscoveredBridge(string Ip, string? Id, string? Name, string? Model);

public enum PairStatus { Paired, LinkButtonNotPressed, Failed }

public sealed record PairResult(PairStatus Status, string? AppKey = null, string? Error = null);

public sealed record BridgeInfo(string? Id, string? Name, string? Model, string? SoftwareVersion);

/// <summary>The bridge refused a change (unknown resource, device unreachable, invalid value, ...).</summary>
public sealed class HueCommandException(string message) : Exception(message);

/// <summary>
/// Thin client for the local Hue Bridge CLIP API v2.
/// See https://developers.meethue.com/develop/hue-api-v2/
/// </summary>
public sealed class HueClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly string? _appKey;
    private readonly string? _expectedPin;
    private volatile string? _observedPin;
    private volatile bool _pinMismatch;

    /// <param name="certPin">The pinned public key (see <see cref="Config.SystemConfig.CertPin"/>); null accepts any key.</param>
    public HueClient(string ip, string? appKey = null, string? certPin = null)
    {
        _appKey = appKey;
        _expectedPin = certPin;
        _http = new HttpClient(CreateHandler(ValidateCertificate))
        {
            BaseAddress = new Uri($"https://{ip}/"),
            Timeout = Timeout.InfiniteTimeSpan, // the event stream is long-lived; per-call timeouts use tokens
        };
        if (appKey is not null)
            _http.DefaultRequestHeaders.Add("hue-application-key", appKey);
    }

    /// <summary>A client for a connected system, using its credential and pinned certificate.</summary>
    public static HueClient ForSystem(Config.SystemConfig system) => new(system.Address, system.Credential, system.CertPin);

    /// <summary>The public key the bridge presented on the last TLS handshake (null before the first one).</summary>
    public string? ObservedCertPin => _observedPin;

    /// <summary>
    /// Throws <see cref="CertificateChangedException"/> if a request failed because the bridge presented a key other
    /// than the pinned one. Call it from a catch block to turn the generic TLS failure into something actionable.
    /// </summary>
    public void ThrowIfCertificateChanged()
    {
        if (_pinMismatch && _observedPin is { } presented)
            throw new CertificateChangedException(presented);
    }

    /// <summary>
    /// Bridges use certificates the OS does not trust: self-signed on older firmware, signed by Signify's private CA
    /// on newer firmware, and by an on-bridge CA on the Bridge Pro (whose chain is incomplete). Instead of validating
    /// a chain we pin the bridge's public key on first use. The CN is not checked: a self-signed certificate can claim
    /// any CN, so it would add nothing to the pin.
    /// </summary>
    private bool ValidateCertificate(X509Certificate? certificate)
    {
        if (certificate is null) return false;
        string pin;
        if (certificate is X509Certificate2 cert2)
        {
            pin = PinOf(cert2); // owned by the TLS stream: don't dispose
        }
        else
        {
            using var copy = new X509Certificate2(certificate);
            pin = PinOf(copy);
        }
        _observedPin = pin;
        if (_expectedPin is null || string.Equals(pin, _expectedPin, StringComparison.Ordinal)) return true;
        _pinMismatch = true;
        return false;
    }

    public static string PinOf(X509Certificate2 cert) =>
        Convert.ToBase64String(SHA256.HashData(cert.PublicKey.ExportSubjectPublicKeyInfo()));

    /// <summary>TCP keep-alive is enabled so a dead event-stream connection is detected.</summary>
    internal static SocketsHttpHandler CreateHandler(Func<X509Certificate?, bool> validate) => new()
    {
        SslOptions = { RemoteCertificateValidationCallback = (_, certificate, _, _) => validate(certificate) },
        PooledConnectionLifetime = TimeSpan.FromMinutes(10),
        ConnectTimeout = TimeSpan.FromSeconds(10),
        ConnectCallback = async (context, ct) =>
        {
            var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                TryEnableKeepAlive(socket);
                await socket.ConnectAsync(context.DnsEndPoint, ct);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        },
    };

    private static void TryEnableKeepAlive(Socket socket)
    {
        try
        {
            socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.KeepAlive, true);
            socket.SetSocketOption(SocketOptionLevel.Tcp, SocketOptionName.TcpKeepAliveTime, 30);
            socket.SetSocketOption(SocketOptionLevel.Tcp, SocketOptionName.TcpKeepAliveInterval, 10);
            socket.SetSocketOption(SocketOptionLevel.Tcp, SocketOptionName.TcpKeepAliveRetryCount, 3);
        }
        catch (SocketException)
        {
            // Not supported on this platform; the periodic snapshot still detects dead connections eventually.
        }
    }

    /// <summary>Unauthenticated basic info about the bridge (v1 /api/0/config).</summary>
    public async Task<BridgeInfo?> GetBridgeInfoAsync(CancellationToken ct)
    {
        using var timeout = WithTimeout(ct, TimeSpan.FromSeconds(5));
        var node = await _http.GetFromJsonAsync<JsonObject>("api/0/config", timeout.Token);
        if (node is null) return null;
        return new BridgeInfo(Json.Str(node["bridgeid"]), Json.Str(node["name"]), Json.Str(node["modelid"]), Json.Str(node["swversion"]));
    }

    /// <summary>
    /// Registers this app with the bridge. Succeeds only within ~30 s after the link button was pressed.
    /// </summary>
    public async Task<PairResult> PairAsync(CancellationToken ct)
    {
        var device = new string(Environment.MachineName.Where(char.IsLetterOrDigit).Take(19).ToArray());
        var body = new JsonObject
        {
            ["devicetype"] = $"hue_analyzer#{(device.Length > 0 ? device : "pc")}",
            ["generateclientkey"] = true,
        };

        using var timeout = WithTimeout(ct, TimeSpan.FromSeconds(10));
        using var response = await _http.PostAsync("api",
            new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"), timeout.Token);
        var result = JsonNode.Parse(await response.Content.ReadAsStringAsync(timeout.Token)) as JsonArray;
        var first = result?.FirstOrDefault();

        if (Json.Str(first?["success"]?["username"]) is { } key)
            return new PairResult(PairStatus.Paired, key);

        var error = first?["error"];
        if (Json.Num(error?["type"]) == 101)
            return new PairResult(PairStatus.LinkButtonNotPressed);

        return new PairResult(PairStatus.Failed, Error: Json.Str(error?["description"]) ?? $"HTTP {(int)response.StatusCode}");
    }

    /// <summary>
    /// Reads from the legacy v1 API (needed for rules and schedules, which v2 does not expose),
    /// e.g. path "rules" → GET /api/{key}/rules.
    /// </summary>
    public async Task<JsonObject> GetV1Async(string path, CancellationToken ct)
    {
        if (_appKey is null) throw new InvalidOperationException("Not paired.");
        using var timeout = WithTimeout(ct, TimeSpan.FromSeconds(15));
        using var response = await _http.GetAsync($"api/{_appKey}/{path}", timeout.Token);
        response.EnsureSuccessStatusCode();
        return JsonNode.Parse(await response.Content.ReadAsStringAsync(timeout.Token)) as JsonObject ?? [];
    }

    /// <summary>All v2 resources (devices, lights, sensors, rooms, scenes, ...).</summary>
    public async Task<JsonArray> GetResourcesAsync(CancellationToken ct)
    {
        using var timeout = WithTimeout(ct, TimeSpan.FromSeconds(20));
        using var response = await _http.GetAsync("clip/v2/resource", timeout.Token);
        response.EnsureSuccessStatusCode();
        var root = JsonNode.Parse(await response.Content.ReadAsStringAsync(timeout.Token));
        return root?["data"] as JsonArray ?? [];
    }

    /// <summary>
    /// Changes a v2 resource, e.g. type "light" with body {"on":{"on":true}} → PUT /clip/v2/resource/light/{id}.
    /// Throws <see cref="HueCommandException"/> with the bridge's own message when it refuses the change.
    /// </summary>
    public async Task UpdateResourceAsync(string type, string id, JsonObject body, CancellationToken ct)
    {
        if (_appKey is null) throw new InvalidOperationException("Not paired.");
        using var timeout = WithTimeout(ct, TimeSpan.FromSeconds(10));
        using var response = await _http.PutAsync($"clip/v2/resource/{Uri.EscapeDataString(type)}/{Uri.EscapeDataString(id)}",
            new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"), timeout.Token);
        if (response.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized)
            throw new UnauthorizedAccessException("The bridge rejected the application key. Pair again.");

        // The bridge answers { "data": [...], "errors": [{ "description": "..." }] }, also with status 207.
        var text = await response.Content.ReadAsStringAsync(timeout.Token);
        JsonNode? root = null;
        try { root = JsonNode.Parse(text); } catch (System.Text.Json.JsonException) { }
        var errors = (root?["errors"] as JsonArray ?? [])
            .Select(e => Json.Str(e?["description"]))
            .OfType<string>()
            .ToList();

        if (errors.Count > 0)
            throw new HueCommandException(string.Join(" ", errors));
        if (!response.IsSuccessStatusCode)
            throw new HueCommandException($"The bridge answered HTTP {(int)response.StatusCode}.");
    }

    /// <summary>
    /// Opens the v2 event stream (Server-Sent Events) and yields each "data:" payload,
    /// which is a JSON array of event envelopes: { creationtime, id, type, data: [ ... ] }.
    /// </summary>
    public async IAsyncEnumerable<JsonArray> StreamEventsAsync(Action onConnected, [EnumeratorCancellation] CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "eventstream/clip/v2");
        request.Headers.Accept.ParseAdd("text/event-stream");

        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized)
            throw new UnauthorizedAccessException("The bridge rejected the application key. Pair again.");
        response.EnsureSuccessStatusCode();
        onConnected();

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var data = new StringBuilder();

        while (true)
        {
            var line = await reader.ReadLineAsync(ct);
            if (line is null)
                yield break; // server closed the connection

            if (line.Length == 0)
            {
                if (data.Length > 0)
                {
                    var parsed = JsonNode.Parse(data.ToString()) as JsonArray;
                    data.Clear();
                    if (parsed is not null)
                        yield return parsed;
                }
                continue;
            }

            if (line.StartsWith("data:", StringComparison.Ordinal))
                data.Append(line.AsSpan(5).TrimStart());
            // "id:" lines and ":" comments (keep-alives) are ignored
        }
    }

    private static CancellationTokenSource WithTimeout(CancellationToken ct, TimeSpan after)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(after);
        return cts;
    }

    public void Dispose() => _http.Dispose();
}

/// <summary>Finds bridges via the Philips discovery service. TODO: add mDNS (_hue._tcp) for offline networks.</summary>
public static class HueDiscovery
{
    private static readonly HttpClient Cloud = new() { Timeout = TimeSpan.FromSeconds(8) };

    // The cloud discovery service is rate limited (roughly one request per 15 minutes per network), so the
    // last successful answer is reused for a while and as a fallback when the service refuses or is down.
    // Only the IP list is cached; each bridge is still asked for its id and name on the local network.
    private static readonly TimeSpan CacheFor = TimeSpan.FromMinutes(15);
    private static readonly Lock CacheLock = new();
    private static List<string>? _cachedIps;
    private static DateTimeOffset _cachedAt;

    public static async Task<List<DiscoveredBridge>> DiscoverAsync(ILogger logger, CancellationToken ct)
    {
        var ips = await FindIpsAsync(logger, ct);
        var tasks = ips.Select(ip => DescribeAsync(ip, ct));
        return [.. await Task.WhenAll(tasks)];
    }

    private static async Task<List<string>> FindIpsAsync(ILogger logger, CancellationToken ct)
    {
        List<string>? cached;
        lock (CacheLock)
        {
            cached = _cachedIps;
            if (cached is not null && DateTimeOffset.UtcNow - _cachedAt < CacheFor)
                return cached;
        }

        try
        {
            var found = await Cloud.GetFromJsonAsync<JsonArray>("https://discovery.meethue.com/", ct) ?? [];
            var ips = found
                .Select(n => Json.Str(n?["internalipaddress"]))
                .OfType<string>()
                .Distinct()
                .ToList();
            lock (CacheLock)
            {
                _cachedIps = ips;
                _cachedAt = DateTimeOffset.UtcNow;
            }
            return ips;
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            if (cached is null)
                throw;
            logger.LogWarning("Bridge discovery service failed ({Error}); using the previous result", ex.Message);
            return cached;
        }
    }

    public static async Task<DiscoveredBridge> DescribeAsync(string ip, CancellationToken ct)
    {
        try
        {
            using var client = new HueClient(ip);
            var info = await client.GetBridgeInfoAsync(ct);
            return new DiscoveredBridge(ip, info?.Id, info?.Name, info?.Model);
        }
        catch
        {
            return new DiscoveredBridge(ip, null, null, null);
        }
    }
}
