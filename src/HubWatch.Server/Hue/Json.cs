using System.Text.Json.Nodes;

namespace HubWatch.Hue;

/// <summary>Null-tolerant helpers for reading values out of Hue JSON.</summary>
public static class Json
{
    public static string? Str(JsonNode? node) =>
        node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    public static double? Num(JsonNode? node) =>
        node is JsonValue v && v.TryGetValue<double>(out var d) ? d : null;

    public static bool? Bool(JsonNode? node) =>
        node is JsonValue v && v.TryGetValue<bool>(out var b) ? b : null;

    public static long? UnixMs(JsonNode? node) =>
        Str(node) is { } s && DateTimeOffset.TryParse(s, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeUniversal, out var dto)
            ? dto.ToUnixTimeMilliseconds()
            : null;
}
