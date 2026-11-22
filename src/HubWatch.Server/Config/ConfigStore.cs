using System.Text.Json;

namespace HubWatch.Config;

/// <summary>
/// One connected system.
/// </summary>
/// <param name="Id">Stable id used everywhere (database, API, UI), e.g. "hue-ecb5fafffeb1b99d".</param>
/// <param name="Kind">Which adapter handles it, e.g. "hue".</param>
/// <param name="Address">Host or IP address on the local network.</param>
/// <param name="NativeId">The system's own id (for Hue: the bridge id).</param>
/// <param name="Credential">Secret used to talk to the system (for Hue: the application key). Never log it.</param>
/// <param name="CertPin">
/// SHA-256 of the system's TLS public key (SubjectPublicKeyInfo, base64), pinned on first use. Null until the first
/// connection; after that a different key is refused, so a device impersonating the bridge cannot get the credential.
/// </param>
public sealed record SystemConfig(string Id, string Kind, string Address, string? NativeId, string? Name, string Credential,
    string? CertPin = null);

public sealed record AlertSettings
{
    public bool LowBatteryEnabled { get; init; } = true;
    public int LowBatteryPercent { get; init; } = 20;
    public bool DeviceUnreachableEnabled { get; init; } = true;
    /// <summary>How long a device must be unreachable before alerting (avoids alerts for brief blips).</summary>
    public int DeviceUnreachableMinutes { get; init; } = 10;
    public bool SystemUnreachableEnabled { get; init; } = true;
    public int SystemUnreachableMinutes { get; init; } = 5;
    /// <summary>Optional ntfy topic URL (e.g. https://ntfy.sh/my-secret-topic) for phone notifications.</summary>
    public string? NtfyUrl { get; init; }
}

public sealed record LogSettings
{
    /// <summary>Write a dated log file per day to the data folder's logs/ directory.</summary>
    public bool Enabled { get; init; } = true;

    /// <summary>Delete log files older than this many days. 0 or less keeps them forever.</summary>
    public int RetentionDays { get; init; } = 10;
}

public sealed class AppConfig
{
    public List<SystemConfig> Systems { get; set; } = [];
    public AlertSettings Alerts { get; set; } = new();
    public LogSettings Logging { get; set; } = new();
}

/// <summary>Persists app configuration (connected systems with their credentials, alert settings) as JSON.</summary>
public sealed class ConfigStore
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly string _path;
    private readonly Lock _lock = new();
    private readonly AppConfig _current;

    public ConfigStore(AppPaths paths, ILogger<ConfigStore> logger)
    {
        _path = paths.ConfigFile;
        _current = Load(logger);
        EnsureComplete();
    }

    // Rewrites config.json when it is missing newly added sections (e.g. logging), so their defaults become
    // visible and editable in the file. A no-op when the file already matches the current shape.
    private void EnsureComplete()
    {
        try
        {
            if (File.Exists(_path) && JsonSerializer.Serialize(_current, Options) != File.ReadAllText(_path))
                lock (_lock) Save();
        }
        catch (Exception)
        {
            // best effort; logging still works from defaults
        }
    }

    public IReadOnlyList<SystemConfig> Systems
    {
        get { lock (_lock) return [.. _current.Systems]; }
    }

    public AlertSettings Alerts
    {
        get { lock (_lock) return _current.Alerts; }
    }

    public LogSettings Logging
    {
        get { lock (_lock) return _current.Logging; }
    }

    /// <summary>
    /// Reads just the logging settings from config.json. Used at startup to set up logging before the host
    /// (and this store) are built; falls back to defaults when the file is missing or unreadable.
    /// </summary>
    public static LogSettings ReadLogSettings(string configFile)
    {
        try
        {
            if (File.Exists(configFile))
                return JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(configFile), Options)?.Logging ?? new();
        }
        catch (Exception)
        {
            // fall back to defaults
        }
        return new();
    }

    public void SetAlerts(AlertSettings alerts)
    {
        lock (_lock)
        {
            _current.Alerts = alerts;
            Save();
        }
    }

    /// <summary>Adds the system, or replaces the one with the same id.</summary>
    public void SaveSystem(SystemConfig system)
    {
        lock (_lock)
        {
            var index = _current.Systems.FindIndex(s => s.Id == system.Id);
            if (index >= 0) _current.Systems[index] = system;
            else _current.Systems.Add(system);
            Save();
        }
    }

    public bool RemoveSystem(string id)
    {
        lock (_lock)
        {
            if (_current.Systems.RemoveAll(s => s.Id == id) == 0) return false;
            Save();
            return true;
        }
    }

    // Must be called with _lock held.
    private void Save()
    {
        {
            var tmp = _path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(_current, Options));
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(tmp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            File.Move(tmp, _path, overwrite: true);
        }
    }

    private AppConfig Load(ILogger logger)
    {
        try
        {
            if (File.Exists(_path))
                return JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(_path), Options) ?? new AppConfig();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not read config file {Path}", _path);
        }
        return new AppConfig();
    }
}
