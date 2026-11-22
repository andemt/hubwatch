using System.Text.Json.Nodes;
using static HubWatch.Hue.Json;

namespace HubWatch.Hue;

public sealed record Reading(string ResourceId, string Kind, double Value);

/// <summary>Turns raw Hue v2 event items into short human-readable summaries and numeric readings.</summary>
public static class EventInterpreter
{
    /// <param name="eventType">update, add, delete, error (or "backfill" for snapshot-derived events)</param>
    /// <param name="item">The changed properties as sent by the bridge.</param>
    /// <param name="current">The full merged resource, for context such as button numbers.</param>
    public static string Summarize(string eventType, JsonObject item, JsonObject? current, out Reading? reading)
    {
        reading = null;
        var type = Str(item["type"]) ?? "unknown";
        var id = Str(item["id"]) ?? "";

        switch (eventType)
        {
            case "add": return $"Added {Pretty(type)}";
            case "delete": return $"Removed {Pretty(type)}";
            case "error": return $"Error on {Pretty(type)}";
        }

        switch (type)
        {
            case "light":
            case "grouped_light":
                if (type == "light" && Bool(item["on"]?["on"]) is { } isOn)
                    reading = new Reading(id, "on", isOn ? 1 : 0);
                return LightSummary(item);

            case "motion":
            case "grouped_motion":
            case "camera_motion":
            case "convenience_area_motion":
            case "security_area_motion":
            {
                var motion = Bool(item["motion"]?["motion_report"]?["motion"]) ?? Bool(item["motion"]?["motion"]);
                return motion switch
                {
                    true => "Motion detected",
                    false => "No motion",
                    null => Bool(item["enabled"]) is { } on ? (on ? "Sensor enabled" : "Sensor disabled") : "Motion sensor updated",
                };
            }

            case "button":
            {
                var ev = Str(item["button"]?["button_report"]?["event"]) ?? Str(item["button"]?["last_event"]);
                var control = Num(current?["metadata"]?["control_id"]);
                var label = control is { } c ? $"Button {c:0}" : "Button";
                return ev is null ? $"{label} updated" : $"{label}: {Pretty(ev)}";
            }

            case "relative_rotary":
            {
                var report = item["relative_rotary"]?["rotary_report"] ?? item["relative_rotary"]?["last_event"];
                var direction = Str(report?["rotation"]?["direction"]);
                var steps = Num(report?["rotation"]?["steps"]);
                return direction is null ? "Dial turned" : $"Dial turned {Pretty(direction)} ({steps:0} steps)";
            }

            case "temperature":
            case "grouped_temperature":
            {
                var t = Num(item["temperature"]?["temperature_report"]?["temperature"]) ?? Num(item["temperature"]?["temperature"]);
                if (t is null) return "Temperature sensor updated";
                if (type == "temperature") reading = new Reading(id, "temperature", t.Value);
                return $"Temperature {t:0.0} °C";
            }

            case "light_level":
            case "grouped_light_level":
            {
                var lux = ToLux(Num(item["light"]?["light_level_report"]?["light_level"]) ?? Num(item["light"]?["light_level"]));
                if (lux is null) return "Light sensor updated";
                if (type == "light_level") reading = new Reading(id, "lux", lux.Value);
                return $"Light level {lux:0} lx";
            }

            case "contact":
            {
                var state = Str(item["contact_report"]?["state"]);
                return state switch
                {
                    "contact" => "Closed",
                    "no_contact" => "Opened",
                    _ => "Contact sensor updated",
                };
            }

            case "tamper":
                return "Tamper state changed";

            case "device_power":
            {
                var level = Num(item["power_state"]?["battery_level"]);
                var state = Str(item["power_state"]?["battery_state"]);
                if (level is null) return state is null ? "Power state updated" : $"Battery {Pretty(state)}";
                reading = new Reading(id, "battery", level.Value);
                return $"Battery {level:0}%" + (state is null or "normal" ? "" : $" ({Pretty(state)})");
            }

            case "zigbee_connectivity":
                return Str(item["status"]) is { } status ? $"Zigbee {Pretty(status)}" : "Zigbee connectivity updated";

            case "scene":
            {
                var active = Str(item["status"]?["active"]);
                return active switch
                {
                    null => "Scene updated",
                    "inactive" => "Scene deactivated",
                    _ => $"Scene activated ({Pretty(active)})",
                };
            }

            default:
            {
                var keys = item.Select(p => p.Key)
                    .Where(k => k is not ("id" or "id_v1" or "type" or "owner" or "service_id"))
                    .ToList();
                return keys.Count == 0 ? "Updated" : $"Updated {string.Join(", ", keys.Select(Pretty))}";
            }
        }
    }

    /// <summary>Hue reports light level as 10000 * log10(lux) + 1.</summary>
    public static double? ToLux(double? lightLevel) =>
        lightLevel is { } v ? Math.Round(Math.Pow(10, (v - 1) / 10000.0), 1) : null;

    private static string LightSummary(JsonObject item)
    {
        var parts = new List<string>();

        if (Bool(item["on"]?["on"]) is { } on)
            parts.Add(on ? "turned on" : "turned off");
        if (Num(item["dimming"]?["brightness"]) is { } brightness)
            parts.Add($"brightness {brightness:0}%");
        if (Num(item["color_temperature"]?["mirek"]) is double mirek && mirek > 0)
            parts.Add($"white {1_000_000 / mirek:0} K");
        if (item["color"]?["xy"] is not null)
            parts.Add("color changed");
        if (Str(item["effects"]?["status"]) is { } effect)
            parts.Add(effect == "no_effect" ? "effect stopped" : $"effect {Pretty(effect)}");

        if (parts.Count == 0) return "Light updated";
        var text = string.Join(", ", parts);
        return char.ToUpperInvariant(text[0]) + text[1..];
    }

    private static string Pretty(string value) => value.Replace('_', ' ');
}
