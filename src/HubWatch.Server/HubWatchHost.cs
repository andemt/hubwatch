using HubWatch.Alerts;
using HubWatch.Api;
using HubWatch.Config;
using HubWatch.Data;
using HubWatch.Hue;
using HubWatch.Ikea;
using HubWatch.Realtime;
using HubWatch.Stats;
using HubWatch.Systems;
using Serilog;
using Serilog.Events;
using Serilog.Formatting.Compact;

namespace HubWatch;

/// <summary>
/// Builds the HubWatch web application (services, logging, middleware and endpoints). Shared by the console entry
/// point in Program.cs and the Windows desktop host in Desktop/.
/// </summary>
public static class HubWatchHost
{
    public static WebApplication Build(string[] args)
    {
        // When published, the web UI (wwwroot) lives next to the executable, not in the current directory.
        var publishedRoot = Directory.Exists(Path.Combine(AppContext.BaseDirectory, "wwwroot")) ? AppContext.BaseDirectory : null;

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            Args = args,
            ContentRootPath = publishedRoot,
        });

        // Logging: Serilog to the console (dev terminal) and to one dated file per day in the data folder's logs/,
        // kept for a configurable number of days (config.json -> "logging"; not in the UI yet).
        var logPaths = new AppPaths(builder.Configuration);
        var logSettings = ConfigStore.ReadLogSettings(logPaths.ConfigFile);
        const string logTemplate = "{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz} [{Level:u3}] {SourceContext}: {Message:lj}{NewLine}{Exception}";
        builder.Logging.ClearProviders();
        builder.Services.AddSerilog(cfg =>
        {
            cfg.MinimumLevel.Information()
                .MinimumLevel.Override("Microsoft.AspNetCore", LogEventLevel.Warning)
                .Enrich.FromLogContext()
                .WriteTo.Console(outputTemplate: logTemplate);

            if (logSettings.Enabled)
                // The file gets structured CLEF JSON (one object per line); the console stays human-readable text above.
                cfg.WriteTo.File(
                    new RenderedCompactJsonFormatter(),
                    Path.Combine(logPaths.LogDir, "hubwatch-.log"),
                    rollingInterval: RollingInterval.Day,
                    retainedFileTimeLimit: logSettings.RetentionDays > 0 ? TimeSpan.FromDays(logSettings.RetentionDays) : null,
                    retainedFileCountLimit: null);
        });

        builder.Services.AddSingleton<AppPaths>();
        builder.Services.AddSingleton<ConfigStore>();
        builder.Services.AddSingleton<Database>();
        builder.Services.AddSingleton<EventBroadcaster>();
        builder.Services.AddSingleton<SystemRegistry>();
        // One adapter per kind of system. Add new kinds here.
        builder.Services.AddSingleton<ISystemAdapter, HueAdapter>();
        builder.Services.AddSingleton<ISystemAdapter, DirigeraAdapter>();
        builder.Services.AddSingleton<SystemSupervisor>();
        builder.Services.AddHostedService(sp => sp.GetRequiredService<SystemSupervisor>());
        builder.Services.AddSingleton<StatsService>();
        builder.Services.AddSingleton<AlertService>();
        builder.Services.AddHostedService(sp => sp.GetRequiredService<AlertService>());

        var app = builder.Build();

        app.UseLocalRequestGuard();
        app.UseDefaultFiles();
        app.UseStaticFiles();
        app.MapHubWatchApi();
        app.MapFallbackToFile("index.html");

        return app;
    }

    /// <summary>The address a browser on this computer should open, once the app has started.</summary>
    public static string BrowserUrl(WebApplication app) =>
        app.Urls.FirstOrDefault()?.Replace("0.0.0.0", "localhost").Replace("[::]", "localhost").Replace("+", "localhost")
        ?? "http://localhost:5080";
}
