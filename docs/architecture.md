# Architecture

```text
SvelteKit UI + Lily components (Tauri WebView)
  ├─ catalog coordinator ──> native provider registry ──> AniList / MyAnimeList / Jikan / Kitsu
  │                              └─ persistent cross-provider identity resolver
  ├─ release catalog ────> SubsPlease availability/releases
  ├─ Tauri commands ──> librqbit session ──> trackers / DHT / peers
  ├─ player controls ─> in-process libmpv playback ──> episodes + trailers
  ├─ trailer search ───> bundled yt-dlp + Deno ──> first YouTube result
  ├─ room session ────> host gate / guest follower ──> reconciler ──> player controls
  │                        └─ Tauri commands + channel ──> iroh QUIC endpoint <──> other participants
  └─ media URL ───────> 127.0.0.1:<random>/torrents/:id/stream/:file
```

The stream server binds exclusively to `127.0.0.1`, selects a random available port on every launch, and exposes read-only routes only. Mutations are handled through protected Tauri commands.

The room endpoint is the one listener that other machines can reach. It exists only while a room is open, serves only the room protocol, and carries small control messages: room state, roster, status, and clock pings. Media never crosses it. The sync logic is framework-free TypeScript in `src/lib/room/`; the Rust side in `src-tauri/src/room/` transports and validates messages and tracks membership.

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
- `src/lib/room/`: watch-together sync: protocol types and guards, host-clock estimate, readiness, the reconciler, host and guest controllers, the backend transport, and the reactive `RoomSession`.
- `src/lib/components/room/`: room panel, roster, and status pill.
- `src/lib/backend/preview-room.ts`: simulated room for the browser preview.
- `src/lib/async/`: reusable generation tokens, serial queue, polling, and operation tracking primitives.
- `src/lib/library-store.svelte.ts`: reactive library state with injectable persistence.
- `src/lib/backend/commands.ts`: the typed Tauri command contract shared by `src/lib/backend.ts` (desktop invocation) and `src/lib/backend/preview.ts` (deterministic preview fixtures).
- `src-tauri/src/catalog/`: catalog adapter registry, AniList/MyAnimeList/Jikan/Kitsu adapters, persistent identity resolution, and independent SubsPlease releases.
- `src-tauri/src/catalog/http.rs`: shared provider HTTP layer with rate limiting, cooldowns, response caching, and bounded body reads.
- `src-tauri/src/torrent.rs`: persistent librqbit session, loopback stream server, and torrent commands.
- `src-tauri/src/seeding.rs`: seeding ledger, ratio policy, 10 GB cache eviction, and seeding commands.
- `src-tauri/src/room/`: iroh endpoint, invite codes, admission, framing, message validation, rate limits, and room commands.
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
