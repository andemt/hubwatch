namespace HubWatch;

/// <summary>
/// Where HubWatch stores its configuration and database.
/// Defaults to the per-user application data folder:
///   macOS:   ~/Library/Application Support/HubWatch
///   Windows: %LOCALAPPDATA%\HubWatch
///   Linux:   ~/.local/share/HubWatch
/// Override with the DataDir setting (env var DataDir or --DataDir=...).
/// </summary>
public sealed class AppPaths
{
    public string DataDir { get; }
    public string ConfigFile => Path.Combine(DataDir, "config.json");
    public string DatabaseFile => Path.Combine(DataDir, "hubwatch.db");
    public string LogDir => Path.Combine(DataDir, "logs");

    public AppPaths(IConfiguration configuration)
    {
        DataDir = configuration["DataDir"] is { Length: > 0 } custom
            ? custom
            : Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolderOption.Create),
                "HubWatch");
        Directory.CreateDirectory(DataDir);
    }
}
