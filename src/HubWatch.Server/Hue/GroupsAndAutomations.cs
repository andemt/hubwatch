using System.Text.Json.Nodes;
using HubWatch.Systems;
using static HubWatch.Hue.Json;

namespace HubWatch.Hue;

/// <summary>Builds room/zone/scene and automation views from the cached resources.</summary>
public static class GroupsAndAutomations
{
    public static List<GroupDto> BuildGroups(string systemId, IReadOnlyDictionary<string, JsonObject> byId)
    {
        var result = new List<GroupDto>();
        var scenesByGroup = byId.Values
            .Where(r => Str(r["type"]) is "scene" or "smart_scene")
            .GroupBy(r => Str(r["group"]?["rid"]) ?? "")
            .ToDictionary(g => g.Key, g => g.ToList());

        foreach (var group in byId.Values.Where(r => Str(r["type"]) is "room" or "zone"))
        {
            var id = Str(group["id"])!;
            var kind = Str(group["type"])!;
            var children = (group["children"] as JsonArray ?? [])
                .Select(c => (Rid: Str(c?["rid"]), Rtype: Str(c?["rtype"])))
                .Where(c => c.Rid is not null)
                .ToList();

            // Rooms list devices; zones list light services directly.
            var lights = new List<GroupLightDto>();
            var otherDevices = new List<GroupDeviceDto>();
            foreach (var (rid, rtype) in children)
            {
                if (!byId.TryGetValue(rid!, out var child)) continue;
                if (rtype == "light")
                {
                    lights.Add(LightDto(child, byId));
                }
                else if (rtype == "device")
                {
                    var deviceLights = (child["services"] as JsonArray ?? [])
                        .Where(s => Str(s?["rtype"]) == "light")
                        .Select(s => byId.GetValueOrDefault(Str(s?["rid"]) ?? ""))
                        .OfType<JsonObject>()
                        .ToList();
                    if (deviceLights.Count > 0) lights.AddRange(deviceLights.Select(l => LightDto(l, byId)));
                    else otherDevices.Add(new GroupDeviceDto(
                        Str(child["id"]) ?? rid!,
                        Str(child["metadata"]?["name"]) ?? "Device",
                        Str(child["product_data"]?["product_name"])));
                }
            }

            var groupedLight = (group["services"] as JsonArray ?? [])
                .Where(s => Str(s?["rtype"]) == "grouped_light")
                .Select(s => byId.GetValueOrDefault(Str(s?["rid"]) ?? ""))
                .FirstOrDefault(g => g is not null);

            var scenes = scenesByGroup.GetValueOrDefault(id, [])
                .Select(SceneDtoFrom)
                .OrderByDescending(s => s.Active is not null and not "inactive")
                .ThenBy(s => s.Name)
                .ToArray();

            result.Add(new GroupDto(
                systemId, id, kind,
                Str(group["metadata"]?["name"]) ?? kind,
                Str(group["metadata"]?["archetype"]),
                Bool(groupedLight?["on"]?["on"]),
                Num(groupedLight?["dimming"]?["brightness"]),
                [.. lights.OrderBy(l => l.Name)],
                [.. otherDevices.OrderBy(d => d.Name)],
                scenes));
        }

        return result.OrderBy(g => g.Kind == "zone").ThenBy(g => g.Name).ToList();
    }

    public static List<AutomationDto> BuildAutomations(string systemId, IReadOnlyDictionary<string, JsonObject> byId)
    {
        return byId.Values
            .Where(r => Str(r["type"]) == "behavior_instance")
            .Select(r =>
            {
                var script = byId.GetValueOrDefault(Str(r["script_id"]) ?? "");
                var targets = (r["dependees"] as JsonArray ?? [])
                    .Select(d => (Rid: Str(d?["target"]?["rid"]), Rtype: Str(d?["target"]?["rtype"])))
                    .Where(t => t.Rid is not null)
                    .Select(t => new NamedRef(t.Rid!, t.Rtype ?? "", NameOf(t.Rid!, byId)))
                    .DistinctBy(t => t.Id)
                    .ToArray();

                return new AutomationDto(
                    systemId,
                    Str(r["id"])!,
                    Str(r["metadata"]?["name"]) ?? Str(script?["metadata"]?["name"]) ?? "Automation",
                    Bool(r["enabled"]) ?? false,
                    Str(script?["metadata"]?["name"]),
                    Str(script?["description"]),
                    Str(script?["metadata"]?["category"]),
                    Str(r["status"]),
                    Str(r["last_error"]) is { Length: > 0 } e ? e : null,
                    DescribeWhen(r["configuration"]),
                    StartMinute(r["configuration"]),
                    targets,
                    r["configuration"]?.ToJsonString() ?? "{}");
            })
            .OrderByDescending(a => a.Enabled)
            .ThenBy(a => a.Name)
            .ToList();
    }

    /// <summary>Best-effort human summary of a behavior's "when" configuration, e.g. "06:30 · Mon–Fri".</summary>
    public static string? DescribeWhen(JsonNode? configuration)
    {
        var when = configuration?["when"] ?? configuration?["when_extended"]?["start_at"];
        var timePoint = when?["time_point"] ?? configuration?["when_extended"]?["start_at"]?["time_point"];
        if (timePoint is null) return null;

        string? time = Str(timePoint["type"]) switch
        {
            "time" => FormatTime(timePoint["time"]),
            "sunset" or "sunrise" => Offset(Str(timePoint["type"])!, Num(timePoint["offset"]?["minutes"])),
            var other => other,
        };

        var days = (when?["recurrence_days"] ?? configuration?["when_extended"]?["recurrence_days"]) as JsonArray;
        var dayText = days is null ? null : DescribeDays(days.Select(d => Str(d)).OfType<string>().ToList());
        return string.Join(" · ", new[] { time, dayText }.Where(s => s is not null));
    }

    /// <summary>A behavior's start as minutes after midnight, when it starts at a fixed clock time (not sunrise/sunset).</summary>
    public static int? StartMinute(JsonNode? configuration)
    {
        var timePoint = configuration?["when"]?["time_point"] ?? configuration?["when_extended"]?["start_at"]?["time_point"];
        if (Str(timePoint?["type"]) != "time") return null;
        var hour = Num(timePoint?["time"]?["hour"]);
        var minute = Num(timePoint?["time"]?["minute"]) ?? 0;
        return hour is null ? null : (int)hour.Value * 60 + (int)minute;
    }

    // ----- helpers -----

    public static string? NameOf(string id, IReadOnlyDictionary<string, JsonObject> byId)
    {
        if (!byId.TryGetValue(id, out var r)) return null;
        return Str(r["metadata"]?["name"])
               ?? Str(byId.GetValueOrDefault(Str(r["owner"]?["rid"]) ?? "")?["metadata"]?["name"]);
    }

    private static GroupLightDto LightDto(JsonObject light, IReadOnlyDictionary<string, JsonObject> byId)
    {
        var deviceId = Str(light["owner"]?["rid"]);
        var zigbee = (byId.GetValueOrDefault(deviceId ?? "")?["services"] as JsonArray ?? [])
            .Where(s => Str(s?["rtype"]) == "zigbee_connectivity")
            .Select(s => byId.GetValueOrDefault(Str(s?["rid"]) ?? ""))
            .FirstOrDefault(z => z is not null);
        return new GroupLightDto(
            Str(light["id"])!,
            deviceId,
            Str(light["metadata"]?["name"]) ?? NameOf(deviceId ?? "", byId) ?? "Light",
            Bool(light["on"]?["on"]),
            Num(light["dimming"]?["brightness"]),
            ColorOf(light),
            Str(zigbee?["status"]));
    }

    private static SceneDto SceneDtoFrom(JsonObject scene)
    {
        var smart = Str(scene["type"]) == "smart_scene";
        var palette = new List<LightColor>();

        var paletteNode = scene["palette"];
        foreach (var c in paletteNode?["color"] as JsonArray ?? [])
            palette.Add(new LightColor(Num(c?["color"]?["xy"]?["x"]), Num(c?["color"]?["xy"]?["y"]), null, Num(c?["dimming"]?["brightness"])));
        foreach (var c in paletteNode?["color_temperature"] as JsonArray ?? [])
            palette.Add(new LightColor(null, null, Num(c?["color_temperature"]?["mirek"]), Num(c?["dimming"]?["brightness"])));

        // Without a palette, use the colors the scene sets on each light.
        if (palette.Count == 0)
            foreach (var a in scene["actions"] as JsonArray ?? [])
                if (a?["action"] is JsonObject action && ColorOf(action) is { } color && Bool(action["on"]?["on"]) != false)
                    palette.Add(color);

        return new SceneDto(
            Str(scene["id"])!,
            Str(scene["metadata"]?["name"]) ?? "Scene",
            smart,
            smart ? Str(scene["state"]) : Str(scene["status"]?["active"]),
            UnixMs(scene["status"]?["last_recall"]),
            Num(scene["speed"]),
            Bool(scene["auto_dynamic"]),
            [.. palette.Take(8)]);
    }

    private static LightColor? ColorOf(JsonObject lightOrAction)
    {
        var brightness = Num(lightOrAction["dimming"]?["brightness"]);
        var mirek = Num(lightOrAction["color_temperature"]?["mirek"]);
        var mirekValid = Bool(lightOrAction["color_temperature"]?["mirek_valid"]) ?? true;
        if (mirek is not null && mirekValid) return new LightColor(null, null, mirek, brightness);
        var x = Num(lightOrAction["color"]?["xy"]?["x"]);
        var y = Num(lightOrAction["color"]?["xy"]?["y"]);
        if (x is not null && y is not null) return new LightColor(x, y, null, brightness);
        return brightness is null ? null : new LightColor(null, null, 366, brightness); // plain dimmable: warm white
    }

    private static string? FormatTime(JsonNode? time) =>
        Num(time?["hour"]) is { } h ? $"{h:00}:{Num(time?["minute"]) ?? 0:00}" : null;

    private static string Offset(string kind, double? minutes) => minutes switch
    {
        null or 0 => $"At {kind}",
        > 0 => $"{minutes:0} min after {kind}",
        _ => $"{-minutes:0} min before {kind}",
    };

    private static readonly string[] Week = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

    private static string DescribeDays(List<string> days)
    {
        var set = days.ToHashSet();
        if (set.Count == 7) return "Every day";
        if (set.SetEquals(Week[..5])) return "Mon–Fri";
        if (set.SetEquals(Week[5..])) return "Weekends";
        return string.Join(", ", Week.Where(set.Contains).Select(d => char.ToUpperInvariant(d[0]) + d[1..3]));
    }
}
