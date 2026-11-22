using HubWatch.Realtime;

namespace HubWatch.Systems;

public sealed record StatusDto(string Version, List<SystemStatusDto> Systems);

/// <summary>The systems HubWatch is currently connected to (or trying to connect to), in configuration order.</summary>
public sealed class SystemRegistry(EventBroadcaster broadcaster)
{
    private static readonly string Version =
        typeof(SystemRegistry).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    private volatile IReadOnlyList<SystemRuntime> _all = [];

    public IReadOnlyList<SystemRuntime> All => _all;

    /// <summary>Ids of all connected systems: the default set for queries.</summary>
    public IReadOnlyList<string> Ids => [.. _all.Select(s => s.Id)];

    public SystemRuntime? Get(string id) => _all.FirstOrDefault(s => s.Id == id);

    public SystemRuntime? FindByDevice(string deviceId) => _all.FirstOrDefault(s => s.Resources.HasDevice(deviceId));

    internal void Set(IReadOnlyList<SystemRuntime> systems)
    {
        _all = systems;
        PublishStatus();
    }

    public StatusDto Status() => new(Version, [.. _all.Select(s => s.Snapshot())]);

    public void PublishStatus() => broadcaster.Publish("status", Status());
}
