using System.Drawing;
using System.Windows.Forms;

namespace HubWatch.Desktop;

/// <summary>The app icon (Desktop/hubwatch.ico, embedded), in the sizes Windows asks for.</summary>
internal static class AppIcon
{
    public static Icon Large() => Load(SystemInformation.IconSize);
    public static Icon Small() => Load(SystemInformation.SmallIconSize);

    private static Icon Load(Size size)
    {
        using var stream = typeof(AppIcon).Assembly.GetManifestResourceStream("HubWatch.ico")
                           ?? throw new InvalidOperationException("The embedded app icon is missing.");
        return new Icon(stream, size);
    }
}
