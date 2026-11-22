using System.Text.Json.Nodes;
using HubWatch.Hue;
using static HubWatch.Hue.Json;

namespace HubWatch.Ikea;

/// <summary>One thing that happened, ready to be stored: what kind of resource it concerns and a short summary.</summary>
public sealed record IkeaChange(string EventType, string ResourceType, string Summary);

/// <summary>
/// Turns DIRIGERA websocket messages into the same kind of events and readings as Hue, using Hue's resource type names
/// (light, motion, contact, temperature, light_level, device_power, zigbee_connectivity, button) so the UI groups and
/// counts them the same way. One message can describe several changes (e.g. a sensor's motion and battery); each
/// becomes its own event.
/// </summary>
public static class IkeaEventInterpreter
{
    private static readonly string[] LightAttributes = ["isOn", "lightLevel", "colorTemperature", "colorHue", "colorSaturation"];

    // Attributes that change on their own all the time and say nothing a person would care about.
    private static readonly HashSet<string> Noise =
    [
        "lastSeen", "otaProgress", "otaScheduleStart", "otaScheduleEnd", "identifyStarted", "identifyPeriod",
        "permittingJoin", "colorTemperatureMin", "colorTemperatureMax", "colorMode", "nextTimeOfDayChange",
        // Hub/gateway churn: these tick over on their own and mean nothing to a person.
        "sunPosition", "homestate", "backendConnected", "backendConnectionPersistent", "backendOnboardingComplete",
        "userConsents", "timezone", "nextSunrise", "nextSunset", "isOn", "totalEnergyConsumedLastUpdated",
        "energyConsumedAtLastReset", "currentActivePower", "totalEnergyConsumed",
    ];

    /// <summary>The Hue-style resource types a device has, from its type and the attributes it reports.</summary>
    public static List<string> KindsOf(JsonObject device)
    {
        var a = device["attributes"] as JsonObject ?? [];
        var deviceType = Str(device["deviceType"]) ?? "";
        var kinds = new List<string>();
        if (deviceType is "light" or "outlet" || (a.ContainsKey("isOn") && deviceType != "gateway")) kinds.Add("light");
        if (a.ContainsKey("isDetected")) kinds.Add("motion");
        if (a.ContainsKey("isOpen")) kinds.Add("contact");
        if (a.ContainsKey("currentTemperature")) kinds.Add("temperature");
        if (a.ContainsKey("illuminance")) kinds.Add("light_level");
        if (a.ContainsKey("batteryPercentage")) kinds.Add("device_power");
        if (IsController(device)) kinds.Add("button");
        if (device.ContainsKey("isReachable") && deviceType != "gateway") kinds.Add("zigbee_connectivity");
        return kinds;
    }

    private static bool IsController(JsonObject device) =>
        Str(device["type"]) == "controller" || (Str(device["deviceType"])?.EndsWith("Controller", StringComparison.Ordinal) ?? false);

    /// <summary>
    /// What a device message changed. <paramref name="before"/> is the device before the message was applied (null
    /// when new), <paramref name="after"/> after it (null when removed). Returns nothing when only noise changed.
    /// </summary>
    public static List<IkeaChange> Interpret(string messageType, JsonObject data, JsonObject? before, JsonObject? after,
        List<Reading> readings)
    {
        var id = Str(data["id"]) ?? "";
        var device = after ?? before ?? data;
        var deviceType = Str(device["deviceType"]) ?? Str(device["type"]) ?? "device";

        switch (messageType)
        {
            case "deviceAdded": return [new IkeaChange("add", "device", $"Added {Pretty(deviceType)}")];
            case "deviceRemoved": return [new IkeaChange("delete", "device", $"Removed {Pretty(deviceType)}")];
        }

        var changes = new List<IkeaChange>();
        var attrs = data["attributes"] as JsonObject ?? [];
        var old = before?["attributes"] as JsonObject;
        var changed = attrs
            .Where(p => old is null || !JsonNode.DeepEquals(p.Value, old[p.Key]))
            .Select(p => p.Key)
            .ToHashSet();

        if (changed.Overlaps(LightAttributes) && deviceType != "gateway")
        {
            var parts = new List<string>();
            if (changed.Contains("isOn") && Bool(attrs["isOn"]) is { } on)
            {
                parts.Add(on ? "turned on" : "turned off");
                readings.Add(new Reading(id, "on", on ? 1 : 0));
            }
            if (changed.Contains("lightLevel") && Num(attrs["lightLevel"]) is { } level) parts.Add($"brightness {level:0}%");
            if (changed.Contains("colorTemperature") && Num(attrs["colorTemperature"]) is { } kelvin) parts.Add($"white {kelvin:0} K");
            if (changed.Contains("colorHue") || changed.Contains("colorSaturation")) parts.Add("color changed");
            changes.Add(new IkeaChange("update", "light", parts.Count == 0 ? "Light updated" : Capitalize(string.Join(", ", parts))));
        }

        if (changed.Contains("isDetected") && Bool(attrs["isDetected"]) is { } motion)
            changes.Add(new IkeaChange("update", "motion", motion ? "Motion detected" : "No motion"));

        if (changed.Contains("isOpen") && Bool(attrs["isOpen"]) is { } open)
            changes.Add(new IkeaChange("update", "contact", open ? "Opened" : "Closed"));

        if (changed.Contains("currentTemperature") && Num(attrs["currentTemperature"]) is { } t)
        {
            readings.Add(new Reading(id, "temperature", t));
            changes.Add(new IkeaChange("update", "temperature", $"Temperature {t:0.0} °C"));
        }

        // illuminance comes Zigbee-encoded (10000*log10(lux)+1), same as Hue; decode to real lux.
        if (changed.Contains("illuminance") && EventInterpreter.ToLux(Num(attrs["illuminance"])) is { } lux)
        {
            readings.Add(new Reading(id, "lux", lux));
            changes.Add(new IkeaChange("update", "light_level", $"Light level {lux:0} lx"));
        }

        if (changed.Contains("batteryPercentage") && Num(attrs["batteryPercentage"]) is { } battery)
        {
            readings.Add(new Reading(id, "battery", battery));
            changes.Add(new IkeaChange("update", "device_power", $"Battery {battery:0}%"));
        }

        if (Bool(data["isReachable"]) is { } reachable && Bool(before?["isReachable"]) != reachable && before is not null)
            changes.Add(new IkeaChange("update", "zigbee_connectivity", reachable ? "Zigbee connected" : "Zigbee disconnected"));

        if (changed.Contains("otaStatus") || changed.Contains("otaState"))
        {
            var state = Str(attrs["otaState"]) ?? Str(attrs["otaStatus"]);
            changes.Add(new IkeaChange("update", "device_software_update", state is null ? "Firmware updated" : $"Firmware: {Pretty(state)}"));
        }

        var handled = new HashSet<string>(LightAttributes)
        {
            "isDetected", "isOpen", "currentTemperature", "illuminance", "batteryPercentage", "otaStatus", "otaState",
        };
        var rest = changed.Where(k => !handled.Contains(k) && !Noise.Contains(k)).ToList();
        if (rest.Contains("customName"))
        {
            changes.Add(new IkeaChange("update", "device", $"Renamed to {Str(attrs["customName"])}"));
            rest.Remove("customName");
        }
        // Electrical sensors (power plugs with metering) stream amps/volts/watts constantly; that telemetry is
        // not surfaced as events. Everything meaningful about them is handled above.
        if (rest.Count > 0 && deviceType != "electricalSensor")
            changes.Add(new IkeaChange("update", OtherType(device), $"Updated {string.Join(", ", rest.Select(Label))}"));

        // Remotes report little state of their own; a message from one with nothing else in it is it being used.
        if (changes.Count == 0 && IsController(device) && messageType == "deviceStateChanged" && attrs.Count > 0)
            changes.Add(new IkeaChange("update", "button", "Remote used"));

        return changes;
    }

    /// <summary>Scene and room messages, and any message type HubWatch does not know yet.</summary>
    public static IkeaChange? InterpretOther(string messageType, JsonObject data, string? sceneName)
    {
        var eventType = messageType.EndsWith("Created", StringComparison.Ordinal) || messageType.EndsWith("Added", StringComparison.Ordinal) ? "add"
            : messageType.EndsWith("Deleted", StringComparison.Ordinal) || messageType.EndsWith("Removed", StringComparison.Ordinal) ? "delete"
            : "update";

        if (messageType.StartsWith("scene", StringComparison.Ordinal))
        {
            var name = Str(data["info"]?["name"]) ?? sceneName;
            var label = name is null ? "Scene" : $"Scene \"{name}\"";
            return eventType switch
            {
                "add" => new IkeaChange(eventType, "scene", $"{label} created"),
                "delete" => new IkeaChange(eventType, "scene", $"{label} removed"),
                _ when messageType == "sceneTriggered" || data.ContainsKey("lastTriggered") =>
                    new IkeaChange(eventType, "scene", $"{label} activated"),
                _ => new IkeaChange(eventType, "scene", $"{label} updated"),
            };
        }

        if (messageType.StartsWith("room", StringComparison.Ordinal))
            return new IkeaChange(eventType, "room", $"Room {Pretty(SplitCamel(messageType[4..]))}");

        return new IkeaChange(eventType, Str(data["type"]) ?? "hub", Capitalize(Pretty(SplitCamel(messageType))));
    }

    private static readonly Dictionary<string, string> Labels = new()
    {
        ["currentRH"] = "humidity",
        ["currentPM25"] = "PM2.5",
        ["currentCO2"] = "CO₂",
        ["vocIndex"] = "VOC index",
        ["startupOnOff"] = "power-on behavior",
    };

    private static string Label(string attribute) => Labels.GetValueOrDefault(attribute) ?? Pretty(attribute);

    private static string OtherType(JsonObject device) => Str(device["deviceType"]) == "gateway" ? "gateway" : "device";

    private static string SplitCamel(string value) =>
        string.Concat(value.Select((c, i) => i > 0 && char.IsUpper(c) ? $" {char.ToLowerInvariant(c)}" : $"{c}"));

    private static string Pretty(string value) => SplitCamel(value).Replace('_', ' ').ToLowerInvariant();

    private static string Capitalize(string text) => text.Length == 0 ? text : char.ToUpperInvariant(text[0]) + text[1..];
}
