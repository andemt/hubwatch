using System.Diagnostics;
using HubWatch;

#if HUBWATCH_DESKTOP
// Windows desktop build (-p:HubWatchDesktop=true): the same server, shown in its own window with a tray icon.
// See Desktop/DesktopHost.cs.
return HubWatch.Desktop.DesktopHost.Run(args);
#else
var openBrowser = !args.Contains("--no-browser");
var app = HubWatchHost.Build(args.Where(a => a != "--no-browser").ToArray());

app.Lifetime.ApplicationStarted.Register(() =>
{
    var paths = app.Services.GetRequiredService<AppPaths>();
    var url = HubWatchHost.BrowserUrl(app);

    app.Logger.LogInformation("HubWatch is running at {Url}", url);
    app.Logger.LogInformation("Data is stored in {Dir}", paths.DataDir);

    if (openBrowser && !app.Environment.IsDevelopment() && app.Configuration.GetValue("OpenBrowser", true))
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            app.Logger.LogDebug(ex, "Could not open a browser");
        }
    }
});

app.Run();
return 0;
#endif
