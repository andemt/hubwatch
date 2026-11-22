using System.Collections.Concurrent;

namespace HubWatch.Hue;

/// <summary>
/// On/off changes HubWatch has asked one bridge for and is waiting to see in the event stream. The bridge does
/// not say who caused a change, so an event is attributed to HubWatch when it reports the requested state for a
/// resource shortly after the request.
/// One instance is shared by every system connected to the same bridge (it can be added more than once): each of
/// them records the change from its own event stream, so an expectation matches at most one event per system.
/// </summary>
public sealed class PendingCommands
{
    private static readonly TimeSpan Window = TimeSpan.FromSeconds(10);

    private sealed record Expectation(bool On, DateTimeOffset Until)
    {
        public HashSet<string> MatchedBy { get; } = [];
    }

    private readonly ConcurrentDictionary<string, Expectation> _expected = new();

    public void Expect(IEnumerable<string> resourceIds, bool on)
    {
        var until = DateTimeOffset.UtcNow + Window;
        foreach (var id in resourceIds) _expected[id] = new Expectation(on, until);
    }

    public void Forget(IEnumerable<string> resourceIds)
    {
        foreach (var id in resourceIds) _expected.TryRemove(id, out _);
    }

    /// <summary>
    /// True when this resource was asked to switch to <paramref name="on"/> and <paramref name="systemId"/> has
    /// not already attributed an event to that request.
    /// </summary>
    public bool TryMatch(string systemId, string resourceId, bool? on)
    {
        if (on is null || !_expected.TryGetValue(resourceId, out var e)) return false;
        if (e.Until < DateTimeOffset.UtcNow)
        {
            _expected.TryRemove(new KeyValuePair<string, Expectation>(resourceId, e));
            return false;
        }
        if (e.On != on) return false;
        lock (e.MatchedBy) return e.MatchedBy.Add(systemId);
    }
}
