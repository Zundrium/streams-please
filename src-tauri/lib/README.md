# Bundled libmpv runtime

These libraries are loaded into `streamsplease.exe`; StreamsPlease does not launch `mpv.exe`.

- `libmpv-2.dll`: LGPL x86-64 build from zhongfly/mpv-winbuild, release `20260722-git-8ab3f8b66d` (`mpv v0.41.0-880-g8ab3f8b66`).
- `libmpv-wrapper.dll`: LGPL-2.1 wrapper v0.1.1 from nini22P/libmpv-wrapper.

They were installed by `npx tauri-plugin-libmpv-api setup-lib` and are included in Tauri bundles through `tauri.conf.json`.

SHA-256:

```text
1BD4B18542D381A8F9C06584972199E2B3BA25B5B8A41AF7E5F918CCB5E993A2  libmpv-2.dll
0D5ADEAD5F175C55E0790A80924EC0A2636F72E3675C79A6D9D9568B2ED2384A  libmpv-wrapper.dll
```

Sources and license information:

- https://github.com/zhongfly/mpv-winbuild
- https://github.com/mpv-player/mpv/blob/master/Copyright
- https://github.com/nini22P/libmpv-wrapper

## Bundled trailer resolver

Discovery trailers use libmpv as well, keeping both video and audio inside the StreamsPlease process. The Windows bundle includes:

- `yt-dlp.exe`: official x86-64 standalone release `2026.08.19` (Unlicense; the bundled executable also contains third-party components covered by its compiled `THIRD_PARTY_LICENSES.txt`).
- `deno.exe`: official x86-64 Deno release `v2.9.3` (MIT), used by yt-dlp for YouTube's JavaScript challenges.

StreamsPlease prepends this resource directory to its own process `PATH` before libmpv starts. No system-wide installation is required.

SHA-256:

```text
66674953FE251B89F4D08C5F0E35E0728679BD67AB3D7D05C0562AF101DD3E7A  yt-dlp.exe
BC925C8729F8764F750597F3A5A365F2A2DEDC0C64D21A2997BC5F2255658FC9  deno.exe
```

Sources and license information:

- https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19
- https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/LICENSE
- https://github.com/denoland/deno/releases/tag/v2.9.3
- https://github.com/denoland/deno/blob/v2.9.3/LICENSE.md
