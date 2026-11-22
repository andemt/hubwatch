using System.Net;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json.Nodes;
using HubWatch.Hue;
using HubWatch.Systems;

namespace HubWatch.Ikea;

/// <summary>The hub refused a change (unknown device, invalid value, ...).</summary>
public sealed class DirigeraCommandException(string message) : Exception(message);

/// <summary>
/// Thin client for the local API of an IKEA DIRIGERA hub: REST on https://{ip}:8443/v1 and an event websocket on
/// wss://{ip}:8443/v1, both authorised with a bearer token. IKEA does not document this API; it is the one the
/// IKEA Home smart app uses, as described by community libraries.
/// The hub uses a self-signed certificate, so its public key is pinned on first use, like a Hue bridge.
/// </summary>
public sealed class DirigeraClient : IDisposable
{
    public const int Port = 8443;

    private readonly SocketsHttpHandler _handler;
    private readonly HttpClient _http;
    private readonly string _host;
    private readonly string? _token;
    private readonly string? _expectedPin;
    private volatile string? _observedPin;
    private volatile bool _pinMismatch;

    public DirigeraClient(string host, string? token = null, string? certPin = null)
    {
        _host = host;
        _token = token;
        _expectedPin = certPin;
        _handler = HueClient.CreateHandler(ValidateCertificate);
        // The hub closes idle connections after about five seconds; don't reuse one that may already be gone.
        _handler.PooledConnectionIdleTimeout = TimeSpan.FromSeconds(3);
        _http = new HttpClient(_handler, disposeHandler: false)
        {
            BaseAddress = new Uri($"https://{HostForUri(host)}:{Port}/v1/"),
            Timeout = Timeout.InfiniteTimeSpan, // per-call timeouts use tokens
        };
        if (token is not null)
            _http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
    }

    public static DirigeraClient ForSystem(Config.SystemConfig system) => new(system.Address, system.Credential, system.CertPin);

    /// <summary>The public key the hub presented on the last TLS handshake (null before the first one).</summary>
    public string? ObservedCertPin => _observedPin;

    public void ThrowIfCertificateChanged()
    {
        if (_pinMismatch && _observedPin is { } presented)
            throw new CertificateChangedException(presented);
    }

    private bool ValidateCertificate(X509Certificate? certificate)
    {
        if (certificate is null) return false;
        string pin;
        if (certificate is X509Certificate2 cert2)
        {
            pin = HueClient.PinOf(cert2);
        }
        else
        {
            using var copy = new X509Certificate2(certificate);
            pin = HueClient.PinOf(copy);
        }
        _observedPin = pin;
        if (_expectedPin is null || string.Equals(pin, _expectedPin, StringComparison.Ordinal)) return true;
        _pinMismatch = true;
        return false;
    }

    // ---------- pairing ----------

    /// <summary>A random PKCE code verifier (RFC 7636: 43–128 characters from the unreserved set).</summary>
    public static string NewCodeVerifier()
    {
        const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
        return RandomNumberGenerator.GetString(alphabet, 128);
    }

    private static string CodeChallenge(string verifier) =>
        Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>
    /// Starts pairing. The returned code can be exchanged for a token with <see cref="TryGetTokenAsync"/> once the
    /// action button on the bottom of the hub has been pressed.
    /// </summary>
    public async Task<string> AuthorizeAsync(string verifier, CancellationToken ct)
    {
        using var timeout = WithTimeout(ct, TimeSpan.FromSeconds(10));
        var url = "oauth/authorize?audience=homesmart.local&response_type=code&code_challenge_method=S256" +
                  $"&code_challenge={Uri.EscapeDataString(CodeChallenge(verifier))}";
        using var response = await _http.GetAsync(url, timeout.Token);
        var text = await response.Content.ReadAsStringAsync(timeout.Token);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"The hub answered HTTP {(int)response.StatusCode}.");
        return Json.Str(ParseObject(text)?["code"]) ?? throw new HttpRequestException("The hub did not return a pairing code.");
    }

    /// <summary>
    /// Exchanges the pairing code for a token. Returns null while the action button has not been pressed
    /// (the hub refuses the exchange until then).
    /// </summary>
    public async Task<string?> TryGetTokenAsync(string code, string verifier, string name, CancellationToken ct)
    {
        using var timeout = WithTimeout(ct, TimeSpan.FromSeconds(10));
        var body = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["code"] = code,
            ["name"] = name,
            ["grant_type"] = "authorization_code",
            ["code_verifier"] = verifier,
        });
        using var response = await _http.PostAsync("oauth/token", body, timeout.Token);
        var text = await response.Content.ReadAsStringAsync(timeout.Token);
        if ((int)response.StatusCode is >= 400 and < 500) return null;
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"The hub answered HTTP {(int)response.StatusCode}.");
        return Json.Str(ParseObject(text)?["access_token"]);
    }

    // ---------- resources ----------

    public async Task<JsonArray> GetDevicesAsync(CancellationToken ct) => await GetArrayAsync("devices", ct) ?? [];

    /// <summary>Rooms, or null when this firmware does not expose them separately.</summary>
    public Task<JsonArray?> GetRoomsAsync(CancellationToken ct) => GetArrayAsync("rooms", ct, optional: true);

    /// <summary>Scenes, or null when not available.</summary>
    public Task<JsonArray?> GetScenesAsync(CancellationToken ct) => GetArrayAsync("scenes", ct, optional: true);

    private async Task<JsonArray?> GetArrayAsync(string path, CancellationToken ct, bool optional = false)
    {
        using var timeout = WithTimeout(ct, TimeSpan.FromSeconds(20));
        using var response = await _http.GetAsync(path, timeout.Token);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new UnauthorizedAccessException("The hub rejected HubWatch's token. Remove the hub in Settings and add it again.");
        if (optional && response.StatusCode == HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        return JsonNode.Parse(await response.Content.ReadAsStringAsync(timeout.Token)) as JsonArray;
    }

    /// <summary>Sets attributes of a device, e.g. {"isOn": true} → PATCH /devices/{id} with [{"attributes": {...}}].</summary>
    public async Task SetAttributesAsync(string deviceId, JsonObject attributes, CancellationToken ct)
    {
        using var timeout = WithTimeout(ct, TimeSpan.FromSeconds(10));
        var body = new JsonArray(new JsonObject { ["attributes"] = attributes });
        using var request = new HttpRequestMessage(HttpMethod.Patch, $"devices/{Uri.EscapeDataString(deviceId)}")
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        using var response = await _http.SendAsync(request, timeout.Token);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new UnauthorizedAccessException("The hub rejected HubWatch's token. Remove the hub in Settings and add it again.");
        if (!response.IsSuccessStatusCode)
        {
            var text = await response.Content.ReadAsStringAsync(timeout.Token);
            var message = Json.Str(ParseObject(text)?["error"]) ?? Json.Str(ParseObject(text)?["message"]);
            throw new DirigeraCommandException(message ?? $"The hub answered HTTP {(int)response.StatusCode}.");
        }
    }

    // ---------- events ----------

    /// <summary>
    /// Connects to the event websocket and yields each message: { id, time, type, data: { id, type, deviceType,
    /// attributes, ... } }. Ends when the hub closes the connection (it does so now and then, "due to inactivity").
    /// </summary>
    public async IAsyncEnumerable<JsonObject> StreamEventsAsync(Action onConnected, [EnumeratorCancellation] CancellationToken ct)
    {
        using var ws = new ClientWebSocket();
        ws.Options.CollectHttpResponseDetails = true;
        ws.Options.SetRequestHeader("Authorization", $"Bearer {_token}");
        // Ping the hub regularly so a dead connection is noticed and the hub sees activity.
        ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        ws.Options.KeepAliveTimeout = TimeSpan.FromSeconds(15);

        using var invoker = new HttpMessageInvoker(_handler, disposeHandler: false);
        try
        {
            using var timeout = WithTimeout(ct, TimeSpan.FromSeconds(15));
            await ws.ConnectAsync(new Uri($"wss://{HostForUri(_host)}:{Port}/v1"), invoker, timeout.Token);
        }
        catch (WebSocketException) when (ws.HttpStatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new UnauthorizedAccessException("The hub rejected HubWatch's token. Remove the hub in Settings and add it again.");
        }
        onConnected();

        var buffer = new byte[16 * 1024];
        using var message = new MemoryStream();
        while (true)
        {
            var result = await ws.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                try
                {
                    using var closing = WithTimeout(ct, TimeSpan.FromSeconds(2));
                    await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, closing.Token);
                }
                catch (Exception) when (!ct.IsCancellationRequested) { }
                yield break;
            }

            message.Write(buffer, 0, result.Count);
            if (!result.EndOfMessage) continue;

            var text = Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
            message.SetLength(0);
            if (result.MessageType == WebSocketMessageType.Text && ParseObject(text) is { } parsed)
                yield return parsed;
        }
    }

    private static JsonObject? ParseObject(string text)
    {
        try { return JsonNode.Parse(text) as JsonObject; }
        catch (System.Text.Json.JsonException) { return null; }
    }

    private static string HostForUri(string host) =>
        IPAddress.TryParse(host, out var ip) && ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 ? $"[{host}]" : host;

    private static CancellationTokenSource WithTimeout(CancellationToken ct, TimeSpan after)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(after);
        return cts;
    }

    public void Dispose()
    {
        _http.Dispose();
        _handler.Dispose();
    }
}
