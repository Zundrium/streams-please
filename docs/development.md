# Development

## Requirements

- Node.js 24 or newer (including the built-in TypeScript regression test runner);
- the current stable Rust toolchain;
- the Tauri v2 platform prerequisites (on Windows: WebView2 and MSVC build tools);
- the bundled libmpv, yt-dlp, and Deno runtimes in `src-tauri/lib` (included in this checkout for Windows x86-64).

StreamsPlease loads libmpv into `streamsplease.exe` instead of playing media in a WebView iframe or launching a separate player process. This keeps episode and trailer audio in StreamsPlease's Windows audio session so application-window streaming tools such as Discord can capture it reliably. yt-dlp and Deno are only used to resolve trailer media URLs; they do not render or output audio.

## Setup and checks

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

Set `STREAMSPLEASE_GITHUB_TOKEN` as a GitHub Actions secret containing a fine-grained token limited to `Zundrium/StreamsPlease` with **Contents: read** permission. Release builds compile that token into the executable so startup checks need no user configuration. GitHub has no releases-only permission, and anyone with the executable can extract the token and read the private repository. Revoking or expiring it also prevents existing builds from downloading later updates. The Windows release workflow builds a single signed NSIS installer (`StreamsPlease_<version>_x64-setup.exe`) and publishes `latest.json`; the app asks for approval before downloading, then verifies, installs, and restarts for newer releases. Choose **Later** to keep using the current version. Versions older than 0.6.0 still use their original automatic-update behavior when upgrading to this version.
