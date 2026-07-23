# Yoru Stream

Yoru Stream is a local Tauri v2 desktop player for legal or personally owned BitTorrent media. A native Rust engine downloads torrent pieces, a local-only HTTP endpoint serves seekable byte ranges, and mpv plays MKV/MP4 files with embedded audio and subtitle tracks.

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
- SubsPlease availability filtering, weekly release times, and historical episode access;
- Discord-capturable YouTube trailer search through the same in-process libmpv player;
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

- Node.js 20 or newer (for the Lily CLI);
- the current stable Rust toolchain;
- the Tauri v2 platform prerequisites (on Windows: WebView2 and MSVC build tools);
- the bundled libmpv, yt-dlp, and Deno runtimes in `src-tauri/lib` (included in this checkout for Windows x86-64).

Yoru loads libmpv into `yoru-stream.exe` instead of playing media in a WebView iframe or launching a separate player process. This keeps episode and trailer audio in Yoru's Windows audio session so application-window streaming tools such as Discord can capture it reliably. yt-dlp and Deno are only used to resolve trailer media URLs; they do not render or output audio.

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
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

The frontend uses Svelte 5/SvelteKit in SPA mode with the static adapter. All interactive
controls and surfaces come from the locally installed Lily component source in
`src/lib/components/ui`; `components.json` stores the Lily CLI configuration.

Playback uses `tauri-plugin-libmpv` and its MPL-2.0 wrapper. The Windows runtime is an LGPL libmpv build and is bundled from `src-tauri/lib`; Tauri copies that directory, including the pinned trailer resolver, into desktop packages. The frontend serializes initialization and retries once if the native player instance is recreated.

To build a desktop bundle:

```powershell
npm run tauri build
```

## Usage

1. Start Yoru Stream and paste a magnet link.
2. Select **Open torrent**. Yoru chooses the largest video file and prioritizes media and subtitles.
3. Switch embedded audio and subtitles through the player or details panel.
4. Use **External subtitle** to add a local subtitle file.
5. Pause P2P or stop the session when you are done. Stopping forgets the torrent but preserves cache files that have already been written.

The **SubsPlease** tab starts with an AniList season and filters it against the SubsPlease
show archive. Use the previous and next controls to browse other seasons. AniList IDs are
the canonical identity for saved shows; the optional SubsPlease slug and numeric ID are
retained only for weekly timing and episode retrieval. Selecting an episode passes the
chosen magnet link to the same local player flow.

Select a trailer from Discovery, Library, or SubsPlease details to open it in Yoru's native player. The desktop app asks yt-dlp for the first YouTube result matching `<series title> trailer English subtitles`; AniList's trailer remains the browser-preview fallback. Discovery trailers start inside the page's trailer frame and can be expanded with the theater or full-screen controls. Closing a trailer restores the active episode at its previous position and leaves it paused.

The **Legal Sintel demo** button enters a Creative Commons/open movie torrent so you can test the flow without commercial content.

## Known limitations

- The bundled libmpv integration is currently tested most thoroughly on Windows x86-64; macOS and Linux builds need platform-specific libmpv libraries.
- In this initial version, the UI manages one active episode at a time; the Rust engine can manage multiple torrents.
- Clearing the cache and configuring the download directory do not have a UI yet.
- Tracker reach and startup speed depend on available peers and network or firewall settings.

Use Yoru Stream only for content you are authorized to access. BitTorrent generally also uploads received pieces to other peers while the session is active.
