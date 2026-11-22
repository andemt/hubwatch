using HubWatch.Config;
using HubWatch.Hue;
using Microsoft.Data.Sqlite;

namespace HubWatch.Data;

public sealed record StoredEvent(
    long Id,
    string SystemId,
    long Ts,
    string EventType,
    string ResourceId,
    string ResourceType,
    string? Name,
    string? Room,
    string Summary,
    string Data,
    /// <summary>Who caused the change when HubWatch knows (see <see cref="Systems.Origins"/>); otherwise null.</summary>
    string? Origin = null);

public sealed record SessionDto(long Id, string SystemId, long StartedAt, long LastSeenAt, long? EndedAt);

public sealed record ReadingDto(long Ts, double Value);

public sealed record AlertDto(
    long Id,
    string SystemId,
    long OpenedAt,
    long? ResolvedAt,
    bool Acknowledged,
    string Kind,
    string Key,
    // "warning" or "critical"
    string Severity,
    string Title,
    string Message);

/// <summary>
/// SQLite storage. All timestamps are Unix milliseconds (UTC).
/// A "session" is a period during which the app was connected to one system's event stream;
/// the time between that system's sessions is a gap where nothing was recorded for it.
/// Every row belongs to a system (system_id → systems.id, an internal integer). Outside this class systems
/// are identified by their stable key (systems.key, e.g. "hue-ecb5fafffeb1b99d", the id used in config and API);
/// this class translates. Writes name their system explicitly; reads take the set of systems to include, so
/// callers decide (normally: all connected systems).
/// </summary>
public sealed class Database
{
    private readonly string _connectionString;

    // systems.key ↔ systems.id, loaded from the systems table on demand.
    private readonly Lock _systemsLock = new();
    private Dictionary<string, long> _idByKey = new();
    private Dictionary<long, string> _keyById = new();

    public Database(AppPaths paths)
    {
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = paths.DatabaseFile,
            Mode = SqliteOpenMode.ReadWriteCreate,
            DefaultTimeout = 30,
        }.ToString();
        Initialize();
    }

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        return connection;
    }

    private void Initialize()
    {
        using var c = Open();
        Exec(c, """
            PRAGMA journal_mode = WAL;

            -- Which system recorded rows belong to. How to connect to a system lives in config.json.
            CREATE TABLE IF NOT EXISTS systems (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,   -- internal; referenced by system_id
                key      TEXT    NOT NULL UNIQUE,             -- stable id used in config and API, e.g. "hue-ecb5fafffeb1b99d"
                kind     TEXT    NOT NULL,                    -- adapter, e.g. "hue"
                name     TEXT,
                added_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS events (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                system_id     INTEGER NOT NULL REFERENCES systems (id),
                ts            INTEGER NOT NULL,
                event_type    TEXT    NOT NULL,
                resource_id   TEXT    NOT NULL,
                resource_type TEXT    NOT NULL,
                name          TEXT,
                room          TEXT,
                summary       TEXT    NOT NULL,
                data          TEXT    NOT NULL   -- the system's own JSON for the event
            );

            CREATE TABLE IF NOT EXISTS readings (
                system_id   INTEGER NOT NULL REFERENCES systems (id),
                ts          INTEGER NOT NULL,
                resource_id TEXT    NOT NULL,
                kind        TEXT    NOT NULL,
                value       REAL    NOT NULL
            );

            CREATE TABLE IF NOT EXISTS alerts (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                system_id    INTEGER NOT NULL REFERENCES systems (id),
                opened_at    INTEGER NOT NULL,
                resolved_at  INTEGER,
                acknowledged INTEGER NOT NULL DEFAULT 0,
                kind         TEXT    NOT NULL,
                key          TEXT    NOT NULL,
                severity     TEXT    NOT NULL,
                title        TEXT    NOT NULL,
                message      TEXT    NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                system_id    INTEGER NOT NULL REFERENCES systems (id),
                started_at   INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                ended_at     INTEGER
            );

            -- The last known devices, rooms and automations of each system (its adapter's own format), so they
            -- can be shown after a restart while the system can't be reached.
            CREATE TABLE IF NOT EXISTS resource_snapshots (
                system_id INTEGER PRIMARY KEY REFERENCES systems (id),
                saved_at  INTEGER NOT NULL,
                data      TEXT    NOT NULL
            );

            CREATE INDEX IF NOT EXISTS ix_events_system_ts       ON events   (system_id, ts);
            CREATE INDEX IF NOT EXISTS ix_events_system_resource ON events   (system_id, resource_id, ts);
            CREATE INDEX IF NOT EXISTS ix_readings_resource      ON readings (system_id, resource_id, kind, ts);
            CREATE INDEX IF NOT EXISTS ix_readings_kind_ts       ON readings (system_id, kind, ts);
            CREATE INDEX IF NOT EXISTS ix_alerts_open            ON alerts   (system_id, kind, key, resolved_at);
            CREATE INDEX IF NOT EXISTS ix_sessions_system        ON sessions (system_id, started_at);
            """);

        // Added after the first release.
        if (!HasColumn(c, "events", "origin"))
            Exec(c, "ALTER TABLE events ADD COLUMN origin TEXT;");
    }

    // ---------- systems ----------

    /// <summary>
    /// Records a system (or updates its name) so rows can be written for it. A system connected again
    /// later with the same key gets the same row, and so finds its history.
    /// </summary>
    public void EnsureSystem(SystemConfig system)
    {
        using (var c = Open())
        using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = """
                INSERT INTO systems (key, kind, name, added_at) VALUES ($key, $kind, $name, $now)
                ON CONFLICT (key) DO UPDATE SET name = COALESCE(excluded.name, systems.name);
                """;
            cmd.Parameters.AddWithValue("$key", system.Id);
            cmd.Parameters.AddWithValue("$kind", system.Kind);
            cmd.Parameters.AddWithValue("$name", (object?)system.Name ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            cmd.ExecuteNonQuery();
        }
        LoadSystems();
    }

    private void LoadSystems()
    {
        var idByKey = new Dictionary<string, long>();
        var keyById = new Dictionary<long, string>();
        using (var c = Open())
        using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "SELECT id, key FROM systems;";
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                idByKey[r.GetString(1)] = r.GetInt64(0);
                keyById[r.GetInt64(0)] = r.GetString(1);
            }
        }
        lock (_systemsLock)
        {
            _idByKey = idByKey;
            _keyById = keyById;
        }
    }

    /// <summary>The internal id of a system, or null if it has never been recorded.</summary>
    private long? FindDbId(string systemKey)
    {
        lock (_systemsLock)
            if (_idByKey.TryGetValue(systemKey, out var id)) return id;
        LoadSystems();
        lock (_systemsLock)
            return _idByKey.TryGetValue(systemKey, out var id) ? id : null;
    }

    /// <summary>The internal id of a system that is being written for (registered with <see cref="EnsureSystem"/>).</summary>
    private long DbIdOf(string systemKey) =>
        FindDbId(systemKey) ?? throw new InvalidOperationException($"System {systemKey} is not registered in the database.");

    private string KeyOf(long dbId)
    {
        lock (_systemsLock)
            if (_keyById.TryGetValue(dbId, out var key)) return key;
        LoadSystems();
        lock (_systemsLock)
            return _keyById.TryGetValue(dbId, out var key) ? key : $"#{dbId}";
    }

    // ---------- last known resources ----------

    public void SaveResourceSnapshot(string systemId, long savedAt, string data)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            INSERT INTO resource_snapshots (system_id, saved_at, data) VALUES ($system, $savedAt, $data)
            ON CONFLICT (system_id) DO UPDATE SET saved_at = excluded.saved_at, data = excluded.data;
            """;
        cmd.Parameters.AddWithValue("$system", DbIdOf(systemId));
        cmd.Parameters.AddWithValue("$savedAt", savedAt);
        cmd.Parameters.AddWithValue("$data", data);
        cmd.ExecuteNonQuery();
    }

    public (long SavedAt, string Data)? LoadResourceSnapshot(string systemId)
    {
        if (FindDbId(systemId) is not { } dbId) return null;
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT saved_at, data FROM resource_snapshots WHERE system_id = $system;";
        cmd.Parameters.AddWithValue("$system", dbId);
        using var r = cmd.ExecuteReader();
        return r.Read() ? (r.GetInt64(0), r.GetString(1)) : null;
    }

    /// <summary>
    /// Permanently deletes everything recorded for a system: its events, readings, alerts, sessions
    /// and the system row itself. Call only when nothing is writing for that system any more.
    /// </summary>
    public void DeleteSystemData(string systemId)
    {
        if (FindDbId(systemId) is not { } dbId) return;
        using (var c = Open())
        using (var tx = c.BeginTransaction())
        {
            foreach (var table in new[] { "events", "readings", "alerts", "sessions", "resource_snapshots" })
            {
                using var cmd = c.CreateCommand();
                cmd.CommandText = $"DELETE FROM {table} WHERE system_id = $system;";
                cmd.Parameters.AddWithValue("$system", dbId);
                cmd.ExecuteNonQuery();
            }
            using (var cmd = c.CreateCommand())
            {
                cmd.CommandText = "DELETE FROM systems WHERE id = $system;";
                cmd.Parameters.AddWithValue("$system", dbId);
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
        }
        LoadSystems();
    }

    /// <summary>
    /// SQL condition limiting rows to the given systems (by key; adds the parameters to the command).
    /// Systems never recorded, and an empty set, match nothing.
    /// </summary>
    private string InSystems(SqliteCommand cmd, IReadOnlyCollection<string> systems)
    {
        var ids = systems.Select(FindDbId).OfType<long>().Distinct().ToList();
        if (ids.Count == 0) return "0";
        var names = ids.Select((id, i) =>
        {
            cmd.Parameters.AddWithValue($"$sys{i}", id);
            return $"$sys{i}";
        });
        return $"system_id IN ({string.Join(", ", names)})";
    }

    // ---------- events ----------

    /// <summary>Stores events and readings for one system. The events' own SystemId is ignored.</summary>
    public List<StoredEvent> InsertEvents(string systemId, IReadOnlyList<StoredEvent> events, IReadOnlyList<(long Ts, Reading Reading)> readings)
    {
        var stored = new List<StoredEvent>(events.Count);
        var dbId = DbIdOf(systemId);
        using var c = Open();
        using var tx = c.BeginTransaction();

        using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = """
                INSERT INTO events (system_id, ts, event_type, resource_id, resource_type, name, room, summary, data, origin)
                VALUES ($system, $ts, $et, $rid, $rt, $name, $room, $summary, $data, $origin)
                RETURNING id;
                """;
            cmd.Parameters.AddWithValue("$system", dbId);
            var pTs = cmd.Parameters.Add("$ts", SqliteType.Integer);
            var pEt = cmd.Parameters.Add("$et", SqliteType.Text);
            var pRid = cmd.Parameters.Add("$rid", SqliteType.Text);
            var pRt = cmd.Parameters.Add("$rt", SqliteType.Text);
            var pName = cmd.Parameters.Add("$name", SqliteType.Text);
            var pRoom = cmd.Parameters.Add("$room", SqliteType.Text);
            var pSummary = cmd.Parameters.Add("$summary", SqliteType.Text);
            var pData = cmd.Parameters.Add("$data", SqliteType.Text);
            var pOrigin = cmd.Parameters.Add("$origin", SqliteType.Text);

            foreach (var e in events)
            {
                pTs.Value = e.Ts;
                pEt.Value = e.EventType;
                pRid.Value = e.ResourceId;
                pRt.Value = e.ResourceType;
                pName.Value = (object?)e.Name ?? DBNull.Value;
                pRoom.Value = (object?)e.Room ?? DBNull.Value;
                pSummary.Value = e.Summary;
                pData.Value = e.Data;
                pOrigin.Value = (object?)e.Origin ?? DBNull.Value;
                var id = (long)cmd.ExecuteScalar()!;
                stored.Add(e with { Id = id, SystemId = systemId });
            }
        }

        if (readings.Count > 0)
        {
            using var cmd = c.CreateCommand();
            cmd.CommandText = "INSERT INTO readings (system_id, ts, resource_id, kind, value) VALUES ($system, $ts, $rid, $kind, $value);";
            cmd.Parameters.AddWithValue("$system", dbId);
            var pTs = cmd.Parameters.Add("$ts", SqliteType.Integer);
            var pRid = cmd.Parameters.Add("$rid", SqliteType.Text);
            var pKind = cmd.Parameters.Add("$kind", SqliteType.Text);
            var pValue = cmd.Parameters.Add("$value", SqliteType.Real);
            foreach (var (ts, r) in readings)
            {
                pTs.Value = ts;
                pRid.Value = r.ResourceId;
                pKind.Value = r.Kind;
                pValue.Value = r.Value;
                cmd.ExecuteNonQuery();
            }
        }

        tx.Commit();
        return stored;
    }

    /// <summary>Newest first. Paginate with the (ts, id) of the last event received.</summary>
    public List<StoredEvent> QueryEvents(IReadOnlyCollection<string> systems, long? beforeTs, long? beforeId, int limit,
        string? resourceType, string? search, IReadOnlyList<string>? resourceIds = null)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();

        var idFilter = "";
        if (resourceIds is { Count: > 0 })
        {
            var names = resourceIds.Select((id, i) =>
            {
                cmd.Parameters.AddWithValue($"$rid{i}", id);
                return $"$rid{i}";
            });
            idFilter = $"AND resource_id IN ({string.Join(", ", names)})";
        }

        cmd.CommandText = $"""
            SELECT id, system_id, ts, event_type, resource_id, resource_type, name, room, summary, data, origin
            FROM events
            WHERE {InSystems(cmd, systems)}
              AND ($bts IS NULL OR ts < $bts OR (ts = $bts AND id < $bid))
              AND ($type IS NULL OR resource_type = $type)
              AND ($q IS NULL OR name LIKE $q OR room LIKE $q OR summary LIKE $q)
              {idFilter}
            ORDER BY ts DESC, id DESC
            LIMIT $limit;
            """;
        cmd.Parameters.AddWithValue("$bts", (object?)beforeTs ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$bid", (object?)beforeId ?? long.MaxValue);
        cmd.Parameters.AddWithValue("$type", (object?)resourceType ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$q", search is { Length: > 0 } ? $"%{search}%" : DBNull.Value);
        cmd.Parameters.AddWithValue("$limit", Math.Clamp(limit, 1, 1000));

        var list = new List<StoredEvent>();
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(ReadEvent(r));
        return list;
    }

    /// <summary>One event by id, or null when it doesn't exist or belongs to a system that isn't selected.</summary>
    public StoredEvent? GetEvent(IReadOnlyCollection<string> systems, long id)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"""
            SELECT id, system_id, ts, event_type, resource_id, resource_type, name, room, summary, data, origin
            FROM events
            WHERE {InSystems(cmd, systems)} AND id = $id;
            """;
        cmd.Parameters.AddWithValue("$id", id);
        using var r = cmd.ExecuteReader();
        return r.Read() ? ReadEvent(r) : null;
    }

    /// <summary>Maps a row selected as: id, system_id, ts, event_type, resource_id, resource_type, name, room, summary, data, origin.</summary>
    private StoredEvent ReadEvent(SqliteDataReader r) => new(
        r.GetInt64(0), KeyOf(r.GetInt64(1)), r.GetInt64(2), r.GetString(3), r.GetString(4), r.GetString(5),
        r.IsDBNull(6) ? null : r.GetString(6),
        r.IsDBNull(7) ? null : r.GetString(7),
        r.GetString(8), r.GetString(9),
        r.IsDBNull(10) ? null : r.GetString(10));

    public long? LastEventTs(string systemId, string resourceId)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT MAX(ts) FROM events WHERE system_id = $system AND resource_id = $rid;";
        cmd.Parameters.AddWithValue("$rid", resourceId);
        cmd.Parameters.AddWithValue("$system", DbIdOf(systemId));
        return cmd.ExecuteScalar() is long ts ? ts : null;
    }

    public List<string> ResourceTypes(IReadOnlyCollection<string> systems)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"SELECT DISTINCT resource_type FROM events WHERE {InSystems(cmd, systems)} ORDER BY resource_type;";
        var list = new List<string>();
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(r.GetString(0));
        return list;
    }

    // ---------- readings ----------

    /// <param name="bucketMs">When &gt; 0, readings are averaged per time bucket to keep long ranges light.</param>
    public List<ReadingDto> QueryReadings(IReadOnlyCollection<string> systems, string resourceId, string kind, long fromTs,
        long bucketMs = 0)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        var inSystems = InSystems(cmd, systems);
        cmd.CommandText = bucketMs > 0
            ? $"""
              SELECT (ts / $bucket) * $bucket + $bucket / 2 AS t, AVG(value) FROM readings
              WHERE {inSystems} AND resource_id = $rid AND kind = $kind AND ts >= $from
              GROUP BY ts / $bucket
              ORDER BY t;
              """
            : $"""
              SELECT ts, value FROM readings
              WHERE {inSystems} AND resource_id = $rid AND kind = $kind AND ts >= $from
              ORDER BY ts;
              """;
        cmd.Parameters.AddWithValue("$bucket", Math.Max(bucketMs, 1));
        cmd.Parameters.AddWithValue("$rid", resourceId);
        cmd.Parameters.AddWithValue("$kind", kind);
        cmd.Parameters.AddWithValue("$from", fromTs);
        var list = new List<ReadingDto>();
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(new ReadingDto(r.GetInt64(0), r.GetDouble(1)));
        return list;
    }

    // ---------- statistics ----------

    /// <summary>On/off readings in the range, plus each light's last reading before it (its starting state).</summary>
    public List<(string SystemId, string ResourceId, long Ts, bool On)> QueryOnStates(IReadOnlyCollection<string> systems,
        long fromTs, long toTs)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        var inSystems = InSystems(cmd, systems);
        cmd.CommandText = $"""
            SELECT system_id, resource_id, ts, value FROM readings
            WHERE {inSystems} AND kind = 'on' AND ts >= $from AND ts <= $to
            UNION ALL
            SELECT system_id, resource_id, MAX(ts), value FROM readings
            WHERE {inSystems} AND kind = 'on' AND ts < $from GROUP BY system_id, resource_id
            ORDER BY 1, 2, 3;
            """;
        cmd.Parameters.AddWithValue("$from", fromTs);
        cmd.Parameters.AddWithValue("$to", toTs);
        var list = new List<(string, string, long, bool)>();
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add((KeyOf(r.GetInt64(0)), r.GetString(1), r.GetInt64(2), r.GetDouble(3) > 0.5));
        return list;
    }

    /// <summary>
    /// Times when any motion sensor reported "motion detected".
    /// Note: reads Hue's event JSON; other kinds of systems will need a normalized motion reading instead.
    /// </summary>
    public List<(string SystemId, string ResourceId, long Ts)> QueryMotionDetected(IReadOnlyCollection<string> systems, long fromTs)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"""
            SELECT system_id, resource_id, ts FROM events
            WHERE {InSystems(cmd, systems)} AND resource_type = 'motion' AND event_type IN ('update', 'backfill') AND ts >= $from
              AND COALESCE(json_extract(data, '$.motion.motion_report.motion'), json_extract(data, '$.motion.motion'),
                           json_extract(data, '$.attributes.isDetected')) = 1
            ORDER BY ts;
            """;
        cmd.Parameters.AddWithValue("$from", fromTs);
        var list = new List<(string, string, long)>();
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add((KeyOf(r.GetInt64(0)), r.GetString(1), r.GetInt64(2)));
        return list;
    }

    /// <summary>Number of events per resource (excluding room/zone aggregates).</summary>
    public List<(string SystemId, string ResourceId, string ResourceType, int Count)> QueryEventCounts(
        IReadOnlyCollection<string> systems, long fromTs)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"""
            SELECT system_id, resource_id, resource_type, COUNT(*) FROM events
            WHERE {InSystems(cmd, systems)} AND ts >= $from AND resource_type NOT LIKE 'grouped_%' AND event_type != 'backfill'
            GROUP BY system_id, resource_id, resource_type;
            """;
        cmd.Parameters.AddWithValue("$from", fromTs);
        var list = new List<(string, string, string, int)>();
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add((KeyOf(r.GetInt64(0)), r.GetString(1), r.GetString(2), r.GetInt32(3)));
        return list;
    }

    // ---------- alerts ----------

    private const string AlertColumns = "id, system_id, opened_at, resolved_at, acknowledged, kind, key, severity, title, message";

    /// <summary>Opens an alert unless one with the same system, kind and key is already open. Returns the new alert, or null.</summary>
    public AlertDto? OpenAlert(string systemId, string kind, string key, string severity, string title, string message, long now)
    {
        using var c = Open();
        using var check = c.CreateCommand();
        check.CommandText = "SELECT 1 FROM alerts WHERE system_id = $system AND kind = $kind AND key = $key AND resolved_at IS NULL LIMIT 1;";
        check.Parameters.AddWithValue("$system", DbIdOf(systemId));
        check.Parameters.AddWithValue("$kind", kind);
        check.Parameters.AddWithValue("$key", key);
        if (check.ExecuteScalar() is not null) return null;

        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            INSERT INTO alerts (system_id, opened_at, kind, key, severity, title, message)
            VALUES ($system, $now, $kind, $key, $severity, $title, $message)
            RETURNING id;
            """;
        cmd.Parameters.AddWithValue("$system", DbIdOf(systemId));
        cmd.Parameters.AddWithValue("$now", now);
        cmd.Parameters.AddWithValue("$kind", kind);
        cmd.Parameters.AddWithValue("$key", key);
        cmd.Parameters.AddWithValue("$severity", severity);
        cmd.Parameters.AddWithValue("$title", title);
        cmd.Parameters.AddWithValue("$message", message);
        var id = (long)cmd.ExecuteScalar()!;
        return new AlertDto(id, systemId, now, null, false, kind, key, severity, title, message);
    }

    /// <summary>Resolves the open alert with this system, kind and key. Returns it, or null if none was open.</summary>
    public AlertDto? ResolveAlert(string systemId, string kind, string key, long now)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"""
            UPDATE alerts SET resolved_at = $now
            WHERE system_id = $system AND kind = $kind AND key = $key AND resolved_at IS NULL
            RETURNING {AlertColumns};
            """;
        cmd.Parameters.AddWithValue("$now", now);
        cmd.Parameters.AddWithValue("$system", DbIdOf(systemId));
        cmd.Parameters.AddWithValue("$kind", kind);
        cmd.Parameters.AddWithValue("$key", key);
        using var r = cmd.ExecuteReader();
        return r.Read() ? ReadAlert(r) : null;
    }

    /// <summary>Resolves every open alert of a system (e.g. one that is no longer connected). Returns them.</summary>
    public List<AlertDto> ResolveAllAlerts(string systemId, long now)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"""
            UPDATE alerts SET resolved_at = $now
            WHERE system_id = $system AND resolved_at IS NULL
            RETURNING {AlertColumns};
            """;
        cmd.Parameters.AddWithValue("$now", now);
        cmd.Parameters.AddWithValue("$system", DbIdOf(systemId));
        var list = new List<AlertDto>();
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(ReadAlert(r));
        return list;
    }

    public List<string> OpenAlertKeys(string systemId, string kind)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT key FROM alerts WHERE system_id = $system AND kind = $kind AND resolved_at IS NULL;";
        cmd.Parameters.AddWithValue("$system", DbIdOf(systemId));
        cmd.Parameters.AddWithValue("$kind", kind);
        var list = new List<string>();
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(r.GetString(0));
        return list;
    }

    /// <summary>Systems that have at least one open alert.</summary>
    public List<string> SystemsWithOpenAlerts()
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT DISTINCT system_id FROM alerts WHERE resolved_at IS NULL;";
        var list = new List<string>();
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(KeyOf(r.GetInt64(0)));
        return list;
    }

    public List<AlertDto> QueryAlerts(IReadOnlyCollection<string> systems, int limit)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"""
            SELECT {AlertColumns} FROM alerts
            WHERE {InSystems(cmd, systems)}
            ORDER BY (resolved_at IS NULL) DESC, opened_at DESC
            LIMIT $limit;
            """;
        cmd.Parameters.AddWithValue("$limit", limit);
        var list = new List<AlertDto>();
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(ReadAlert(r));
        return list;
    }

    public void AcknowledgeAlert(long id) =>
        ExecWith("UPDATE alerts SET acknowledged = 1 WHERE id = $id;", ("$id", id));

    public void AcknowledgeAllAlerts(IReadOnlyCollection<string> systems)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"UPDATE alerts SET acknowledged = 1 WHERE {InSystems(cmd, systems)} AND acknowledged = 0;";
        cmd.ExecuteNonQuery();
    }

    private AlertDto ReadAlert(SqliteDataReader r) => new(
        r.GetInt64(0), KeyOf(r.GetInt64(1)), r.GetInt64(2), r.IsDBNull(3) ? null : r.GetInt64(3), r.GetInt64(4) != 0,
        r.GetString(5), r.GetString(6), r.GetString(7), r.GetString(8), r.GetString(9));

    // ---------- sessions ----------

    /// <summary>Closes sessions left open by a crash or hard shutdown.</summary>
    public void CloseStaleSessions()
    {
        using var c = Open();
        Exec(c, "UPDATE sessions SET ended_at = last_seen_at WHERE ended_at IS NULL;");
    }

    public long StartSession(string systemId, long now)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "INSERT INTO sessions (system_id, started_at, last_seen_at) VALUES ($system, $now, $now) RETURNING id;";
        cmd.Parameters.AddWithValue("$now", now);
        cmd.Parameters.AddWithValue("$system", DbIdOf(systemId));
        return (long)cmd.ExecuteScalar()!;
    }

    public void TouchSession(long id, long now) =>
        ExecWith("UPDATE sessions SET last_seen_at = $now WHERE id = $id;", ("$id", id), ("$now", now));

    public void EndSession(long id, long now) =>
        ExecWith("UPDATE sessions SET last_seen_at = $now, ended_at = $now WHERE id = $id;", ("$id", id), ("$now", now));

    public List<SessionDto> QuerySessions(IReadOnlyCollection<string> systems, long fromTs)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"""
            SELECT id, system_id, started_at, last_seen_at, ended_at FROM sessions
            WHERE {InSystems(cmd, systems)} AND COALESCE(ended_at, last_seen_at) >= $from
            ORDER BY started_at DESC;
            """;
        cmd.Parameters.AddWithValue("$from", fromTs);
        var list = new List<SessionDto>();
        using var r = cmd.ExecuteReader();
        while (r.Read())
            list.Add(new SessionDto(r.GetInt64(0), KeyOf(r.GetInt64(1)), r.GetInt64(2), r.GetInt64(3), r.IsDBNull(4) ? null : r.GetInt64(4)));
        return list;
    }

    // ---------- helpers ----------

    private static bool HasColumn(SqliteConnection c, string table, string column)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT 1 FROM pragma_table_info($table) WHERE name = $column;";
        cmd.Parameters.AddWithValue("$table", table);
        cmd.Parameters.AddWithValue("$column", column);
        return cmd.ExecuteScalar() is not null;
    }

    private static void Exec(SqliteConnection c, string sql)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private void ExecWith(string sql, params (string Name, object Value)[] parameters)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in parameters)
            cmd.Parameters.AddWithValue(name, value);
        cmd.ExecuteNonQuery();
    }
}
