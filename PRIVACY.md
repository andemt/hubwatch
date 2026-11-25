# HubWatch privacy policy

Effective: 22 November 2026

HubWatch is a free app published by EmpaEmpa that records and shows what happens in your smart home (Philips Hue bridges and IKEA DIRIGERA hubs). This policy applies to HubWatch on all platforms, including the version in the Microsoft Store.

## In short

HubWatch runs on your own computer. Everything it records stays there. We (the developer) do not collect, receive or sell any data about you or your home. HubWatch has no accounts, no analytics, no advertising and no tracking.

## What HubWatch stores on your computer

In its data folder (see [Where is my data?](README.md#where-is-my-data); in the Microsoft Store version Windows keeps it inside the app's package folder), HubWatch stores:

- **Settings** (`config.json`): the address of each hub you connect, the access key the hub issues to HubWatch when you pair it, and your HubWatch settings, such as alert options.
- **History** (`hubwatch.db`): events and readings from your hubs, for example when lights, sensors and switches change, battery levels, connectivity, and the names of your devices, rooms and scenes.
- **Log files** (`logs/`): technical messages for troubleshooting, kept for 10 days by default.
- **Window data** (Windows desktop app only, `WebView2/`): the built-in browser view's cache and settings.

This data is never sent to us. You can delete it at any time: remove a system in HubWatch's settings and choose to delete its history as well, or delete the whole data folder. Uninstalling the Microsoft Store version also removes its data folder.

## Network connections

HubWatch connects only to:

- **Your hubs on your local network**, to read their devices and events and to carry out the actions you choose in the app.
- **The Philips Hue discovery service** (`discovery.meethue.com`, run by Signify), only when you search for a Hue Bridge. It returns the addresses of Hue bridges on your network. Like any web request, it reveals your public IP address to Signify; HubWatch sends no other information. [Signify's privacy notice](https://www.philips-hue.com/en-us/support/legal/privacy-policy) applies.
- **An ntfy server**, only if you turn on phone notifications and enter an ntfy address. HubWatch then sends the text of each alert (for example a device name and "battery low") to the server you entered, such as `ntfy.sh`. That server's privacy policy applies.

HubWatch serves its user interface from your own computer (`http://localhost:5080` by default). It is not reachable from other devices unless you change that setting yourself. Links to other websites open in your web browser.

## Microsoft Store and Windows

If you install HubWatch from the Microsoft Store, Microsoft handles the download, installation and updates, and may collect data about that under the [Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement). The Windows desktop app shows its interface with Microsoft Edge WebView2, which is part of Windows and follows the same statement and your Windows diagnostic data settings. HubWatch does not send the data it records to Microsoft.

## Children

HubWatch does not collect personal information from anyone, including children.

## Changes

If this policy changes, the new version will be published here with a new effective date. The full history is in this repository.

## Contact

Questions about privacy: open an issue at <https://github.com/andemt/hubwatch/issues>.
