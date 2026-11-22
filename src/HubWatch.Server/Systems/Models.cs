namespace HubWatch.Systems;

// Vendor-neutral shapes shared by every kind of system. Adapters translate their own data into these.
// Every top-level DTO carries the id of the system it came from.

public sealed record DeviceDto(
    string SystemId,
    string Id,
    string Name,
    string? Room,
    string? Archetype,
    string? Product,
    string? Model,
    string? Firmware,
    double? Battery,
    string? BatteryState,
    /// <summary>"connected" when the device is reachable; anything else means its state is only last known.</summary>
    string? Connectivity,
    bool? On,
    double? Brightness,
    bool? Motion,
    long? MotionChangedAt,
    double? Temperature,
    double? Lux,
    string? Contact,
    string? SoftwareUpdate,
    string[] Kinds,
    DeviceServiceIds Services);

/// <summary>Resource ids of a device's services, used to query readings and events.</summary>
public sealed record DeviceServiceIds(
    string? Light,
    string? Motion,
    string? Temperature,
    string? LightLevel,
    string? Power,
    string? Connectivity,
    string? Contact);

/// <summary>A light color: CIE xy, or white as mirek (color temperature).</summary>
public sealed record LightColor(double? X, double? Y, double? Mirek, double? Brightness);

/// <summary>A device in a room or zone that is not a light (sensor, switch, …).</summary>
public sealed record GroupDeviceDto(string Id, string Name, string? Product);

public sealed record GroupLightDto(string Id, string? DeviceId, string Name, bool? On, double? Brightness, LightColor? Color, string? Connectivity);

public sealed record SceneDto(
    string Id,
    string Name,
    bool Smart,
    string? Active,
    long? LastRecall,
    double? Speed,
    bool? AutoDynamic,
    LightColor[] Palette);

/// <summary>A room or a zone.</summary>
public sealed record GroupDto(
    string SystemId,
    string Id,
    string Kind,
    string Name,
    string? Archetype,
    bool? On,
    double? Brightness,
    GroupLightDto[] Lights,
    GroupDeviceDto[] OtherDevices,
    SceneDto[] Scenes);

public sealed record NamedRef(string Id, string Type, string? Name);

public sealed record AutomationDto(
    string SystemId,
    string Id,
    string Name,
    bool Enabled,
    string? Script,
    string? ScriptDescription,
    string? Category,
    string? Status,
    string? LastError,
    string? When,
    /// <summary>Start time as minutes after local midnight, when it is a fixed clock time (for sorting).</summary>
    int? StartMinute,
    NamedRef[] Targets,
    string Configuration);
