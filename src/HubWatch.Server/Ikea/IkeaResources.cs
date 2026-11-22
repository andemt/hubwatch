using System.Text.Json.Nodes;
using HubWatch.Hue;
using HubWatch.Systems;
using static HubWatch.Hue.Json;

namespace HubWatch.Ikea;

/// <summary>
/// In-memory copy of one DIRIGERA hub's devices, rooms and scenes, kept current from the event websocket.
/// Unlike Hue, a DIRIGERA device is a single resource: its state lives in <c>attributes</c>, so events, readings and
/// the device all use the device's own id.
/// </summary>
public sealed class IkeaResources(string systemId) : ISystemResources
{
    // Resource types (see IkeaEventInterpreter.ResourceTypeOf) that are hub plumbing rather than something a person recognises.
    private static readonly HashSet<string> Plumbing = ["zigbee_connectivity", "device_software_update", "gateway", "device"];

    private readonly Lock _lock = new();
    private Dictionary<string, JsonObject> _devices = new();
    private Dictionary<string, JsonObject> _rooms = new();
    private Dictionary<string, JsonObject> _scenes = new();

    public bool IsLoaded { get; private set; }

    public void Load(JsonArray devices, JsonArray? rooms, JsonArray? scenes)
    {
        static Dictionary<string, JsonObject> ById(JsonArray? list)
        {
            var map = new Dictionary<string, JsonObject>();
            foreach (var node in list ?? [])
                if (node is JsonObject obj && Str(obj["id"]) is { } id)
                    map[id] = (JsonObject)obj.DeepClone();
            return map;
        }

        var deviceMap = ById(devices);
        var roomMap = ById(rooms);
        // Older firmware may not list rooms separately; each device names its room.
        foreach (var device in deviceMap.Values)
            if (device["room"] is JsonObject room && Str(room["id"]) is { } roomId && !roomMap.ContainsKey(roomId))
                roomMap[roomId] = (JsonObject)room.DeepClone();

        lock (_lock)
        {
            _devices = deviceMap;
            _rooms = roomMap;
            _scenes = ById(scenes);
            IsLoaded = true;
        }
    }

    public JsonNode Export()
    {
        static JsonArray Copy(Dictionary<string, JsonObject> map) => new([.. map.Values.Select(o => o.DeepClone())]);
        lock (_lock)
            return new JsonObject { ["devices"] = Copy(_devices), ["rooms"] = Copy(_rooms), ["scenes"] = Copy(_scenes) };
    }

    public void Restore(JsonNode data)
    {
        if (data is JsonObject saved && saved["devices"] is JsonArray devices)
            Load(devices, saved["rooms"] as JsonArray, saved["scenes"] as JsonArray);
    }

    /// <summary>The hub itself (deviceType "gateway"), for its id and name.</summary>
    public JsonObject? Gateway()
    {
        lock (_lock) return _devices.Values.FirstOrDefault(d => Str(d["deviceType"]) == "gateway")?.DeepClone() as JsonObject;
    }

    /// <summary>A copy of a device as currently known, or null.</summary>
    public JsonObject? Device(string id)
    {
        lock (_lock) return _devices.GetValueOrDefault(id)?.DeepClone() as JsonObject;
    }

    /// <summary>
    /// Applies a device message from the event websocket and returns the device before and after the change
    /// (Before is null for a device not seen before; After is null when it was removed).
    /// </summary>
    public (JsonObject? Before, JsonObject? After) ApplyDevice(string messageType, JsonObject data)
    {
        if (Str(data["id"]) is not { } id) return (null, null);
        lock (_lock)
        {
            var before = _devices.GetValueOrDefault(id)?.DeepClone() as JsonObject;
            if (messageType == "deviceRemoved")
            {
                _devices.Remove(id);
                return (before, null);
            }

            if (_devices.TryGetValue(id, out var existing)) Merge(existing, data);
            else _devices[id] = existing = (JsonObject)data.DeepClone();

            if (existing["room"] is JsonObject room && Str(room["id"]) is { } roomId)
                _rooms[roomId] = (JsonObject)room.DeepClone();
            return (before, (JsonObject)existing.DeepClone());
        }
    }

    /// <summary>Applies a scene or room message (created, updated, deleted).</summary>
    public void ApplyOther(string messageType, JsonObject data)
    {
        if (Str(data["id"]) is not { } id) return;
        lock (_lock)
        {
            var map = messageType.StartsWith("scene", StringComparison.Ordinal) ? _scenes
                : messageType.StartsWith("room", StringComparison.Ordinal) ? _rooms
                : null;
            if (map is null) return;
            if (messageType.EndsWith("Deleted", StringComparison.Ordinal)) map.Remove(id);
            else if (map.TryGetValue(id, out var existing)) Merge(existing, data);
            else map[id] = (JsonObject)data.DeepClone();
        }
    }

    public string? SceneName(string id)
    {
        lock (_lock) return Str(_scenes.GetValueOrDefault(id)?["info"]?["name"]);
    }

    public (string? Name, string? Room) Describe(string id)
    {
        lock (_lock)
        {
            if (_devices.TryGetValue(id, out var device))
            {
                var members = GroupMembers(device);
                return (GroupName(members), GroupRoom(members));
            }
            if (_scenes.TryGetValue(id, out var scene)) return (Str(scene["info"]?["name"]), null);
            if (_rooms.TryGetValue(id, out var room)) return (Str(room["name"]), null);
            return (null, null);
        }
    }

    // Several logical devices can be one physical device - IKEA splits e.g. a motion sensor into an occupancy
    // sub-device and a light sub-device. They share a relationId, and the user usually renames only one of them
    // (IKEA pre-fills customName with the product name). HubWatch shows them as one device, under the user's name.
    private static string GroupKey(JsonObject device) =>
        Str(device["relationId"]) is { Length: > 0 } rel ? rel : Str(device["id"]) ?? "";

    // Must be called with _lock held.
    private List<JsonObject> GroupMembers(JsonObject device)
    {
        var key = GroupKey(device);
        return [.. _devices.Values.Where(d => GroupKey(d) == key)];
    }

    /// <summary>The name the user actually gave the physical device (not just the product name), if any.</summary>
    private static string? GroupName(List<JsonObject> members)
    {
        foreach (var m in members)
        {
            var a = m["attributes"] as JsonObject;
            if (Str(a?["customName"]) is { Length: > 0 } custom && custom != Str(a?["model"])) return custom;
        }
        return members.Count > 0 ? NameOf(members[0]) : null;
    }

    private string? GroupRoom(List<JsonObject> members) => members.Select(RoomOf).FirstOrDefault(r => r is not null);

    public List<DeviceDto> GetDevices()
    {
        lock (_lock)
        {
            var result = new List<DeviceDto>();
            var seen = new HashSet<string>();
            foreach (var device in _devices.Values)
            {
                if (Str(device["deviceType"]) == "gateway") continue; // the hub itself, not a device
                var key = GroupKey(device);
                if (!seen.Add(key)) continue; // one physical device, even when the hub splits it in two

                var members = _devices.Values
                    .Where(d => GroupKey(d) == key && Str(d["deviceType"]) != "gateway")
                    .OrderBy(d => Str(d["id"])).ToList();
                if (members.Count == 0) continue;

                JsonObject Attrs(JsonObject? m) => m?["attributes"] as JsonObject ?? [];
                JsonObject? MemberWith(string attr) => members.FirstOrDefault(m => Attrs(m).ContainsKey(attr));
                string? IdOf(JsonObject? m) => m is null ? null : Str(m["id"]);

                var lightM = members.FirstOrDefault(m => Str(m["deviceType"]) is "light" or "outlet") ?? MemberWith("isOn");
                var motionM = MemberWith("isDetected");
                var tempM = MemberWith("currentTemperature");
                var luxM = MemberWith("illuminance");
                var contactM = MemberWith("isOpen");
                var batteryM = MemberWith("batteryPercentage");

                // The device the user named carries identity; fall back to a light, then the first member.
                var primary = members.FirstOrDefault(m =>
                                  Str(Attrs(m)["customName"]) is { Length: > 0 } c && c != Str(Attrs(m)["model"]))
                              ?? lightM ?? members[0];
                var pa = Attrs(primary);
                var kinds = members.SelectMany(IkeaEventInterpreter.KindsOf).Distinct().ToArray();
                var hasReachable = members.Any(m => m.ContainsKey("isReachable"));
                var reachable = members.All(m => Bool(m["isReachable"]) != false);

                result.Add(new DeviceDto(
                    SystemId: systemId,
                    Id: Str(primary["id"])!,
                    Name: GroupName(members) ?? "Unnamed device",
                    Room: GroupRoom(members),
                    Archetype: Str(primary["deviceType"]),
                    Product: Str(pa["model"]),
                    Model: Str(pa["productCode"]) ?? Str(pa["model"]),
                    Firmware: Str(pa["firmwareVersion"]),
                    Battery: Num(Attrs(batteryM)["batteryPercentage"]),
                    BatteryState: null,
                    Connectivity: hasReachable ? (reachable ? "connected" : "disconnected") : null,
                    On: Bool(Attrs(lightM)["isOn"]),
                    Brightness: Num(Attrs(lightM)["lightLevel"]),
                    Motion: Bool(Attrs(motionM)["isDetected"]),
                    MotionChangedAt: null,
                    Temperature: Num(Attrs(tempM)["currentTemperature"]),
                    Lux: EventInterpreter.ToLux(Num(Attrs(luxM)["illuminance"])), // raw value is Zigbee-encoded, like Hue
                    Contact: Bool(Attrs(contactM)["isOpen"]) is { } open ? (open ? "no_contact" : "contact") : null,
                    SoftwareUpdate: SoftwareUpdate(Str(pa["otaStatus"])),
                    Kinds: kinds,
                    Services: new DeviceServiceIds(
                        kinds.Contains("light") ? IdOf(lightM) : null,
                        IdOf(motionM),
                        IdOf(tempM),
                        IdOf(luxM),
                        IdOf(batteryM),
                        Str(primary["id"]),
                        IdOf(contactM))));
            }
            return result.OrderBy(d => d.Room ?? "￿").ThenBy(d => d.Name).ToList();
        }
    }

    public List<GroupDto> GetGroups()
    {
        lock (_lock)
        {
            var result = new List<GroupDto>();
            foreach (var room in _rooms.Values)
            {
                if (Str(room["id"]) is not { } roomId) continue;
                var members = _devices.Values.Where(d => Str(d["room"]?["id"]) == roomId).ToList();
                var lights = members.Where(d => Str(d["deviceType"]) == "light").ToList();
                var lightDtos = lights.Select(d =>
                {
                    var a = d["attributes"] as JsonObject ?? [];
                    var kelvin = Num(a["colorTemperature"]);
                    var color = kelvin is > 0 ? new LightColor(null, null, Math.Round(1_000_000 / kelvin.Value), Num(a["lightLevel"])) : null;
                    return new GroupLightDto(Str(d["id"])!, Str(d["id"]), NameOf(d) ?? "Light", Bool(a["isOn"]),
                        Num(a["lightLevel"]), color, Connectivity(d));
                }).OrderBy(l => l.Name).ToArray();

                var on = lightDtos.Length == 0 ? (bool?)null : lightDtos.Any(l => l.On == true);
                var brightness = lightDtos.Where(l => l.On == true && l.Brightness is not null).Select(l => l.Brightness!.Value).ToList();

                result.Add(new GroupDto(
                    SystemId: systemId,
                    Id: roomId,
                    Kind: "room",
                    Name: Str(room["name"]) ?? "Room",
                    Archetype: Str(room["icon"]),
                    On: on,
                    Brightness: brightness.Count > 0 ? brightness.Average() : null,
                    Lights: lightDtos,
                    OtherDevices: [.. members.Except(lights)
                        .Select(d => new GroupDeviceDto(Str(d["id"])!, NameOf(d) ?? "Device", Str(d["attributes"]?["model"])))
                        .OrderBy(d => d.Name)],
                    Scenes: []));
            }
            return result.OrderBy(g => g.Name).ToList();
        }
    }

    /// <summary>Not mapped yet: DIRIGERA keeps schedules as scenes with triggers. Visible under Raw for now.</summary>
    public List<AutomationDto> GetAutomations() => [];

    public string? OwnerOf(string id)
    {
        lock (_lock) return _devices.ContainsKey(id) ? id : null;
    }

    public bool HasDevice(string deviceId)
    {
        lock (_lock) return _devices.ContainsKey(deviceId);
    }

    public List<string> ResourceIdsOfDevice(string deviceId)
    {
        lock (_lock)
            return _devices.TryGetValue(deviceId, out var device)
                ? [.. GroupMembers(device).Select(d => Str(d["id"])).OfType<string>()]
                : [deviceId];
    }

    public List<string> LightIds()
    {
        lock (_lock)
            return [.. _devices.Values.Where(d => Str(d["deviceType"]) == "light").Select(d => Str(d["id"])).OfType<string>()];
    }

    /// <summary>The lights to switch for a light or a room (empty when the id is unknown or has no lights).</summary>
    public List<string> LightsOf(string id)
    {
        lock (_lock)
        {
            if (_devices.TryGetValue(id, out var d))
                return Str(d["deviceType"]) == "light" || Bool(d["attributes"]?["isOn"]) is not null ? [id] : [];
            if (_rooms.ContainsKey(id))
                return [.. _devices.Values
                    .Where(x => Str(x["room"]?["id"]) == id && Str(x["deviceType"]) == "light")
                    .Select(x => Str(x["id"])).OfType<string>()];
            return [];
        }
    }

    public bool IsUserFacing(string resourceType) => !Plumbing.Contains(resourceType);

    public List<JsonObject> Raw()
    {
        lock (_lock)
            return [.. _devices.Values.Concat(_rooms.Values).Concat(_scenes.Values).Select(v => (JsonObject)v.DeepClone())];
    }

    public static string? NameOf(JsonObject device) =>
        Str(device["attributes"]?["customName"]) is { Length: > 0 } custom ? custom : Str(device["attributes"]?["model"]);

    /// <summary>"connected" when the hub can reach the device, in the same words as Hue's Zigbee status.</summary>
    public static string? Connectivity(JsonObject device) =>
        Bool(device["isReachable"]) is { } reachable ? (reachable ? "connected" : "disconnected") : null;

    /// <summary>Firmware update state in the words the UI knows from Hue.</summary>
    private static string? SoftwareUpdate(string? otaStatus) => otaStatus switch
    {
        null => null,
        "upToDate" => "no_update",
        "updateAvailable" => "update_pending",
        _ => otaStatus,
    };

    // Must be called with _lock held.
    private string? RoomOf(JsonObject device) =>
        Str(device["room"]?["id"]) is { } roomId && _rooms.TryGetValue(roomId, out var room)
            ? Str(room["name"])
            : Str(device["room"]?["name"]);

    private static void Merge(JsonObject target, JsonObject source)
    {
        foreach (var (key, value) in source)
        {
            if (value is JsonObject sourceChild && target[key] is JsonObject targetChild)
                Merge(targetChild, sourceChild);
            else
                target[key] = value?.DeepClone();
        }
    }
}
