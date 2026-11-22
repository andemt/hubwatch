using System.Windows.Forms;
using Microsoft.AspNetCore.Connections;

namespace HubWatch.Desktop;

/// <summary>
/// Windows desktop entry point (built with -p:HubWatchDesktop=true). Runs the HubWatch server in this process and shows
/// the UI in its own window (WebView2) instead of the default browser. A tray icon keeps the app, and the recording,
/// running when the window is closed, because the bridge keeps no history of its own.
/// </summary>
internal static class DesktopHost
{
    // Per Windows session, so a second launch brings the running window forward instead of starting another server.
    private const string InstanceMutexName = @"Local\HubWatch.Desktop";
    private const string ShowWindowEventName = @"Local\HubWatch.Desktop.ShowWindow";

    public static int Run(string[] args)
    {
        // Windows Forms needs an STA thread; top-level statements run on an MTA thread.
        var exitCode = 0;
        var ui = new Thread(() => exitCode = RunOnUiThread(args)) { Name = "HubWatch UI" };
        ui.SetApartmentState(ApartmentState.STA);
        ui.Start();
        ui.Join();
        return exitCode;
    }

    private static int RunOnUiThread(string[] args)
    {
        using var instance = new Mutex(initiallyOwned: true, InstanceMutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            SignalRunningInstance();
            return 0;
        }
        using var showWindow = new EventWaitHandle(false, EventResetMode.AutoReset, ShowWindowEventName);

        // --minimized starts in the tray only (for starting together with Windows).
        var startMinimized = args.Contains("--minimized");
        var serverArgs = args.Where(a => a is not "--minimized" and not "--no-browser").ToArray();

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        WebApplication app;
        try
        {
            app = HubWatchHost.Build(serverArgs);
            app.StartAsync().GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            MessageBox.Show(StartupErrorText(ex), "HubWatch", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        try
        {
            var url = HubWatchHost.BrowserUrl(app);
            var paths = app.Services.GetRequiredService<AppPaths>();
            app.Logger.LogInformation("HubWatch is running at {Url}", url);
            app.Logger.LogInformation("Data is stored in {Dir}", paths.DataDir);

            using var form = new MainForm(url, Path.Combine(paths.DataDir, "WebView2"));
            using var tray = new TrayContext(form, url, startMinimized);

            // A second launch sets the event; bring this window forward.
            var registration = ThreadPool.RegisterWaitForSingleObject(showWindow,
                (_, _) =>
                {
                    try { form.BeginInvoke(form.ShowWindow); }
                    catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException) { /* shutting down */ }
                }, null, Timeout.Infinite, executeOnlyOnce: false);
            try
            {
                Application.Run(tray);
            }
            finally
            {
                registration.Unregister(null);
            }
            return 0;
        }
        finally
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            app.StopAsync(timeout.Token).GetAwaiter().GetResult();
            // Disposing flushes the log file.
            app.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
    }

    private static void SignalRunningInstance()
    {
        try
        {
            using var showWindow = EventWaitHandle.OpenExisting(ShowWindowEventName);
            showWindow.Set();
        }
        catch (WaitHandleCannotBeOpenedException)
        {
            // The other instance is still starting or just exiting; nothing to show.
        }
    }

    private static string StartupErrorText(Exception ex)
    {
        for (var e = ex; e is not null; e = e.InnerException)
        {
            if (e is AddressInUseException)
                return "HubWatch could not start because its port is already in use.\n\n" +
                       "Is HubWatch already running, for example the command-line version? Close it and try again.\n\n" +
                       ex.Message;
        }
        return "HubWatch could not start.\n\n" + ex.Message;
    }
}
