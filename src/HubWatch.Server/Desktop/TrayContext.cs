using System.Windows.Forms;

namespace HubWatch.Desktop;

/// <summary>
/// The tray icon and the application's lifetime: closing the window only hides it (recording continues); the app
/// exits from the tray menu or when Windows shuts down.
/// </summary>
internal sealed class TrayContext : ApplicationContext
{
    private readonly MainForm _form;
    private readonly NotifyIcon _tray;
    private bool _exiting;
    private bool _backgroundHintShown;

    public TrayContext(MainForm form, string url, bool startMinimized)
    {
        _form = form;

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open HubWatch", null, (_, _) => _form.ShowWindow());
        menu.Items.Add("Open in browser", null, (_, _) => ExternalLinks.Open(url));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit HubWatch", null, (_, _) => Exit());

        _tray = new NotifyIcon
        {
            Icon = AppIcon.Small(),
            Text = "HubWatch",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _tray.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) _form.ShowWindow();
        };

        _form.FormClosing += OnFormClosing;
        // Closed for another reason (Windows shutting down, sign-out): end the app as well.
        _form.FormClosed += (_, _) =>
        {
            _exiting = true;
            _tray.Visible = false;
            ExitThread();
        };

        // Create the window handle up front so other threads can BeginInvoke on the form even while it is hidden.
        _ = _form.Handle;
        if (!startMinimized) _form.ShowWindow();
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_exiting || e.CloseReason != CloseReason.UserClosing) return;

        // The close button hides the window; HubWatch keeps recording in the background.
        e.Cancel = true;
        _form.Hide();
        if (!_backgroundHintShown)
        {
            _backgroundHintShown = true;
            _tray.ShowBalloonTip(5000, "HubWatch is still recording",
                "HubWatch keeps running in the background. Use this icon to open it again or to exit.", ToolTipIcon.Info);
        }
    }

    private void Exit()
    {
        if (_exiting) return;
        _exiting = true;
        _tray.Visible = false;
        if (!_form.IsDisposed) _form.Close();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _tray.ContextMenuStrip?.Dispose();
            _tray.Dispose();
        }
        base.Dispose(disposing);
    }
}
