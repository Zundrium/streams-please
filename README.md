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
- a local media cache in the OS-specific app cache directory, capped at 10 GB with least-recently-watched eviction;
- automatic seeding of fully downloaded episodes until a configurable share ratio (default 1.5×), after which the episode is removed, with per-episode seeding and cache statistics under **Account settings → Seeding & cache**;
- multi-provider seasonal browsing with previous/next season navigation, using AniList, official MyAnimeList, Jikan, and Kitsu in a configurable priority order with saved-result fallback;
- global catalog title search with persistent offline results, source/age labels, and SubsPlease archive availability checks;
- direct SubsPlease archive browsing without an AniList dependency;
- SubsPlease availability filtering, weekly release times, and historical episode access;
- Discord-capturable YouTube trailer search through the same in-process libmpv player;
- airing discovery and recommendations based on loved series, with trailer previews;
- signed startup update checks from private GitHub releases, with explicit approval before downloading and installing;
- a browser preview mode for UI development without native Tauri APIs.

## Architecture

```text
SvelteKit UI + Lily components (Tauri WebView)
  ├─ catalog coordinator ──> native provider registry ──> AniList / MyAnimeList / Jikan / Kitsu
  │                              └─ persistent cross-provider identity resolver
  ├─ release catalog ────> SubsPlease availability/releases
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

Set `STREAMSPLEASE_GITHUB_TOKEN` as a GitHub Actions secret containing a fine-grained token limited to `Zundrium/streams-please` with **Contents: read** permission. Release builds compile that token into the executable so startup checks need no user configuration. GitHub has no releases-only permission, and anyone with the executable can extract the token and read the private repository. Revoking or expiring it also prevents existing builds from downloading later updates. The Windows release workflow builds a single signed NSIS installer (`StreamsPlease_<version>_x64-setup.exe`) and publishes `latest.json`; the app asks for approval before downloading, then verifies, installs, and restarts for newer releases. Choose **Later** to keep using the current version. Versions older than 0.6.0 still use their original automatic-update behavior when upgrading to this version.

## Usage

1. Start StreamsPlease and paste a magnet link.
2. Select **Open torrent**. StreamsPlease chooses the largest video file and prioritizes media and subtitles.
3. Switch embedded audio and subtitles through the player or details panel.
4. Use **External subtitle** to add a local subtitle file.
5. Starting another episode releases the previous torrent. Fully downloaded episodes keep seeding until they reach the target ratio and are then deleted; partial downloads are paused and kept so they can resume quickly. When the cache exceeds 10 GB, the least recently watched episodes that are not playing are removed first. Seeding state and upload totals survive restarts. **Account settings → Seeding & cache** can cap the total upload rate (64 KiB/s minimum, unlimited by default); the header always shows the current total download and upload speed.

The **Search** tab searches across seasons and checks each result against the SubsPlease
archive. AniList is preferred by default; reorder AniList, official MyAnimeList, Jikan, and Kitsu in **Account settings**.
The official MyAnimeList API requires your public application **Client ID**, obtained from
[MyAnimeList API settings](https://myanimelist.net/apiconfig). Enter the Client ID, not a client secret
or OAuth token. It is saved locally and sent only to native official MyAnimeList requests as
`X-MAL-CLIENT-ID`. Without it, the official adapter is skipped; Jikan remains a credential-free,
unofficial source of MyAnimeList data.
New requests use the saved order. During an outage, validated saved results take priority over
the next provider. Compact badges beside catalog counts identify failed and replacement providers;
source, cache age, and coverage details are available on the badge. Search results use the shared
poster cards, including archive-only results with saved artwork or a placeholder. Possible SubsPlease matches are labeled for review and never saved as confirmed
identities. Archive titles remain accessible when catalog providers cannot be reached.

The **SubsPlease** tab starts with a normalized season catalog and filters it against the SubsPlease
show archive. Use the previous and next controls to browse other seasons. The Archive toolbar
button is removed; the archive fallback remains available when the seasonal catalog fails. AniList IDs are
the canonical identity for saved shows; the optional SubsPlease slug and numeric ID are
retained only for weekly timing and episode retrieval. Selecting an episode passes the
chosen magnet link to the same local player flow.

The **Discovery** toolbar switches between **Airing** and **Recommendations**. Recommendations
use up to ten of your most recently loved shows, routed through AniList, MyAnimeList, or Jikan
according to provider priority. Only confidently matched SubsPlease archive titles are shown;
unmapped titles are never guessed. Reviewed shows are excluded. Seeds stay fixed while you review
the queue; refresh or re-enter the mode to use your latest loves. Recommendation metadata is retained
without requiring AniList details enrichment. Autoplay sits beside the series title, and source/cache
age appears beside its date. Episode lists run newest-first; library timing uses a compact next-airing badge.

Select a trailer from Discovery, Library, or SubsPlease details to open it in StreamsPlease's native player. The desktop app asks yt-dlp for the first YouTube result matching `<series title> trailer English subtitles`; AniList's trailer remains the browser-preview fallback. Discovery trailers start inside the page's trailer frame and can be expanded with the theater or full-screen controls. Closing a trailer restores the active episode at its previous position and leaves it paused.

The **Legal Sintel demo** button enters a Creative Commons/open movie torrent so you can test the flow without commercial content.

## Source organization

- `src/lib/components/app/`: app orchestration (wiring the player, torrent, and library modules to the UI), navigation, window controls, and updates.
- `src/lib/components/catalog/`: Search, Discovery, SubsPlease, show details, and shared catalog components.
- `src/lib/components/{library,player,settings,shared}/`: feature UI and reusable presentation.
- `src/lib/components/ui/`: locally owned Lily primitives.
- `src/lib/catalog/`: typed request client, validated storage, title matching, presentation helpers, and cancellable page state.
- `src/lib/discovery/`: recommendation and airing-candidate domain logic.
- `src/lib/library.ts` and `src/lib/library-import.ts`: persisted library normalization, identity-safe reducers, and backup hydration.
- `src/lib/torrent/`: pure torrent file selection, track normalization, and piece-range helpers.
- `src/lib/torrent/session.ts`: serialized torrent start/replace/release lifecycle.
- `src/lib/torrent/seeding.ts`: seeding overview normalization and display helpers.
- `src/lib/player/`: framework-free playback building blocks: `MpvClient` (the only place that talks to libmpv, with format-fixed property methods), `StreamLifecycle` (stream attempts, retries, and buffering watchdog), episode stream opening, seek coalescing, next-episode planning, keyboard shortcuts, and viewport math.
- `src/lib/async/`: reusable generation tokens, serial queue, polling, and operation tracking primitives.
- `src/lib/library-store.svelte.ts`: reactive library state with injectable persistence.
- `src/lib/backend/commands.ts`: the typed Tauri command contract shared by `src/lib/backend.ts` (desktop invocation) and `src/lib/backend/preview.ts` (deterministic preview fixtures).
- `src-tauri/src/catalog/`: catalog adapter registry, AniList/MyAnimeList/Jikan/Kitsu adapters, persistent identity resolution, and independent SubsPlease releases.
- `src-tauri/src/catalog/http.rs`: shared provider HTTP layer with rate limiting, cooldowns, response caching, and bounded body reads.
- `src-tauri/src/torrent.rs`: persistent librqbit session, loopback stream server, and torrent commands.
- `src-tauri/src/seeding.rs`: seeding ledger, ratio policy, 10 GB cache eviction, and seeding commands.
- `src-tauri/src/runtime.rs`: bundled libmpv/trailer runtime discovery.
- `src-tauri/src/library_file.rs`: validated library backup import/export.
- `src-tauri/src/lib.rs`: plugin setup and command registration.
- `tests/`: Node regression tests for matching, caches, async state, preview identity, and library refresh.

## Catalog providers and outage behavior

The native `CatalogAdapter` registry declares provider IDs, labels, and supported capabilities.
`catalog_providers` exposes that ordered registry, and `catalog_request` accepts a provider plus a
search, season, or canonical-ID recommendation request, plus an optional MyAnimeList Client ID. Adapters return the same normalized `CatalogMedia` envelope; frontend
components do not parse provider responses. Existing AniList type aliases and IPC commands remain
compatible. Details enrichment still uses the existing AniList/SubsPlease path independently of
these listing capabilities.

`src/lib/catalog/coordinator.ts` handles capability routing, request deduplication, provider
cooldowns, and fallback. For each supported provider in priority order it uses fresh cached data,
then attempts a refresh, then uses validated stale results before trying the next provider.
Stale search results are retained for at most 30 days and seasons for 90 days. Provider caches
remain separate, timestamps are not reset by stale reads, and fallback caches do not prevent
recovery to the primary provider. A genuine empty response is not an outage. Provider failures,
missing identity mappings, and truncated listings are not silently reported as complete results.

AniList, Jikan, and Kitsu requests are paced and respect bounded cooldowns without automatic retries or
attempts to bypass access restrictions. Jikan lists are SFW, with up to 25 search results or four
season pages of 25 items. A season only includes matching year/season TV, TV_SHORT, and ONA items.
Kitsu returns up to 20 search results or four season pages of 20 items, excluding adult items
and validating the requested season/year and TV/ONA formats. Its season boundaries follow Kitsu's
December–February winter convention. If a later Kitsu page fails, validated earlier pages remain
available with an incomplete-coverage warning rather than losing the entire season.
Official MyAnimeList returns up to 50 search items or 100 seasonal items; recommendations use
verified reverse ID mappings and bounded detail requests. All official MAL requests are paced,
size-limited, and stop contacting the API during a cooldown after systemic errors. Artwork uses the explicitly allowed
`https://cdn.myanimelist.net` (Jikan) and `https://media.kitsu.app` (Kitsu) image origins;
no new WebView API/network permissions are needed.

AniList IDs remain canonical for the existing library. The separate native identity resolver
learns explicit AniList/MyAnimeList ID pairs and bootstraps independently from
[Fribb's reduced anime-offline database](https://github.com/Fribb/anime-lists), so an AniList outage
does not prevent mapping newly retrieved Jikan or Kitsu results. Validated mappings are stored in the
app cache's `catalog` directory, refreshed after seven days when needed, and usable stale when
Fribb is unavailable. Conflicting mappings in either direction are excluded. Unknown mappings
are omitted with a coverage warning, never inferred from title similarity or equal numeric IDs.
A first-ever fallback needs Fribb or previously learned mappings; no ID database is bundled.

To add another provider, implement and register a native `CatalogAdapter`, declare
its supported capabilities, normalize its data, extend the resolver's explicit source-ID import
where necessary, and add deterministic preview fixtures and tests. Add its settings option to
the normalized priority list; unlisted registry providers are appended automatically. Unsupported
capabilities are skipped without provider-specific coordinator or listing UI branches. SubsPlease release retrieval remains independent of metadata providers.

Browser preview is isolated from desktop caches. Use `?catalogPreview=anilist-offline` to exercise
alternative-provider fallback or `?catalogPreview=offline` for all catalog providers unavailable.
Saved preview results still take precedence; use a fresh browser profile for an uncached fallback.
Remote artwork and trailer embeds still need network access; episode buttons use legal Sintel
fixtures. Library episode refresh skips optional metadata and preserves existing progress.

## Known limitations

- Official MyAnimeList queries have deterministic mock HTTP coverage but need a valid Client ID for live verification. Provider request/response fixtures, malformed payloads, identity mapping, pagination, cooldowns, recommendation state, and update consent are covered by the Rust and Node test suites. Mock tests do not prove provider uptime or native trailer/updater safety.

- Simultaneous catalog/mapping outages or unmapped titles can still limit fresh search and seasonal Discovery. Optional details enrichment remains AniList-dependent; SubsPlease details and saved library episodes remain available when SubsPlease is reachable. Jikan and Kitsu listings do not supply AniList relation/prequel or next-airing data; Kitsu listings also lack genres.

- The bundled libmpv integration is currently tested most thoroughly on Windows x86-64; macOS and Linux builds need platform-specific libmpv libraries.
- In this initial version, the UI manages one active episode at a time; the Rust engine can manage multiple torrents.
- Individual cached episodes can be removed from **Seeding & cache**, but the download directory and cache limit are not configurable yet.
- StreamsPlease does not open an inbound peer port, so seeding only reaches peers it connects to itself.
- Tracker reach and startup speed depend on available peers and network or firewall settings.

Use StreamsPlease only for content you are authorized to access. BitTorrent generally also uploads received pieces to other peers while the session is active.
