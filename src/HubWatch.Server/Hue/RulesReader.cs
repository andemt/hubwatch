using System.Text.Json.Nodes;
using static HubWatch.Hue.Json;

namespace HubWatch.Hue;

public sealed record RuleConditionDto(string Address, string? Target, string Attribute, string Operator, string? Value);

public sealed record RuleActionDto(string Address, string? Target, string Method, string Body);

public sealed record RuleDto(
    string SystemId,
    string Id,
    string Name,
    string? Status,
    long? LastTriggered,
    int TimesTriggered,
    RuleConditionDto[] Conditions,
    RuleActionDto[] Actions);

public sealed record ScheduleDto(
    string SystemId,
    string Id,
    string Name,
    string? Description,
    string? Status,
    string? When,
    RuleActionDto? Command);

/// <param name="Errors">Systems whose rules could not be read, with the reason.</param>
public sealed record RulesResponse(List<RuleDto> Rules, List<ScheduleDto> Schedules, List<string> Errors);

/// <summary>Reads v1 rules and schedules and resolves the addresses they use to friendly names.</summary>
public static class RulesReader
{
    public static async Task<(List<RuleDto> Rules, List<ScheduleDto> Schedules)> ReadAsync(string systemId, HueClient client,
        Dictionary<string, string> names, CancellationToken ct)
    {
        var rulesTask = client.GetV1Async("rules", ct);
        var schedulesTask = client.GetV1Async("schedules", ct);
        var rules = await rulesTask;
        var schedules = await schedulesTask;

        // Add names for v1-only things referenced by rules (sensors such as CLIP/virtual sensors).
        names = new Dictionary<string, string>(names);

        var ruleList = rules
            .Where(p => p.Value is JsonObject)
            .Select(p =>
            {
                var r = (JsonObject)p.Value!;
                return new RuleDto(
                    systemId,
                    p.Key,
                    Str(r["name"]) ?? $"Rule {p.Key}",
                    Str(r["status"]),
                    ParseV1Time(Str(r["lasttriggered"])),
                    (int)(Num(r["timestriggered"]) ?? 0),
                    [.. (r["conditions"] as JsonArray ?? []).OfType<JsonObject>().Select(c => Condition(c, names))],
                    [.. (r["actions"] as JsonArray ?? []).OfType<JsonObject>().Select(a => Action(a, names))]);
            })
            .OrderByDescending(r => r.LastTriggered ?? 0)
            .ToList();

        var scheduleList = schedules
            .Where(p => p.Value is JsonObject)
            .Select(p =>
            {
                var s = (JsonObject)p.Value!;
                return new ScheduleDto(
                    systemId,
                    p.Key,
                    Str(s["name"]) ?? $"Schedule {p.Key}",
                    Str(s["description"]),
                    Str(s["status"]),
                    DescribeLocalTime(Str(s["localtime"]) ?? Str(s["time"])),
                    s["command"] is JsonObject cmd ? Action(cmd, names) : null);
            })
            .OrderBy(s => s.Name)
            .ToList();

        return (ruleList, scheduleList);
    }

    private static RuleConditionDto Condition(JsonObject c, Dictionary<string, string> names)
    {
        var address = Str(c["address"]) ?? "";
        var (target, rest) = Resolve(address, names);
        var op = Str(c["operator"]) ?? "";
        return new RuleConditionDto(address, target, rest, op, Str(c["value"]));
    }

    private static RuleActionDto Action(JsonObject a, Dictionary<string, string> names)
    {
        var address = Str(a["address"]) ?? "";
        var (target, _) = Resolve(address, names);

        // Show scene names instead of ids where possible.
        var body = a["body"]?.DeepClone() as JsonObject ?? [];
        if (Str(body["scene"]) is { } sceneId && names.TryGetValue($"/scenes/{sceneId}", out var sceneName))
            body["scene"] = sceneName;

        return new RuleActionDto(address, target, Str(a["method"]) ?? "PUT", body.ToJsonString());
    }

    /// <summary>"/sensors/2/state/presence" → ("Hallway sensor", "state/presence").</summary>
    private static (string? Target, string Path) Resolve(string address, Dictionary<string, string> names)
    {
        var parts = address.Trim('/').Split('/');
        if (parts.Length >= 2)
        {
            var key = $"/{parts[0]}/{parts[1]}";
            var rest = string.Join('/', parts.Skip(2));
            if (names.TryGetValue(key, out var name)) return (name, rest);
            if (parts[0] == "groups" && parts[1] == "0") return ("All lights", rest);
            return (key, rest);
        }
        return (null, address);
    }

    private static long? ParseV1Time(string? value) =>
        value is null or "none" ? null
        : DateTime.TryParse(value, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var dt)
            ? new DateTimeOffset(dt, TimeSpan.Zero).ToUnixTimeMilliseconds()
            : null;

    /// <summary>
    /// v1 time patterns: "W124/T06:30:00" (weekdays bitmask + time), "PT00:10:00" (timer),
    /// "2026-11-20T07:00:00" (once). Best effort.
    /// </summary>
    private static string? DescribeLocalTime(string? value)
    {
        if (string.IsNullOrEmpty(value)) return null;
        if (value.StartsWith('W') && value.IndexOf("/T", StringComparison.Ordinal) is var t and > 0
            && int.TryParse(value[1..t], out var mask))
        {
            string[] days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
            var selected = days.Where((_, i) => (mask & (1 << (6 - i))) != 0).ToList();
            var dayText = selected.Count == 7 ? "Every day" : mask == 124 ? "Mon–Fri" : mask == 3 ? "Weekends" : string.Join(", ", selected);
            return $"{value[(t + 2)..Math.Min(value.Length, t + 7)]} · {dayText}";
        }
        if (value.StartsWith("PT", StringComparison.Ordinal)) return $"Timer {value[2..]}";
        if (value.StartsWith("R", StringComparison.Ordinal) && value.Contains("/PT")) return $"Repeating timer {value[(value.IndexOf("/PT", StringComparison.Ordinal) + 3)..]}";
        return value.Replace('T', ' ');
    }
}
