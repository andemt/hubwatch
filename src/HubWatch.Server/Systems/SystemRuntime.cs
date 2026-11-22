using HubWatch.Config;

namespace HubWatch.Systems;

/// <summary>Offline: gave up reconnecting and waits until the user asks to try again.</summary>
public enum SystemState { Connecting, Connected, Reconnecting, Offline, Error }

/// <summary>
/// The system presented a different TLS key than the pinned one. Either it really got a new certificate (rare:
/// a firmware change or a reset) or something on the network is pretending to be it. Nothing is sent to it until
/// the user decides to trust the new key.
/// </summary>
public sealed class CertificateChangedException(string presentedPin)
    : Exception("Its security certificate has changed. HubWatch stopped talking to it to protect its key.")
{
    public string PresentedPin { get; } = presentedPin;
}

public sealed record SystemStatusDto(
    string Id,
    string Kind,
    string? Name,
    string Address,
    string? NativeId,
    string State,
    string? Message,
    long? ConnectedSince,
    long? LastEventAt,
    bool CertificatePinned,
    string? Problem, // machine-readable reason for the Error state, e.g. "certificate_changed"
    long? ResourcesAsOf); // when not connected: when its devices etc. were last seen live (they are the last known state)

/// <summary>One connected system while HubWatch runs: its configuration, live resources and connection state.</summary>
public sealed class SystemRuntime
{
    private readonly Action _changed;
    private readonly Lock _lock = new();
    private SystemState _state = SystemState.Connecting;
    private string? _message;
    private long? _connectedSince;
    private long? _lastEventAt;
    private SystemConfig _config;
    private string? _problem;
    private string? _offeredCertPin;
    private long? _resourcesAsOf;
    private TaskCompletionSource _retry = new(TaskCreationOptions.RunContinuationsAsynchronously);

    internal SystemRuntime(SystemConfig config, ISystemResources resources, Action changed)
    {
        _config = config;
        Resources = resources;
        _changed = changed;
    }

    public SystemConfig Config
    {
        get { lock (_lock) return _config; }
    }

    /// <summary>
    /// Updates the configuration without restarting the collector, for changes the collector made itself
    /// (pinning the certificate on first use). The caller saves the same config to the ConfigStore.
    /// </summary>
    internal void ReplaceConfig(SystemConfig config)
    {
        lock (_lock) _config = config;
        _changed();
    }

    /// <summary>The key presented when the certificate check failed; the user can choose to trust it.</summary>
    public string? OfferedCertPin
    {
        get { lock (_lock) return _offeredCertPin; }
    }

    public void SetCertificateChanged(string presentedPin, string message)
    {
        lock (_lock)
        {
            _state = SystemState.Error;
            _message = message;
            _problem = "certificate_changed";
            _offeredCertPin = presentedPin;
            _connectedSince = null;
        }
        _changed();
    }
    public string Id => Config.Id;
    public string Kind => Config.Kind;
    public string DisplayName => Config.Name ?? Config.Address;
    public ISystemResources Resources { get; }

    public SystemState State
    {
        get { lock (_lock) return _state; }
    }

    public void SetState(SystemState state, string? message = null)
    {
        lock (_lock)
        {
            _state = state;
            _message = message;
            _problem = null;
            // Kept while reconnecting so the user can still trust it; gone once it connects.
            if (state == SystemState.Connected) _offeredCertPin = null;
            _connectedSince = state == SystemState.Connected ? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() : null;
        }
        _changed();
    }

    /// <summary>
    /// Completes when the user asks to try again. Take it before setting <see cref="SystemState.Offline"/>,
    /// so a request that arrives in between is not missed.
    /// </summary>
    internal Task RetryRequested
    {
        get { lock (_lock) return _retry.Task; }
    }

    private CancellationTokenSource _stop = new();

    /// <summary>Cancelled when the user stops the connection attempts; renewed by <see cref="ResetStop"/>.</summary>
    internal CancellationToken StopToken
    {
        get { lock (_lock) return _stop.Token; }
    }

    /// <summary>Stops trying to connect (states Connecting and Reconnecting); the collector goes offline. Returns false otherwise.</summary>
    public bool RequestStop()
    {
        CancellationTokenSource stop;
        lock (_lock)
        {
            if (_state is not (SystemState.Connecting or SystemState.Reconnecting)) return false;
            stop = _stop;
        }
        stop.Cancel();
        return true;
    }

    /// <summary>Arms Stop again; called by the collector once it has gone offline.</summary>
    internal void ResetStop()
    {
        lock (_lock)
        {
            // Not disposed: the collector's linked attempt token may still be registered on it.
            if (_stop.IsCancellationRequested) _stop = new CancellationTokenSource();
        }
    }

    /// <summary>Wakes a collector that gave up (state Offline). Returns false if it is not offline.</summary>
    public bool RequestRetry()
    {
        TaskCompletionSource requested;
        lock (_lock)
        {
            if (_state != SystemState.Offline) return false;
            requested = _retry;
            _retry = new(TaskCreationOptions.RunContinuationsAsynchronously);
        }
        requested.TrySetResult();
        return true;
    }

    /// <summary>When the resources were last seen live (saved or restored); shown while not connected.</summary>
    internal void SetResourcesAsOf(long ts)
    {
        lock (_lock) _resourcesAsOf = ts;
        _changed();
    }

    public void TouchEvent(long ts)
    {
        lock (_lock) _lastEventAt = ts;
    }

    public SystemStatusDto Snapshot()
    {
        lock (_lock)
        {
            var state = _state.ToString();
            return new SystemStatusDto(
                _config.Id, _config.Kind, _config.Name, _config.Address, _config.NativeId,
                char.ToLowerInvariant(state[0]) + state[1..], _message, _connectedSince, _lastEventAt,
                _config.CertPin is not null, _problem, _state == SystemState.Connected ? null : _resourcesAsOf);
        }
    }
}
