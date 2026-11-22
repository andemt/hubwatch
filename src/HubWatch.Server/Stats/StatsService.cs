using HubWatch.Data;
using HubWatch.Systems;

namespace HubWatch.Stats;

public sealed record LightStatDto(string SystemId, string Id, string? DeviceId, string Name, string? Room, long OnMs, int SwitchOns,
    long[] PerDayMs);

public sealed record ActivityDto(string SystemId, string ResourceId, string? DeviceId, string Name, string? Room, string ResourceType,
    int Count);

public sealed record MotionSensorStatDto(string SystemId, string Id, string? DeviceId, string Name, string? Room, int Count);

/// <summary>How much of the period one system was actually recorded.</summary>
public sealed record SystemCoverageDto(string SystemId, long RecordedMs);

public sealed record StatsDto(
    long From,
    long To,
    string[] Days,
    List<SystemCoverageDto> Coverage,
    List<LightStatDto> Lights,
    int[][] MotionByWeekdayHour,
    int MotionTotal,
    List<MotionSensorStatDto> MotionSensors,
    List<ActivityDto> MostActive);

/// <summary>
/// Computes statistics from recorded history of the given systems. Only time a system was actually being
/// recorded counts for it: a light that was on when recording stopped is not assumed to stay on through the gap.
/// </summary>
public sealed class StatsService(Database db, SystemRegistry registry)
{
    public StatsDto Compute(IReadOnlyList<SystemRuntime> systems, int days)
    {
        var ids = systems.Select(s => s.Id).ToList();
        var tz = TimeZoneInfo.Local;
        var nowUtc = DateTimeOffset.UtcNow;
        var todayLocal = TimeZoneInfo.ConvertTime(nowUtc, tz).Date;
        var firstDay = todayLocal.AddDays(-(days - 1));

        // Local midnights as UTC milliseconds (correct across daylight-saving changes).
        var dayStarts = Enumerable.Range(0, days + 1)
            .Select(i => new DateTimeOffset(firstDay.AddDays(i), tz.GetUtcOffset(firstDay.AddDays(i))).ToUnixTimeMilliseconds())
            .ToArray();
        var from = dayStarts[0];
        var to = nowUtc.ToUnixTimeMilliseconds();

        var coverage = Coverage(ids, from, to);

        return new StatsDto(
            from, to,
            [.. Enumerable.Range(0, days).Select(i => firstDay.AddDays(i).ToString("yyyy-MM-dd"))],
            [.. ids.Select(id => new SystemCoverageDto(id, coverage.GetValueOrDefault(id, []).Sum(c => c.End - c.Start)))],
            LightStats(systems, from, to, dayStarts, coverage),
            MotionHeatmap(ids, from, tz, out var total, out var sensors),
            total,
            sensors,
            MostActive(ids, from));
    }

    /// <summary>Recorded periods (sessions) per system, clipped to the range.</summary>
    private Dictionary<string, List<(long Start, long End)>> Coverage(IReadOnlyCollection<string> systems, long from, long to)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return db.QuerySessions(systems, from)
            .Select(s =>
            {
                // An open session is still recording if it was seen recently.
                var end = s.EndedAt ?? (now - s.LastSeenAt < 120_000 ? now : s.LastSeenAt);
                return (s.SystemId, Start: Math.Max(s.StartedAt, from), End: Math.Min(end, to));
            })
            .Where(c => c.End > c.Start)
            .GroupBy(c => c.SystemId)
            .ToDictionary(g => g.Key, g => g.Select(c => (c.Start, c.End)).OrderBy(c => c.Start).ToList());
    }

    private List<LightStatDto> LightStats(IReadOnlyList<SystemRuntime> systems, long from, long to, long[] dayStarts,
        Dictionary<string, List<(long Start, long End)>> coverage)
    {
        var states = db.QueryOnStates([.. systems.Select(s => s.Id)], from, to)
            .GroupBy(s => (s.SystemId, s.ResourceId))
            .ToDictionary(g => g.Key, g => g.ToList());
        var result = new List<LightStatDto>();

        foreach (var system in systems)
        {
            var resources = system.Resources;
            var systemCoverage = coverage.GetValueOrDefault(system.Id, []);

            foreach (var id in resources.LightIds())
            {
                var (name, room) = resources.Describe(id);
                var perDay = new long[dayStarts.Length - 1];
                var switchOns = 0;
                var list = states.GetValueOrDefault((system.Id, id), []);

                for (var i = 0; i < list.Count; i++)
                {
                    var on = list[i].On;
                    var ts = list[i].Ts;
                    var previousOn = i > 0 && list[i - 1].On;
                    if (on && !previousOn && ts >= from && i > 0) switchOns++;
                    if (!on) continue;

                    var start = Math.Max(ts, from);
                    var end = i + 1 < list.Count ? list[i + 1].Ts : to;
                    foreach (var (cs, ce) in systemCoverage)
                    {
                        var s = Math.Max(start, cs);
                        var e = Math.Min(end, ce);
                        if (e > s) AddToDays(perDay, dayStarts, s, e);
                    }
                }

                result.Add(new LightStatDto(system.Id, id, resources.OwnerOf(id), name ?? "Light", room, perDay.Sum(), switchOns, perDay));
            }
        }

        return result.OrderByDescending(l => l.OnMs).ThenBy(l => l.Name).ToList();
    }

    private static void AddToDays(long[] perDay, long[] dayStarts, long start, long end)
    {
        for (var d = 0; d < perDay.Length; d++)
        {
            var s = Math.Max(start, dayStarts[d]);
            var e = Math.Min(end, dayStarts[d + 1]);
            if (e > s) perDay[d] += e - s;
        }
    }

    /// <summary>Motion detections per weekday (0 = Monday) and local hour.</summary>
    private int[][] MotionHeatmap(IReadOnlyCollection<string> systems, long from, TimeZoneInfo tz, out int total,
        out List<MotionSensorStatDto> sensors)
    {
        var grid = Enumerable.Range(0, 7).Select(_ => new int[24]).ToArray();
        var events = db.QueryMotionDetected(systems, from);
        foreach (var (_, _, ts) in events)
        {
            var local = TimeZoneInfo.ConvertTime(DateTimeOffset.FromUnixTimeMilliseconds(ts), tz);
            var weekday = ((int)local.DayOfWeek + 6) % 7;
            grid[weekday][local.Hour]++;
        }
        total = events.Count;
        sensors = events
            .GroupBy(e => (e.SystemId, e.ResourceId))
            .Select(g =>
            {
                var resources = registry.Get(g.Key.SystemId)?.Resources;
                var (name, room) = resources?.Describe(g.Key.ResourceId) ?? ((string?)null, (string?)null);
                return new MotionSensorStatDto(g.Key.SystemId, g.Key.ResourceId, resources?.OwnerOf(g.Key.ResourceId),
                    name ?? "Motion sensor", room, g.Count());
            })
            .OrderByDescending(s => s.Count)
            .ToList();
        return grid;
    }

    private List<ActivityDto> MostActive(IReadOnlyCollection<string> systems, long from) =>
        db.QueryEventCounts(systems, from)
            .Select(c => (Count: c, Resources: registry.Get(c.SystemId)?.Resources))
            // Only things people recognise: lights, sensors, switches, scenes. Not system plumbing.
            .Where(x => x.Resources?.IsUserFacing(x.Count.ResourceType) ?? false)
            .Select(x =>
            {
                var (name, room) = x.Resources!.Describe(x.Count.ResourceId);
                return new ActivityDto(x.Count.SystemId, x.Count.ResourceId, x.Resources.OwnerOf(x.Count.ResourceId),
                    name ?? x.Count.ResourceType, room, x.Count.ResourceType, x.Count.Count);
            })
            .OrderByDescending(a => a.Count)
            .Take(10)
            .ToList();
}
