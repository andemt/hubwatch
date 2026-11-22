# Notes for AI coding assistants

Read `CONTRIBUTING.md` first: setup, structure, Hue specifics and conventions all apply. This file adds how to work effectively in this repo as an assistant.

## Assume the developer runs the app

The developer normally runs both processes as described in `CONTRIBUTING.md`:

- Backend: `dotnet watch` with output copied to **`logs/backend.log`**.
- Frontend: `pnpm dev` on http://localhost:5173.

You usually cannot reach the Hue Bridge or DIRIGERA hub yourself (it is on the developer's LAN), so don't try to start your own backend. Work with theirs.

## Workflow that works well

1. **Make the change.** Saving C# files makes `dotnet watch` rebuild; saving frontend files hot-reloads the UI.
2. **Check the build yourself:** read the end of `logs/backend.log` for `error CS…`, `warning`, `fail:` or exceptions instead of asking the developer to paste errors. For the frontend, a type check (`pnpm build`, or `tsc --noEmit` in `src/HubWatch.Web`) catches most mistakes.
3. **Verify the actual result, not the log message.** Hot reload can report "changes applied" while new fields stay empty (changed record shapes, inlined methods). Call the API (e.g. `GET /api/groups`) and check the data. If it is stale, force a real restart. Ask the developer to restart, or make a change that hot reload cannot apply.
4. **Look at the UI** if you have a browser tool that can open `http://localhost:5173`: check the console for errors, and check the screen in light and dark theme and at narrow widths.
5. **Report what you verified and what you could not.** If you could not compile or test something, say so plainly.

## Things to keep in mind

- The bridge has no history; never present gaps as quiet periods, and never extrapolate across them in statistics.
- Device state is "last known" when Zigbee connectivity is not `connected`.
- Keep `types.ts` and the C# DTOs in sync.
- Don't add references to other commercial Hue apps in code, docs or commit messages.
- Don't commit `logs/`, `node_modules/`, `bin/`, `obj/` or `src/HubWatch.Server/wwwroot/` (all git-ignored).
- The credentials of the user's systems (e.g. Hue application keys) live in their data folder's `config.json`. Never print, log or commit them.
