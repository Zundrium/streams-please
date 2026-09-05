# StreamsPlease

StreamsPlease is a local Tauri v2 desktop player for legal or personally owned BitTorrent media. A native Rust engine downloads torrent pieces, a local-only HTTP endpoint serves seekable byte ranges, and mpv plays MKV/MP4 files with embedded audio and subtitle tracks.

## Features

- magnet links through trackers, DHT, and standard BitTorrent peers;
- automatically opening the largest video file in a torrent;
- immediate streaming and seek priority through HTTP range requests;
- MKV, 10-bit video, and hardware decoding through mpv;
- embedded ASS/SSA/SRT subtitles and multiple audio tracks;
- adding external `.ass`, `.ssa`, `.srt`, `.vtt`, and `.sub` files;
- live download, upload, and peer status, plus pausing P2P and stopping the session;
- a local media cache in the OS-specific app cache directory;
- AniList-first seasonal browsing with previous/next season navigation;
- global AniList title search with SubsPlease archive availability checks and archive-only fallback;
- direct SubsPlease archive browsing without an AniList dependency;
- SubsPlease availability filtering, weekly release times, and historical episode access;
- Discord-capturable YouTube trailer search through the same in-process libmpv player;
- signed startup updates from private GitHub releases;
- a browser preview mode for UI development without native Tauri APIs.

## Architecture

```text
SvelteKit UI + Lily components (Tauri WebView)
  ├─ catalog proxy ───> AniList seasonal catalog + SubsPlease availability/releases
  ├─ Tauri commands ──> librqbit session ──> trackers / DHT / peers
  ├─ player controls ─> in-process libmpv playback ──> episodes + trailers
  ├─ trailer search ───> bundled yt-dlp + Deno ──> first YouTube result
  └─ media URL ───────> 127.0.0.1:<random>/torrents/:id/stream/:file
```

The stream server binds exclusively to `127.0.0.1`, selects a random available port on every launch, and exposes read-only routes only. Mutations are handled through protected Tauri commands.

## Requirements

- Node.js 24 or newer (including the built-in TypeScript regression test runner);
- the current stable Rust toolchain;
- the Tauri v2 platform prerequisites (on Windows: WebView2 and MSVC build tools);
- the bundled libmpv, yt-dlp, and Deno runtimes in `src-tauri/lib` (included in this checkout for Windows x86-64).

StreamsPlease loads libmpv into `streamsplease.exe` instead of playing media in a WebView iframe or launching a separate player process. This keeps episode and trailer audio in StreamsPlease's Windows audio session so application-window streaming tools such as Discord can capture it reliably. yt-dlp and Deno are only used to resolve trailer media URLs; they do not render or output audio.

## Development

```powershell
npm install
npx tauri-plugin-libmpv-api setup-lib # only needed if src-tauri/lib is absent
npm run tauri dev
```

To open the browser preview only:

```powershell
npm run dev
```

Checks:

```powershell
npm run check
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

The frontend uses Svelte 5/SvelteKit in SPA mode with the static adapter. All interactive
controls and surfaces come from the locally installed Lily component source in
`src/lib/components/ui`; `components.json` stores the Lily CLI configuration.

Playback uses `tauri-plugin-libmpv` and its MPL-2.0 wrapper. The Windows runtime is an LGPL libmpv build and is bundled from `src-tauri/lib`; Tauri copies that directory, including the pinned trailer resolver, into desktop packages. The frontend serializes initialization and retries once if the native player instance is recreated.

To build a desktop bundle with updater artifacts, provide the Tauri signing key and private-repository token through the process environment:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = 'C:\path\to\streamsplease.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
$env:STREAMSPLEASE_GITHUB_TOKEN = (Get-Content 'C:\path\to\github-token.txt' -Raw).Trim()
npm run tauri build
```

The public updater key is bundled in `src-tauri/tauri.conf.json`. Keep the corresponding private key outside the repository and configure it as the `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret. Configure `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` too when the key is password-protected.

Set `STREAMSPLEASE_GITHUB_TOKEN` as a GitHub Actions secret containing a fine-grained token limited to `Zundrium/streams-please` with **Contents: read** permission. Release builds compile that token into the executable so startup checks need no user configuration. GitHub has no releases-only permission, and anyone with the executable can extract the token and read the private repository. Revoking or expiring it also prevents existing builds from downloading later updates. The Windows release workflow signs the installers and publishes `latest.json`; the app verifies, passively installs, and restarts for newer releases.

## Usage

1. Start StreamsPlease and paste a magnet link.
2. Select **Open torrent**. StreamsPlease chooses the largest video file and prioritizes media and subtitles.
3. Switch embedded audio and subtitles through the player or details panel.
4. Use **External subtitle** to add a local subtitle file.
5. Pause P2P or stop the session when you are done. Stopping forgets the torrent but preserves cache files that have already been written.

The **Search** tab searches AniList across seasons and checks each result against the
SubsPlease archive. Possible matches are labeled for review and never saved as confirmed
AniList identities. If AniList is unavailable or has no results, matching archive titles remain
accessible without pretending their metadata has been verified.

The **SubsPlease** tab starts with an AniList season and filters it against the SubsPlease
show archive. Use the previous and next controls to browse other seasons, or choose **Archive**
to browse SubsPlease directly, including when AniList is unavailable. AniList IDs are
the canonical identity for saved shows; the optional SubsPlease slug and numeric ID are
retained only for weekly timing and episode retrieval. Selecting an episode passes the
chosen magnet link to the same local player flow.

Select a trailer from Discovery, Library, or SubsPlease details to open it in StreamsPlease's native player. The desktop app asks yt-dlp for the first YouTube result matching `<series title> trailer English subtitles`; AniList's trailer remains the browser-preview fallback. Discovery trailers start inside the page's trailer frame and can be expanded with the theater or full-screen controls. Closing a trailer restores the active episode at its previous position and leaves it paused.

The **Legal Sintel demo** button enters a Creative Commons/open movie torrent so you can test the flow without commercial content.

## Source organization

- `src/lib/components/app/`: app orchestration, navigation, window controls, and updates.
- `src/lib/components/catalog/`: Search, Discovery, SubsPlease, show details, and shared catalog components.
- `src/lib/components/{library,player,settings,shared}/`: feature UI and reusable presentation.
- `src/lib/components/ui/`: locally owned Lily primitives.
- `src/lib/catalog/`: typed request client, validated storage, title matching, and cancellable page state.
- `src/lib/backend.ts` and `src/lib/backend/preview.ts`: desktop invocation and deterministic preview fixtures.
- `src-tauri/src/catalog/`: independent AniList and SubsPlease providers, validators, and unit tests.
- `src-tauri/src/lib.rs`: torrent engine, loopback stream server, runtime setup, and command registration.
- `tests/`: Node regression tests for matching, caches, async state, preview identity, and library refresh.

Catalog calls share bounded caches and concurrency limits. AniList requests are paced and stop
sending during a 403 access block or 429 cooldown; a retry never attempts to bypass restrictions.
Provider errors remain distinct from empty results. Recently saved seasons/archive data can be
shown with a warning during an outage, and library episode refresh skips optional AniList metadata.
The former fuzzy provider-map cache is intentionally not reused; saved library data is preserved.
Browser preview catalog data is deterministic and isolated from desktop caches. Remote artwork and
trailer embeds still need network access; preview episode buttons use the legal Sintel fixture.

## Known limitations

- An AniList outage can prevent fresh global search, seasonal Discovery, or optional metadata enrichment. Direct SubsPlease archive browsing and saved library episodes remain available when SubsPlease is reachable.

- The bundled libmpv integration is currently tested most thoroughly on Windows x86-64; macOS and Linux builds need platform-specific libmpv libraries.
- In this initial version, the UI manages one active episode at a time; the Rust engine can manage multiple torrents.
- Clearing the cache and configuring the download directory do not have a UI yet.
- Tracker reach and startup speed depend on available peers and network or firewall settings.

Use StreamsPlease only for content you are authorized to access. BitTorrent generally also uploads received pieces to other peers while the session is active.
