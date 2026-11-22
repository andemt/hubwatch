# Contributing to HubWatch

Thanks for helping out! This guide covers how to set up a development environment, how the project is structured and how we work.

## Prerequisites

- [.NET 11 SDK](https://dotnet.microsoft.com/download)
- [Node.js 22+](https://nodejs.org/)
- [pnpm](https://pnpm.io/installation): `brew install pnpm` or `npm install -g pnpm` (Corepack is no longer bundled with Node 25+)
- A Philips Hue Bridge **or** an IKEA DIRIGERA hub on your network. There is no simulator, so features are developed and verified against real hardware.

### macOS: installing with Homebrew

[Homebrew](https://brew.sh) is the easiest way to install everything on a Mac. If you don't have it, paste this into Terminal and follow the instructions it prints (it asks for your password and may install Apple's command line tools):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

On Apple Silicon Macs, run the two `echo`/`eval` lines shown under "Next steps" at the end, so `brew` is on your PATH. Then check with `brew --version`.

Install the tools:

```bash
brew install --cask dotnet-sdk   # .NET SDK (check `dotnet --version` shows 11.x)
brew install node pnpm
```

On **Windows**, use [winget](https://learn.microsoft.com/windows/package-manager/winget/) (`winget install Microsoft.DotNet.SDK.11 OpenJS.NodeJS.LTS`, then `npm install -g pnpm`). On **Linux**, use your distribution's packages or Microsoft's install script for .NET.

## Running locally

Two terminals:

```bash
# Terminal 1: backend (API + collector) on http://localhost:5080
DOTNET_WATCH_RESTART_ON_RUDE_EDIT=1 dotnet watch --project src/HubWatch.Server --non-interactive 2>&1 | tee logs/backend.log
```

```bash
# Terminal 2: UI with hot reload on http://localhost:5173 (proxies /api to :5080)
cd src/HubWatch.Web
pnpm install
pnpm dev
```

Open <http://localhost:5173>.

- `dotnet watch` rebuilds and restarts the backend whenever a C# file is saved.
- `tee logs/backend.log` keeps a copy of all backend output, including build errors, in `logs/` (git-ignored). This lets you, a teammate or an AI assistant read errors without copying them from the terminal.

### Hot reload pitfalls

.NET hot reload sometimes *says* it applied a change when it only partly did, for example after changing a record's parameters or a small method the JIT has inlined. The symptom is that new fields are empty or old behaviour remains. **When something looks unchanged, restart the backend** (Ctrl+C and start again) before debugging further.

### Windows desktop app

On Windows, users get HubWatch in its own window (WebView2) with a tray icon instead of a console and a browser. It is the same server, started in-process by `Desktop/DesktopHost.cs`, and is only compiled when you pass `-p:HubWatchDesktop=true`:

```powershell
cd src/HubWatch.Web; pnpm build; cd ../..   # the window shows the built UI from wwwroot
dotnet run --project src/HubWatch.Server -p:HubWatchDesktop=true
```

Closing the window only hides it; exit from the tray icon. `--minimized` starts in the tray. Starting it a second time brings the running window forward. Normal development (`dotnet watch`, on any OS) is unaffected.

### Mac app

On macOS, users get `HubWatch.app`: a menu bar app with its own window (WKWebView). It is a small Swift program in `src/HubWatch.Mac/` that starts the published server, bundled in `Contents/Resources/server`, as a child process. (Swift rather than .NET for the native part: ASP.NET Core has no runtime pack for Apple's app platforms, so the server can't run inside a .NET macOS app.) If a HubWatch server already answers on port 5080, for example `brew services`, the app uses that one instead.

Build and run it on a Mac (needs Xcode or its command line tools, plus the usual .NET and pnpm):

```bash
packaging/macos/build-app.sh            # builds the UI, publishes the server, writes artifacts/macos/HubWatch.app
open artifacts/macos/HubWatch.app
```

Closing the window only hides it; quit from the menu bar icon or with ⌘Q. Server output goes to the log file in the data folder as usual. Debug the web view with Safari → Develop → HubWatch. The release workflow runs the same script with arguments (see the comment at its top) and zips the app.

### Your data

The database and config (including the bridge's application key) live in:

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/HubWatch` |
| Windows | `%LOCALAPPDATA%\HubWatch` |
| Linux | `~/.local/share/HubWatch` |

Use `--DataDir=/some/folder` to work with a separate database. Delete `hubwatch.db` to start over with an empty history.

## Project structure

```
src/
├── HubWatch.Server/        ASP.NET Core Minimal API
│   ├── Systems/               Vendor-neutral core: adapter interfaces, shared DTOs, one runtime per system,
│   │                          the supervisor that runs a collector per system and reconnects
│   ├── Hue/                   The Hue adapter: CLIP v2 client, discovery, resource cache, event interpretation,
│   │                          rooms/scenes, v1 rules
│   ├── Alerts/                Alert checks per system (battery, device unreachable, system unreachable) and ntfy
│   ├── Stats/                 Statistics computed from recorded history
│   ├── Data/                  SQLite storage (schema + queries)
│   ├── Desktop/               Windows only: window (WebView2) and tray icon around the same server
│   ├── Realtime/              Server-Sent Events to browsers
│   ├── Config/                Settings and the connected systems with their credentials (config.json)
│   └── Api/                   HTTP endpoints (Endpoints.cs) and Hue discovery/pairing (HueEndpoints.cs)
└── HubWatch.Web/           Vite + React + TypeScript UI
    └── src/
        ├── components/        One file per view or component
        ├── api.ts, types.ts   API client and the shapes it returns (mirror the C# DTOs)
        ├── stream.ts          Live updates (one shared EventSource)
        ├── icons.tsx          Icons that carry meaning (event categories, status levels)
        └── styles.css         All styles; theme via CSS variables
```

`pnpm build` writes the UI into `src/HubWatch.Server/wwwroot`, so the published app is a single process.

## Several systems

HubWatch records any number of systems at the same time. A *system* is one installation of some kind (today only
Philips Hue bridges, `kind = "hue"`), identified by a stable id such as `hue-ecb5fafffeb1b99d`. That id is used in
`config.json`, in the database, in the API and in the UI.

- **Adapters.** Each kind implements `ISystemAdapter` (connect, record, reconnect on failure) and provides an
  `ISystemResources` view (devices, rooms, automations, names) in the shared DTO shapes from `Systems/Models.cs`.
  API, alerts and statistics only use those interfaces. Register a new kind in `Program.cs`.
- **Every row belongs to a system.** `events`, `readings`, `sessions` and `alerts` carry `system_id` (→ `systems.id`,
  an internal integer). The stable id lives in `systems.key`; outside `Database` systems are only identified by that
  key, and `Database` translates. Writes name their system explicitly; reads take the set of systems to include.
- **Filtering by system.** Data endpoints accept `?systems=id1,id2`; without it they return all connected systems.
  The UI lets the user hide systems (click the status pill when there are several): the choice is stored in the
  browser (`systemFilter.ts`), sent with every data request and applied to the live stream. Hidden systems keep
  recording; at least one is always shown.
- **Every DTO carries `systemId`**, and so do Server-Sent Events. Ids of devices and resources come from the system and
  are only guaranteed unique within it.
  So the UI always identifies a device by system *and* id (`DeviceRef` in `types.ts`, e.g. when opening the device
  panel), and asks for a device's events with `systems=` set to its own system. Two systems can share ids, for
  example two entries that point at the same bridge.
- **Gaps are per system.** One system recording says nothing about another (`gapsFrom` in `sessions.ts`).
- **Removing a system** stops its collector before anything is deleted; its history is kept unless asked otherwise, and
  its open alerts are resolved.

## How the Hue side works

- **CLIP API v2** is used for everything (`/clip/v2/resource`, and the event stream at `/eventstream/clip/v2`). The legacy **v1 API** is only used for rules and schedules, which v2 does not expose.
- **The bridge keeps no history.** Everything in the app comes from listening to the event stream while the app runs. Periods between *sessions* (connected periods) are gaps and are shown as such. Statistics never assume anything about gaps.
- **"Backfill":** on connect, the bridge's "last changed" timestamps for sensors are recorded as `backfill` events if they happened while the app was not running.
- **`grouped_*` resources** (`grouped_light`, `grouped_motion`, `grouped_light_level`, …) are aggregates for a room, zone or the whole home. They duplicate device events and are hidden by default.
- **Last known state:** when a device's Zigbee status is not `connected`, the state the bridge reports is only the last one it heard. The UI marks it as "last known".
- Light level is reported as `10000 × log10(lux) + 1`. See `EventInterpreter.ToLux`.

## How the IKEA DIRIGERA side works

- **Local API**, undocumented by IKEA: REST at `https://{ip}:8443/v1` and an event **websocket** at `wss://{ip}:8443/v1`, both with `Authorization: Bearer {token}`. Self-signed certificate, so the public key is pinned on first use, exactly like Hue (`HueClient.CreateHandler`/`PinOf` are reused).
- **Pairing is PKCE.** `GET /v1/oauth/authorize` returns a code; the code must be fetched *before* the action button on the hub is pressed, then exchanged for a token at `POST /v1/oauth/token`. See `Api/IkeaEndpoints.cs`. There is no automatic discovery yet — the hub is added by IP or its `gw2-<id>.local` name.
- **The hub keeps no history** either; everything comes from the websocket while the app runs (same gap/session model as Hue).
- **One physical device, several logical ones.** DIRIGERA splits e.g. a motion sensor into `occupancySensor` + `lightSensor`, and a smart plug into `outlet` + `electricalSensor`, linked by a shared `relationId`. `IkeaResources` merges them into one device under the name the user set (IKEA pre-fills `customName` with the product name, so a real name is `customName` ≠ `model`).
- **Attributes are translated to the Hue resource types** (`light`, `motion`, `contact`, `temperature`, `light_level`, `device_power`, `zigbee_connectivity`, `button`) in `IkeaEventInterpreter`, so the UI, categories and statistics work unchanged. Only attributes that actually changed are logged; power-meter telemetry and hub churn (`sunPosition`, `homestate`, …) are treated as noise.
- **Light level** (`illuminance`) is Zigbee-encoded (`10000 × log10(lux) + 1`), the same as Hue, and is decoded with `EventInterpreter.ToLux`. The raw value is **not** lux — don't show it directly.
- Still TODO: DIRIGERA automations/scenes, energy metering from `electricalSensor`, mDNS discovery.

## Conventions

- **UI text is in English.**
- **Timestamps are Unix milliseconds (UTC)** in the database and API. Format them in the browser.
- **Schema changes** go in `Database.Initialize` and must be idempotent (`CREATE ... IF NOT EXISTS`, guarded data migrations), because there is no migration framework.
- **No reflection-heavy libraries** in the backend, to keep the door open for trimmed single-file builds.
- **Few frontend dependencies.** Charts are dependency-free SVG (`LineChart.tsx`). Think twice before adding packages.
- **Icons come from [Lucide](https://lucide.dev)** (`lucide-react`, ISC license). Don't use emoji as icons: they look different on every OS. Import icons by name (`import { Bell } from 'lucide-react'`) so only the ones used are bundled. Category and status icons go through `icons.tsx` so a choice lives in one place. Size, stroke width and colour are set globally in `styles.css` (`.lucide`: scales with the text, colour from `currentColor`), so don't pass `size`, `color` or `strokeWidth` props. Decorative icons get `aria-hidden`; an icon that carries meaning on its own gets an `aria-label`.
- **Colors come from CSS variables** so light and dark themes work. Never hard-code colors in components.
- Keep `types.ts` in sync with the C# DTOs (the API uses camelCase JSON).

## Before you open a pull request

1. `cd src/HubWatch.Web && pnpm build` passes (type check + build).
2. `dotnet build src/HubWatch.Server -c Release` passes without warnings. If you touched `Desktop/` or `Program.cs`, also build with `-p:HubWatchDesktop=true` on Windows (CI does this too).
3. You have looked at what you changed in the browser against a real bridge, in both light and dark theme, and in a narrow window (the tabs wrap below ~760 px).
4. New behaviour that users would notice is mentioned in `README.md`.

## Releasing

Push a tag such as `v0.3.0`. GitHub Actions builds self-contained single-file binaries for Windows, macOS and Linux (x64/arm64) and attaches them to a GitHub Release. The Windows build is the desktop app (window + tray icon). The release build takes its version from the tag (`v0.3.0` → `0.3.0`), which is what the app shows on the System view. `<Version>` in the `.csproj` is only used for local builds and manual workflow runs; keep it and `version` in `package.json` roughly in step so local builds don't look older than the latest release.

### Homebrew tap (macOS)

After the release, the `homebrew` job in `release.yml` writes `Formula/hubwatch.rb` (generated by `packaging/homebrew/formula.sh` with the new URLs and checksums) to the tap repository, so Mac users get the update with `brew upgrade hubwatch`. One-time setup:

1. Create a **public** repository named `homebrew-tap` under the same owner (Homebrew requires the `homebrew-` prefix; users then write `brew install <owner>/tap/hubwatch`).
2. Create a fine-grained personal access token with **Contents: read and write** on only that repository, and add it to this repository as the secret `HOMEBREW_TAP_TOKEN`.
3. Optional: a different tap repository can be set with the repository variable `HOMEBREW_TAP_REPO` (`owner/name`).

The release assets must be publicly downloadable, so this only works once this repository is public. Without the secret the job is skipped with a warning.
