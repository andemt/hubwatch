namespace HubWatch.Systems;

/// <summary>
/// Optional capability of an <see cref="ISystemAdapter"/>: switching lights, rooms and zones on and off.
/// The change itself is not recorded here: it is recorded when the system reports it back through its event
/// stream, and those events are marked with <see cref="Origins.HubWatch"/>.
/// </summary>
public interface ISystemControl
{
    /// <summary>
    /// Switches <paramref name="targetId"/> on or off. The target can be a light, a device with a light, a room or a zone.
    /// Throws <see cref="KeyNotFoundException"/> when the target is unknown or cannot be switched, and
    /// <see cref="ControlFailedException"/> when the system refuses or cannot be reached.
    /// </summary>
    Task SetOnAsync(SystemRuntime system, string targetId, bool on, CancellationToken ct);
}

public sealed class ControlFailedException(string message, Exception? inner = null) : Exception(message, inner);

public sealed record PowerRequest(string Target, bool On);

/// <summary>Values of <c>origin</c> on recorded events: who caused a change, when HubWatch knows.</summary>
public static class Origins
{
    /// <summary>The change was requested from HubWatch itself.</summary>
    public const string HubWatch = "hubwatch";
}
