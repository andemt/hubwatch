using System.Text.Json.Nodes;

namespace HubWatch.Systems;

/// <summary>
/// Everything HubWatch needs from one kind of system (Philips Hue today). An adapter connects to a
/// system, records its events in the database and keeps its <see cref="ISystemResources"/> current.
/// The rest of the app (API, alerts, statistics) only talks to these interfaces.
/// </summary>
public interface ISystemAdapter
{
    /// <summary>Matches <see cref="Config.SystemConfig.Kind"/>, e.g. "hue".</summary>
    string Kind { get; }

    ISystemResources CreateResources(string systemId);

    /// <summary>
    /// Connects and records until the connection ends (returns) or fails (throws). Call
    /// <paramref name="onConnected"/> once live events are flowing. The supervisor reconnects with back-off.
    /// Throw <see cref="UnauthorizedAccessException"/> when the stored credential is rejected.
    /// </summary>
    Task RunAsync(SystemRuntime system, Action onConnected, CancellationToken ct);
}

/// <summary>Live, vendor-neutral view of one system's devices, rooms and automations.</summary>
public interface ISystemResources
{
    bool IsLoaded { get; }

    List<DeviceDto> GetDevices();
    List<GroupDto> GetGroups();
    List<AutomationDto> GetAutomations();

    /// <summary>Human-friendly name and room for any resource id.</summary>
    (string? Name, string? Room) Describe(string id);

    /// <summary>The device that owns a service resource, if any.</summary>
    string? OwnerOf(string id);

    bool HasDevice(string deviceId);

    /// <summary>The device itself plus every resource it owns.</summary>
    List<string> ResourceIdsOfDevice(string deviceId);

    /// <summary>Resource ids whose "on" readings describe a light (for statistics).</summary>
    List<string> LightIds();

    /// <summary>Whether events of this resource type are something a person recognises (not system plumbing).</summary>
    bool IsUserFacing(string resourceType);

    /// <summary>The system's own raw resource data, for troubleshooting.</summary>
    List<JsonObject> Raw();

    /// <summary>Everything loaded, in a form <see cref="Restore"/> takes back (saved as the last known state).</summary>
    JsonNode Export();

    /// <summary>Loads a saved <see cref="Export"/> so the last known state can be shown while the system is unreachable.</summary>
    void Restore(JsonNode data);
}
