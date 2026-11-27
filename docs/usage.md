# Usage

1. Start StreamsPlease and paste a magnet link.
2. Select **Open torrent**. StreamsPlease chooses the largest video file and prioritizes media and subtitles.
3. Switch embedded audio and subtitles through the player or details panel.
4. Use **External subtitle** to add a local subtitle file.
5. Starting another episode releases the previous torrent. Fully downloaded episodes keep seeding until they reach the target ratio and are then deleted; partial downloads are paused and kept so they can resume quickly. When the cache exceeds 10 GB, the least recently watched episodes that are not playing are removed first. Seeding state and upload totals survive restarts. **Account settings → Seeding & cache** can cap the total upload rate (64 KiB/s minimum, unlimited by default); the header always shows the current total download and upload speed.
6. The Library keeps airing shows at the top. Shows whose AniList episode count has been fully released move to **Completed** at the bottom, below **Checked**.
7. Each library show remembers where you stopped in an unwatched episode. Starting that episode again resumes from the saved position, and the Library and show pages label it with the time. The position is saved every 10 seconds and whenever playback pauses. It is cleared once the episode is marked watched, which happens automatically at 80%.

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
identities. Results that are not on SubsPlease open a details page built from the catalog result, with the trailer but without episodes, taste, or library actions. Archive titles remain accessible when catalog providers cannot be reached.

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

## Watch together

The **Watch together** button sits in the header next to Account settings.

1. The host enters a display name and selects **Host a room**, then copies the invite code and sends it to the guests.
2. A guest enters a display name, pastes the code, and selects **Join**. Joining switches to the Player view.
3. The host starts any episode. Every participant downloads it over BitTorrent with the host's magnet link and loads it paused. The room starts when everyone is ready.
4. The host controls play, pause, seeking, speed, the next episode, and **Stop for everyone**. Guests keep their own volume, audio and subtitle tracks, theater, and full-screen controls; their playback controls are locked.
5. The room pauses while a participant is loading or stalls, and shows who it is waiting for. The host can select **Play anyway**.
6. A guest who leaves the Player view, opens a trailer, or hides the window is away and does not hold the room; returning resyncs. When the host does the same, the room pauses.
7. The host can remove a guest and lock the room against new guests. A removed guest can rejoin unless the room is locked. **End room** or closing the app releases the guests, who keep the episode loaded and paused.

Privacy:

- The host chooses what plays. Guests download it over BitTorrent and seed it like any other episode.
- The host and each guest can see each other's IP address. Guests connect only to the host, but all participants are in the same BitTorrent swarm.
- Connections are end-to-end encrypted with a key pair that is random per room and never stored. The invite code contains no IP address and stops working when the room ends.
- The first contact goes through a public [iroh](https://www.iroh.computer/) relay operated by number 0, which sees IP addresses and endpoint IDs but not content. The connection then becomes direct when the networks allow it.
- Nothing is published to DNS, no router port is mapped, and no metrics are sent.

The **Legal Sintel demo** button enters a Creative Commons/open movie torrent so you can test the flow without commercial content.

## Known limitations

- Official MyAnimeList queries have deterministic mock HTTP coverage but need a valid Client ID for live verification. Provider request/response fixtures, malformed payloads, identity mapping, pagination, cooldowns, recommendation state, and update consent are covered by the Rust and Node test suites. Mock tests do not prove provider uptime or native trailer/updater safety.

- Simultaneous catalog/mapping outages or unmapped titles can still limit fresh search and seasonal Discovery. Optional details enrichment remains AniList-dependent; SubsPlease details and saved library episodes remain available when SubsPlease is reachable. Jikan and Kitsu listings do not supply AniList relation/prequel or next-airing data; Kitsu listings also lack genres.

- The bundled libmpv integration is currently tested most thoroughly on Windows x86-64; macOS and Linux builds need platform-specific libmpv libraries.
- In this initial version, the UI manages one active episode at a time; the Rust engine can manage multiple torrents.
- Individual cached episodes can be removed from **Seeding & cache**, but the download directory and cache limit are not configurable yet.
- StreamsPlease does not open an inbound BitTorrent peer port, so seeding only reaches peers it connects to itself. The watch-together room endpoint is separate and exists only while a room is open.
- Watch together has been checked with two instances on one machine. Its sync between two machines on different networks and its behavior behind a firewall have not been verified yet.
- A room needs a reachable public iroh relay for the first contact, holds at most 8 participants, has no chat and no guest control, and plays the host's file and quality for everyone. The host and all guests need the same room protocol version. Only Windows is checked.
- Tracker reach and startup speed depend on available peers and network or firewall settings.
