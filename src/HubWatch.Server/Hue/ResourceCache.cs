using System.Text.Json.Nodes;
using HubWatch.Systems;
using static HubWatch.Hue.Json;

namespace HubWatch.Hue;

/// <summary>
/// In-memory copy of all resources of one Hue bridge, kept current by applying event-stream updates.
/// Provides the vendor-neutral view of the bridge's devices, rooms and automations.
/// </summary>
public sealed class ResourceCache(string systemId) : ISystemResources
{
    // Hue resource types that are bridge plumbing rather than something a person recognises.
    private static readonly HashSet<string> Plumbing =
    [
        "zigbee_connectivity", "device_software_update", "device", "homekit", "matter", "bridge", "bridge_home",
        "entertainment", "geolocation", "zigbee_device_discovery", "clip", "motion_area_candidate",
        "behavior_instance", "behavior_script",
    ];

    private readonly Lock _lock = new();
    private Dictionary<string, JsonObject> _byId = new();

    public bool IsLoaded { get; private set; }

    public void Load(JsonArray data)
    {
        var map = new Dictionary<string, JsonObject>();
        foreach (var node in data)
            if (node is JsonObject obj && Str(obj["id"]) is { } id)
                map[id] = (JsonObject)obj.DeepClone();

        lock (_lock)
        {
            _byId = map;
            IsLoaded = true;
        }
    }

    public JsonNode Export()
    {
        lock (_lock) return new JsonArray([.. _byId.Values.Select(r => r.DeepClone())]);
    }

    public void Restore(JsonNode data)
    {
        if (data is JsonArray resources) Load(resources);
    }

    /// <summary>Applies one item from an event envelope and returns the merged resource (or null if deleted/unknown).</summary>
    public JsonObject? Apply(string eventType, JsonObject item)
    {
        if (Str(item["id"]) is not { } id) return null;

        lock (_lock)
        {
            switch (eventType)
            {
                case "delete":
                    _byId.Remove(id);
                    return null;
                case "add":
                    var added = (JsonObject)item.DeepClone();
                    _byId[id] = added;
                    return added;
                default:
                    if (_byId.TryGetValue(id, out var existing))
                    {
                        Merge(existing, item);
                        return existing;
                    }
                    var created = (JsonObject)item.DeepClone();
                    _byId[id] = created;
                    return created;
            }
        }
    }

    /// <summary>Human-friendly name and room for any resource id.</summary>
    public (string? Name, string? Room) Describe(string id)
    {
        lock (_lock)
        {
            if (!_byId.TryGetValue(id, out var resource)) return (null, null);

            var type = Str(resource["type"]);
            var ownerId = Str(resource["owner"]?["rid"]);
            var ownerType = Str(resource["owner"]?["rtype"]);
            _byId.TryGetValue(ownerId ?? "", out var owner);

            var name = Str(resource["metadata"]?["name"]) ?? Str(owner?["metadata"]?["name"]);

            // grouped_light, grouped_motion, grouped_light_level, ... aggregate a room, zone or the whole home
            if (type?.StartsWith("grouped_", StringComparison.Ordinal) == true)
                return (Str(owner?["metadata"]?["name"]) ?? (ownerType == "bridge_home" ? "Whole home" : null), null);

            var deviceId = type == "device" ? id : ownerType == "device" ? ownerId : null;
            return (name, deviceId is null ? null : RoomOf(deviceId));
        }
    }

    public List<DeviceDto> GetDevices()
    {
        lock (_lock)
        {
            var result = new List<DeviceDto>();
            foreach (var device in _byId.Values.Where(r => Str(r["type"]) == "device"))
            {
                var id = Str(device["id"])!;
                var services = (device["services"] as JsonArray ?? [])
                    .Select(s => Str(s?["rid"]))
                    .OfType<string>()
                    .Select(rid => _byId.GetValueOrDefault(rid))
                    .OfType<JsonObject>()
                    .ToList();

                JsonObject? Service(string type) => services.FirstOrDefault(s => Str(s["type"]) == type);

                var light = Service("light");
                var motion = Service("motion");
                var power = Service("device_power");
                var temperature = Service("temperature");
                var lightLevel = Service("light_level");
                var contact = Service("contact");
                var zigbee = Service("zigbee_connectivity");
                var update = _byId.Values.FirstOrDefault(r =>
                    Str(r["type"]) == "device_software_update" && Str(r["owner"]?["rid"]) == id);

                result.Add(new DeviceDto(
                    SystemId: systemId,
                    Id: id,
                    Name: Str(device["metadata"]?["name"]) ?? "Unnamed device",
                    Room: RoomOf(id),
                    Archetype: Str(device["metadata"]?["archetype"]) ?? Str(device["product_data"]?["product_archetype"]),
                    Product: Str(device["product_data"]?["product_name"]),
                    Model: Str(device["product_data"]?["model_id"]),
                    Firmware: Str(device["product_data"]?["software_version"]),
                    Battery: Num(power?["power_state"]?["battery_level"]),
                    BatteryState: Str(power?["power_state"]?["battery_state"]),
                    Connectivity: Str(zigbee?["status"]),
                    On: Bool(light?["on"]?["on"]),
                    Brightness: Num(light?["dimming"]?["brightness"]),
                    Motion: Bool(motion?["motion"]?["motion_report"]?["motion"]) ?? Bool(motion?["motion"]?["motion"]),
                    MotionChangedAt: UnixMs(motion?["motion"]?["motion_report"]?["changed"]),
                    Temperature: Num(temperature?["temperature"]?["temperature_report"]?["temperature"])
                                 ?? Num(temperature?["temperature"]?["temperature"]),
                    Lux: EventInterpreter.ToLux(Num(lightLevel?["light"]?["light_level_report"]?["light_level"])
                                                ?? Num(lightLevel?["light"]?["light_level"])),
                    Contact: Str(contact?["contact_report"]?["state"]),
                    SoftwareUpdate: Str(update?["state"]),
                    Kinds: services.Select(s => Str(s["type"])).OfType<string>().Distinct().ToArray(),
                    Services: new DeviceServiceIds(
                        Str(light?["id"]), Str(motion?["id"]), Str(temperature?["id"]), Str(lightLevel?["id"]),
                        Str(power?["id"]), Str(zigbee?["id"]), Str(contact?["id"]))));
            }

            return result.OrderBy(d => d.Room ?? "￿").ThenBy(d => d.Name).ToList();
        }
    }

    /// <summary>The device itself plus every resource it owns (its services).</summary>
    public List<string> ResourceIdsOfDevice(string deviceId)
    {
        lock (_lock)
        {
            var ids = new List<string> { deviceId };
            ids.AddRange(_byId.Values
                .Where(r => Str(r["owner"]?["rid"]) == deviceId)
                .Select(r => Str(r["id"]))
                .OfType<string>());
            return ids;
        }
    }

    /// <summary>The device that owns a service resource, if any.</summary>
    public string? OwnerOf(string id)
    {
        lock (_lock)
            return _byId.TryGetValue(id, out var r) && Str(r["owner"]?["rtype"]) == "device" ? Str(r["owner"]?["rid"]) : null;
    }

    public bool HasDevice(string deviceId)
    {
        lock (_lock) return _byId.TryGetValue(deviceId, out var r) && Str(r["type"]) == "device";
    }

    public List<string> LightIds()
    {
        lock (_lock)
            return [.. _byId.Values.Where(r => Str(r["type"]) == "light").Select(r => Str(r["id"])).OfType<string>()];
    }

    /// <summary>
    /// What to change to switch <paramref name="id"/> on or off: a light (itself, or a device's light) or the
    /// grouped_light of a room or zone. <c>Affected</c> lists every resource expected to report the change.
    /// Null when the id is unknown or has nothing to switch.
    /// </summary>
    public (string Type, string Id, List<string> Affected)? PowerTarget(string id)
    {
        lock (_lock)
        {
            if (!_byId.TryGetValue(id, out var r)) return null;

            List<string> ServicesOf(JsonObject owner, string rtype) => [.. (owner["services"] as JsonArray ?? [])
                .Where(s => Str(s?["rtype"]) == rtype)
                .Select(s => Str(s?["rid"]))
                .OfType<string>()
                .Where(_byId.ContainsKey)];

            switch (Str(r["type"]))
            {
                case "light":
                    return ("light", id, [id]);

                case "device":
                    var lights = ServicesOf(r, "light");
                    return lights.Count == 0 ? null : ("light", lights[0], lights);

                case "room" or "zone":
                    var grouped = ServicesOf(r, "grouped_light");
                    if (grouped.Count == 0) return null;
                    // Rooms list devices, zones list light services directly.
                    var affected = new List<string>(grouped);
                    foreach (var child in r["children"] as JsonArray ?? [])
                    {
                        var rid = Str(child?["rid"]);
                        if (rid is null || !_byId.TryGetValue(rid, out var c)) continue;
                        if (Str(c["type"]) == "light") affected.Add(rid);
                        else if (Str(c["type"]) == "device") affected.AddRange(ServicesOf(c, "light"));
                    }
                    return ("grouped_light", grouped[0], affected);

                case "grouped_light":
                    return ("grouped_light", id, [id]);

                default:
                    return null;
            }
        }
    }

    public bool IsUserFacing(string resourceType) => !Plumbing.Contains(resourceType);

    public List<GroupDto> GetGroups()
    {
        lock (_lock) return GroupsAndAutomations.BuildGroups(systemId, _byId);
    }

    public List<AutomationDto> GetAutomations()
    {
        lock (_lock) return GroupsAndAutomations.BuildAutomations(systemId, _byId);
    }

    /// <summary>Maps v1 paths like "/sensors/2" or "/scenes/abc" to friendly names, for v1 rules and schedules.</summary>
    public Dictionary<string, string> NamesByV1Id()
    {
        lock (_lock)
        {
            var map = new Dictionary<string, string>();
            foreach (var r in _byId.Values)
            {
                if (Str(r["id_v1"]) is not { Length: > 0 } v1 || Str(r["id"]) is not { } id) continue;
                if (GroupsAndAutomations.NameOf(id, _byId) is { } name)
                    map.TryAdd(v1, Str(r["type"]) is "room" or "zone" or "grouped_light" ? $"{name}" : name);
            }
            return map;
        }
    }

    public List<JsonObject> Raw()
    {
        lock (_lock) return _byId.Values.Select(v => (JsonObject)v.DeepClone()).ToList();
    }

    // Must be called with _lock held.
    private string? RoomOf(string deviceId)
    {
        foreach (var r in _byId.Values)
        {
            if (Str(r["type"]) != "room") continue;
            if (r["children"] is JsonArray children && children.Any(c => Str(c?["rid"]) == deviceId))
                return Str(r["metadata"]?["name"]);
        }
        return null;
    }

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
