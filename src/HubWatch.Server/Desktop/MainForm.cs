using System.Drawing;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HubWatch.Desktop;

/// <summary>The HubWatch window: the web UI served by this process, shown in WebView2 (Edge, built into Windows 11).</summary>
internal sealed class MainForm : Form
{
    private readonly string _url;
    private readonly Uri _origin;
    private readonly string _userDataFolder;
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };

    public MainForm(string url, string userDataFolder)
    {
        _url = url;
        _origin = new Uri(url);
        // WebView2 keeps its profile in the data folder; the install folder is read-only in an MSIX package.
        _userDataFolder = userDataFolder;

        SuspendLayout();
        Text = "HubWatch";
        Icon = AppIcon.Large();
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96F, 96F);
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1280, 820);
        MinimumSize = new Size(640, 480);
        Controls.Add(_web);
        ResumeLayout(false);
    }

    /// <summary>Shows the window and brings it to the front, also when it was hidden in the tray or minimized.</summary>
    public void ShowWindow()
    {
        if (!Visible) Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        // Don't open larger than the screen the window lands on.
        var area = Screen.FromControl(this).WorkingArea;
        if (Width > area.Width || Height > area.Height)
        {
            Size = new Size(Math.Min(Width, area.Width), Math.Min(Height, area.Height));
            Location = new Point(area.Left + (area.Width - Width) / 2, area.Top + (area.Height - Height) / 2);
        }
    }

    // Shown is raised once, the first time the window appears. Starting minimized therefore doesn't load WebView2
    // until the user opens the window.
    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(browserExecutableFolder: null, userDataFolder: _userDataFolder);
            await _web.EnsureCoreWebView2Async(environment);
        }
        catch (Exception ex)
        {
            // WebView2 is part of Windows 11; if it is missing or broken, fall back to the default browser.
            var missing = ex is WebView2RuntimeNotFoundException;
            MessageBox.Show(this,
                (missing
                    ? "The Microsoft Edge WebView2 Runtime is not installed, so HubWatch opens in your web browser instead."
                    : "HubWatch could not create its window, so it opens in your web browser instead.\n\n" + ex.Message)
                + "\n\nHubWatch keeps running in the tray.",
                "HubWatch", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            ExternalLinks.Open(_url);
            Hide();
            return;
        }

        var core = _web.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
#if !DEBUG
        core.Settings.AreDevToolsEnabled = false;
#endif
        // Links that leave HubWatch (documentation, ntfy, ...) open in the default browser, not in this window.
        core.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            ExternalLinks.Open(args.Uri);
        };
        core.NavigationStarting += (_, args) =>
        {
            if (IsExternal(args.Uri))
            {
                args.Cancel = true;
                ExternalLinks.Open(args.Uri);
            }
        };

        _web.Source = new Uri(_url);
    }

    private bool IsExternal(string uri) =>
        Uri.TryCreate(uri, UriKind.Absolute, out var target)
        && (target.Scheme == Uri.UriSchemeMailto
            || ((target.Scheme == Uri.UriSchemeHttp || target.Scheme == Uri.UriSchemeHttps)
                && Uri.Compare(target, _origin, UriComponents.SchemeAndServer, UriFormat.Unescaped, StringComparison.OrdinalIgnoreCase) != 0));
}
