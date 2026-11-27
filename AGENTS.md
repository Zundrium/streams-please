# StreamsPlease agent guide

## Product and priorities

StreamsPlease is a local-first Windows desktop player for legal or personally owned BitTorrent media. The production app is a Tauri v2 shell with a SvelteKit SPA, a Rust/librqbit backend, an in-process libmpv renderer, a loopback-only HTTP range server, and a watch-together room endpoint that exists only while a room is open.

Prioritize, in order:

1. native-process safety at the libmpv/plugin FFI boundary;
2. local-only and least-privilege behavior;
3. correct playback, torrent, and catalog state;
4. browser-preview parity for UI work;
5. focused, maintainable changes.

Do not replace in-process libmpv with WebView playback or an external player process without an explicit product decision. Keeping video and audio in StreamsPlease's Windows process is required for application-window capture.

## Host environment

This checkout lives on the Windows filesystem and targets Windows. Edit from WSL if useful, but run Node, Rust, and Tauri commands with Windows-native tools so dependencies and artifacts stay platform-consistent.

From WSL:

```bash
project_win="$(wslpath -w "$PWD")"
pwsh.exe -NoProfile -Command "Set-Location -LiteralPath '$project_win'; npm run check"
```

Apply the same pattern to other commands below.

- Do not mix Linux and Windows `node_modules`, Cargo targets, or native binaries.
- Preserve LF line endings as configured by `.gitattributes`.
- Do not rerun the libmpv setup command, replace bundled runtimes, or modify Git LFS binaries unless the task explicitly requires it.
- Never discard unrelated working-tree changes. Inspect `git status` before editing.

## Source map

- `src/routes/`: static, client-only SvelteKit entry points. SSR is disabled.
- `src/lib/components/app/StreamsPleaseApp.svelte`: app orchestration, native-player lifecycle, torrent playback, and top-level state.
- `src/lib/components/{catalog,library,settings}/*Page.svelte`: feature-level UI.
- `src/lib/components/ui/`: locally installed Lily component source.
- `src/lib/backend/commands.ts`: typed Tauri command contract (names, arguments, results).
- `src/lib/backend.ts`, `src/lib/backend/preview.ts`: Tauri invocation boundary and deterministic browser-preview fixtures; the preview handler map must cover every command.
- `src/lib/types.ts`: shared frontend contracts for Rust responses and UI state.
- `src/lib/catalog/`: shared request client, cancellable page state, AniList/SubsPlease matching, and validated browser caches.
- `src/lib/library.ts`, `src/lib/library-import.ts`, `src/lib/settings.ts`: local persistence, identity-safe library reducers, and domain helpers.
- `src/lib/torrent/`: pure torrent/media helpers and the serialized `TorrentSession`.
- `src/lib/player/`: `MpvClient` (all libmpv access; property formats are fixed per method), `StreamLifecycle`, episode stream opening, `SeekScheduler`, next-episode planning, shortcuts, and viewport helpers. Keep these free of Svelte and Tauri imports other than types so they stay unit-testable in Node.
- `src/lib/room/`: watch-together sync core (`protocol.ts`, `clock.ts`, `readiness.ts`, `reconcile.ts`, `host-controller.ts`, `guest-controller.ts`), the backend `transport.ts`, and the reactive `session.svelte.ts`. Apart from the session, keep these free of Svelte and Tauri imports other than types.
- `src/lib/components/room/`: `RoomPanel`, `RoomRoster`, and `RoomStatusPill`.
- `src/lib/backend/preview-room.ts`: simulated room behind the six room commands in browser preview.
- `src/lib/async/`: shared `Generation`, `SerialQueue`, polling, and `OperationTracker` primitives for stale-work protection.
- `src/lib/library-store.svelte.ts`: reactive library state with injectable persistence.
- `src/app.css`: Tailwind v4 entry point, Lily tokens, and global media/motion behavior.
- `src-tauri/src/lib.rs`: plugin setup and Tauri command registration.
- `src-tauri/src/torrent.rs`: librqbit state, torrent commands, and the local stream server.
- `src-tauri/src/room/`: iroh endpoint, invite codes, admission, frame codec, message validation, rate limits, fan-out, and the room commands. It knows roles, not playback.
- `src-tauri/src/runtime.rs`, `src-tauri/src/library_file.rs`: bundled-runtime discovery and library file import/export.
- `src-tauri/src/catalog/`: provider adapters, the shared provider HTTP layer (`http.rs`), identity resolution, input validation, parsers, and provider tests.
- `tests/`: frontend catalog, library, player, and room regression tests using Node 24's built-in test runner; `tests/room-fakes.ts` holds the fake clock, transport, and player.
- `src-tauri/tauri.conf.json`: window, CSP, bundle resources, and frontend build integration.
- `src-tauri/capabilities/default.json`: Tauri permissions.
- `src-tauri/lib/`: pinned Windows libmpv and trailer-resolver runtimes; binaries are stored with Git LFS.

`src-tauri/gen/`, `.svelte-kit/`, `dist/`, `node_modules/`, and `src-tauri/target/` are generated. Do not edit or commit them.

`src-tauri/vendor/tauri-plugin-mpv/` is not the active player dependency. The app currently uses crates.io `tauri-plugin-libmpv` 0.3.2 and npm `tauri-plugin-libmpv-api` 0.3.2. Do not patch the vendored plugin expecting runtime behavior to change.

## Architecture invariants

- The torrent HTTP server must remain bound to `127.0.0.1` on an ephemeral port and must remain read-only. Mutations belong in Tauri commands.
- The room endpoint is the only listener that other machines can reach, as a deliberate, scoped exception. It exists only while hosting or joined, serves only the room ALPN, and carries control messages only. No media and no file paths cross it.
- Every room message is validated in Rust in both directions and narrowed from `unknown` in TypeScript.
- Guests never control playback. The host is the only writer of room state.
- Room sync uses existing `MpvCommands` methods only. Do not add an mpv property, format, or command for it.
- A wire change to the room protocol gets a new ALPN version.
- Keep Tauri capabilities and CSP as narrow as possible. Add origins or permissions only for a concrete feature.
- Treat magnets, provider HTML/JSON, local paths, media metadata, and IPC arguments as untrusted input. Validate before use.
- AniList IDs are the canonical identity for library entries. SubsPlease slugs and numeric IDs are provider metadata, not the primary identity.
- The desktop backend is the production network and torrent boundary. `backend.ts` must keep browser preview usable with representative mocks.
- If a Tauri command contract changes, update all affected parts together: Rust command/registration, `backend/commands.ts`, browser mock behavior, and `types.ts`.
- Preserve graceful provider failure and cached/fallback behavior. External catalog availability must not make the whole app unusable.
- Keep persisted data backward-compatible. Parse and normalize `localStorage` data rather than assuming it matches the newest type.

## Frontend conventions

- Use Svelte 5 runes and TypeScript: `$props`, `$state`, `$derived`, and `$effect`.
- Keep strict types at boundaries. Prefer `unknown` plus narrowing over introducing new `any` values.
- Use `$lib` aliases instead of deep relative imports.
- Keep native calls behind `callBackend`. Route every libmpv call through `MpvClient`/`MpvCommands`; add a typed method there instead of calling the plugin directly.
- Preserve operation generations, cleanup functions, and timeout cancellation around asynchronous playback. Stale async work must not mutate a replacement torrent or trailer session.
- Node's test runner strips types without transpiling, so new `.ts` modules must avoid TypeScript-only runtime syntax such as constructor parameter properties and enums.
- Avoid expanding `StreamsPleaseApp.svelte` with unrelated presentation logic. Extract a component or pure domain helper when it gives a clear ownership boundary.
- Use the local Lily design system in `src/lib/components/ui` and existing Tailwind tokens before creating custom primitives. Use `@lucide/svelte` for icons.
- Match the established visual language and support keyboard use, focus states, labels, loading, empty, and error states.
- Use `RevealImage`/`RevealFrame` for remote media where the existing reveal behavior applies. Respect reduced-motion behavior.
- Match nearby formatting; no formatter is configured. Do not reformat unrelated code.
- Do not add code comments unless requested. Prefer descriptive code and focused tests.

## Rust and Tauri conventions

- Validate command inputs before constructing URLs, touching the filesystem, or calling librqbit.
- Return actionable `Result<_, String>` errors across IPC; do not panic for recoverable command failures.
- Keep blocking work off async execution paths. Preserve request timeouts and local-only server behavior.
- Register new commands in `tauri::generate_handler!` and add the corresponding frontend contract and preview behavior.
- Add narrow unit tests beside the existing `#[cfg(test)]` module for validators, parsers, matching, and other pure logic.
- Update `Cargo.lock` only when Rust dependencies intentionally change. Update `package-lock.json` only when npm dependencies intentionally change.

## Critical libmpv FFI rules

A Windows exit such as

```text
process didn't exit successfully: target\debug\streamsplease.exe
(exit code: 0xc0000005, STATUS_ACCESS_VIOLATION)
```

is a native memory-access crash, not a recoverable Svelte, JavaScript, or ordinary Rust error. Treat the most recent libmpv/plugin FFI call as the primary suspect.

Mandatory rules:

- Never call `getProperty(..., 'node')`. The bundled wrapper's `MPV_FORMAT_NODE` getter is unsafe and has caused this crash.
- In particular, never directly read `track-list` as a node. Observe it with `observeProperties` and consume the node data delivered to the observation callback.
- After changing an audio or subtitle track, update UI state optimistically and reconcile from the next observed `track-list` event. Do not immediately re-read it.
- Set `sid` and `aid` with string values through `setProperty`, including numeric IDs such as `'3'` and the special value `'no'`. JavaScript numbers are converted to an mpv double, while these properties require an integer-like choice.
- Match every mpv property to the wrapper's exact native format and argument representation. Do not infer safety from TypeScript types.
- Do not add retries around a suspected unsafe FFI operation. An access violation cannot be caught or recovered from in application code.
- A retry is acceptable only for the already-understood missing/recreated player-instance path, not as a general FFI recovery mechanism.
- Do not assume `npm run check` or a web build proves native playback is safe.

When the crash returns:

1. identify the last mpv command or property operation added or executed;
2. remove direct node reads and rely on observed property events;
3. verify formats and argument types against mpv and the active wrapper source;
4. reproduce the smallest affected flow in the Windows Tauri app before changing unrelated playback code;
5. run static checks, then manually exercise the exact native action again.

## Validation

Use Windows-native commands from the repository root.

Frontend checks:

```powershell
npm run check
npm test
npm run build
```

Rust checks:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Manual modes:

```powershell
npm run dev
npm run tauri dev
```

Validation expectations:

- Frontend-only logic or UI: run `npm run check` and `npm run build`; inspect the browser preview when behavior is visual.
- Rust/backend changes: run Rust formatting, tests, and check, plus frontend checks when the IPC contract is affected.
- Playback, libmpv, window-margin, track, trailer, seek, or native-runtime changes: also test the exact flow in `npm run tauri dev` on Windows.
- Room transport, sync, or room-driven playback changes: also exercise the affected flow between two machines on different networks. Two instances on one machine (a second `npm run tauri dev -- --config src-tauri/tauri.second-instance.conf.json` with its own `CARGO_TARGET_DIR`) cover the flow but not the direct path, the firewall, or real drift.
- Browser preview is useful for layout and fallback behavior, but it does not validate Tauri IPC, librqbit, iroh, in-process video, room sync quality, bundled runtimes, or FFI safety.
- If a required manual check cannot be performed, state that explicitly; do not imply it passed.

## Change discipline

- Keep changes scoped to the request and preserve existing behavior unless the task calls for a behavior change.
- Do not weaken local-only networking, validation, CSP, or Tauri permissions to make a feature easier.
- Do not edit generated files or bundled binaries as a side effect.
- Update `README.md` when setup, architecture, supported behavior, or validation commands materially change.
- Before finishing, inspect the diff, report checks run, and call out any native/manual verification still required.
