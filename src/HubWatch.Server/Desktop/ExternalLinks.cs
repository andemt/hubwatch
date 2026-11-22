using System.Diagnostics;

namespace HubWatch.Desktop;

internal static class ExternalLinks
{
    /// <summary>Opens a web or mail link with the user's default app. Other schemes are ignored.</summary>
    public static void Open(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var target)
            || (target.Scheme != Uri.UriSchemeHttp && target.Scheme != Uri.UriSchemeHttps && target.Scheme != Uri.UriSchemeMailto))
            return;

        try
        {
            Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception)
        {
            // No default browser configured; nothing sensible to do.
        }
    }
}
