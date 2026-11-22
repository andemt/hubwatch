// HubWatch for macOS: a menu bar app that runs the HubWatch server (bundled in Contents/Resources/server) as a child
// process and shows the UI in its own window. Closing the window keeps HubWatch recording in the menu bar, because the
// bridge keeps no history of its own. Built by packaging/macos/build-app.sh; see CONTRIBUTING.md.
import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
