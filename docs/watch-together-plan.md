# Watch together: implementation plan

Status: Phases 1 (sync core) and 2 (playback seams) are implemented and released in v0.9.1. Phase 2's native checks are open. Phase 0's automated and single-machine checks pass and are released in v0.9.2. Phase 3 (Rust transport and IPC) is implemented with its automated checks green; the commands are registered, but no UI calls them yet. The two-machine run and the firewall prompt of Phase 0 move to the Phase 4 matrix, because the spike executable is gone. The DHT file is now per app, so the two-instance recipe is unblocked but not yet run. Phases 4 to 7 are open.
Base: `e3c96cb` (v0.9.0), written 2026-11-26. Decisions 1 to 6 are confirmed.
Code name: `room`. UI label: "Watch together".

## 1. Summary

One StreamsPlease app hosts a room and others join it with an invite code. The host controls playback for everyone: start any episode, play, pause, scrub, change speed, stop. Guests follow, and report their loading state. The room does not play while a participant is still loading.

Only small control messages travel between peers. Every participant downloads the episode itself over BitTorrent, using the host's magnet link, and plays it in its own in-process libmpv. Application-window capture keeps working and the torrent stream server stays on loopback.

Terms used below:

- **Host**: the participant who created the room and controls it.
- **Guest**: a participant who joined a host (the "client" in the feature request). "Guest" avoids confusion with `MpvClient` and the catalog client.
- **Participant**: host or guest.
- **Solo**: not in a room; today's behavior.

## 2. Scope

In scope:

- Host a room, join a room with an invite code, leave, end the room, remove a guest, lock the room against new guests.
- Host-only control of: episode selection (including next episode), play, pause, seek, speed, stop.
- Guests report `loading`, `ready`, `away`, or `error`; the host waits for loading guests before playing, and pauses the room when a guest stalls.
- A host override ("Play anyway") so one broken guest cannot block the room forever.
- Tight sync: scheduled starts, clock-offset estimation, drift correction.
- A roster with names and states for everyone.
- Browser-preview parity with a simulated room.

Out of scope for this version:

- Chat, voice, reactions.
- Guests controlling or requesting playback.
- Synchronized trailers. Trailers stay local.
- A different quality per guest. Everyone plays the host's magnet.
- Host migration, saved rooms, saved identities.
- More than 8 participants.
- macOS and Linux verification.

## 3. Decisions

Each row is a choice this plan commits to. The first six change the product; they are confirmed.

| # | Decision | Reason | Rejected alternative |
|---|---|---|---|
| 1 | Transport is [iroh](https://docs.rs/iroh/1.5.0/iroh/) 1.5 in the Rust backend: QUIC, dialed by public key, hole punching with relay fallback. Relays are the public number 0 relays. | Works behind home NAT without port forwarding or a server of our own. End-to-end encrypted and peer-authenticated by design. Tokio-native. Stable 1.x since June 2026. | WebRTC in the WebView: needs a signaling server or a two-way copy-paste, and moves networking out of the backend. Direct TCP or WebSocket: needs port forwarding. Own relay server: not P2P, and needs hosting. libp2p: more to configure for the same result. |
| 2 | Guests follow only. They cannot pause or seek for the room. | Matches the request: the host emits, guests report. Keeps one writer of room state. | Shared control: needs conflict rules and permissions. |
| 3 | A loading guest holds the room, also when it joins or stalls mid-episode. The host can override with "Play anyway". | The request says the host must not play what guests have not loaded. The override prevents a deadlock. | Never hold after the first start: breaks the requirement. No override: one bad connection blocks everyone. |
| 4 | Everyone plays the host's magnet, so the same file and quality. | Identical timeline. All participants join the same swarm and feed each other. | Per-guest quality: the host would have to send every download and timelines must be proven equal. Can be added later. |
| 5 | A guest who leaves the Player view, opens a trailer, or hides the window becomes `away` and does not hold the room. | These are choices, not loading. Returning resyncs the guest. | Holding the room for away guests: lets anyone freeze the room by switching tabs. |
| 6 | At most 8 participants (host plus 7 guests), star topology: guests connect only to the host. | Small rooms are the use case. Guests never learn each other's addresses. The host fans out. | Mesh or gossip: no benefit when one peer is the authority. |
| 7 | The sync logic lives in framework-free TypeScript under `src/lib/room/`. Rust only transports, validates, and tracks membership. | All playback is driven from TypeScript through `MpvClient` (`src/lib/player/mpv-client.ts`). The sync logic must sit next to it and stay testable in Node. | Sync in Rust: would need a second control path into mpv. |
| 8 | Every host action is broadcast as a full room-state snapshot with a sequence number, not as a delta. | The state is tiny. A missed or reordered message cannot corrupt a guest; the newest snapshot always wins. | Event deltas: need replay and ordering guarantees. |
| 9 | One reconciler function drives every player, the host's included, toward the room state. | Idempotent and self-healing after retries, trailers, and reconnects. One behavior to test. | Edge-triggered commands per event: fragile when a command is lost or the player restarts. |
| 10 | No new libmpv property, format, or command. | The FFI boundary is the top safety priority in `AGENTS.md`. Existing typed `MpvCommands` methods are enough: `setFlag('pause')`, `setNumber('speed')`, `seek`, `loadFile`, `stop`. | Observing `demuxer-cache-duration` for readiness: more precise, but new FFI surface. |
| 11 | The room key pair is random per room and per join, and never stored. | Nothing secret on disk. Rooms cannot be linked to each other. The invite dies with the room. | A saved identity: enables friends lists, not needed now. |
| 12 | No Tauri capability or CSP change. | Networking is in Rust. Events use a Tauri `Channel`, as `install_update` already does (`src-tauri/src/updates.rs`). | Frontend sockets: would need wider `connect-src`. |

## 4. Architecture

```text
Host app                                            Guest app
StreamsPleaseApp.svelte                             StreamsPleaseApp.svelte
  └─ RoomSession (reactive state for the UI)          └─ RoomSession
       └─ HostController (room state, gate)                └─ GuestController (follow, report)
            ├─ reconciler ──> PlaybackPort ──> mpv + torrent    ├─ reconciler ──> PlaybackPort
            └─ RoomTransport ──> callBackend                    └─ RoomTransport ──> callBackend
                    │ Tauri commands + Channel                          │
            src-tauri/src/room  <──── iroh QUIC, end-to-end encrypted ────>  src-tauri/src/room
                    │                                                    │
            librqbit ──> 127.0.0.1 stream ──> libmpv         librqbit ──> 127.0.0.1 stream ──> libmpv
```

Responsibilities:

- **`src-tauri/src/room/`** owns the iroh endpoint, invite codes, admission, framing, validation of every message in both directions, rate limits, fan-out, and membership events. It knows roles. It does not know playback.
- **`src/lib/room/`** owns the protocol types and guards, the clock estimate, the host gate, the guest follower, and the reconciler. No Svelte or Tauri imports other than types.
- **`src/lib/room/session.svelte.ts`** exposes role, invite, roster, link state, and errors to the UI, like `LibraryStore` does for the library.
- **`StreamsPleaseApp.svelte`** implements `PlaybackPort` from its existing functions and routes transport controls by role. It gets wiring only.

New files:

```text
src-tauri/src/room/mod.rs          state, commands, event enum
src-tauri/src/room/protocol.rs     wire types, limits, validation, frame codec
src-tauri/src/room/invite.rs       invite encode and parse
src-tauri/src/room/host.rs         accept loop, peer table, fan-out, remove, lock
src-tauri/src/room/guest.rs        connect, handshake, reconnect

src/lib/room/protocol.ts           types, constants, guards for untrusted input, the send-only RoomTransport type
src/lib/room/clock.ts              host-clock offset from ping samples
src/lib/room/readiness.ts          participant phase with hysteresis
src/lib/room/reconcile.ts          room state + local state -> player actions, PlaybackPort, LocalPlayback
src/lib/room/host-controller.ts    intents, gate, broadcasts
src/lib/room/guest-controller.ts   apply state, report status
src/lib/room/transport.ts          backend implementation of RoomTransport
src/lib/room/session.svelte.ts     reactive session
src/lib/backend/preview-room.ts    simulated room for browser preview

src/lib/components/room/RoomPanel.svelte
src/lib/components/room/RoomRoster.svelte
src/lib/components/room/RoomStatusPill.svelte

tests/room-*.test.ts
tests/room-fakes.ts                fake clock, transport, and player shared by the room tests
```

The files of Phase 1 exist: `protocol.ts`, `clock.ts`, `readiness.ts`, `reconcile.ts`, `host-controller.ts`, `guest-controller.ts`, their tests, and `tests/room-fakes.ts`. The files of Phase 3 exist: `src-tauri/src/room/`, `transport.ts`, `preview-room.ts`, and `tests/room-transport.test.ts`.

## 5. Transport

### Dependency

```toml
iroh = { version = "1.5", default-features = false, features = ["tls-ring"] }
```

- `tls-ring` reuses `ring`, which is already in `Cargo.lock`.
- `metrics` is off: no telemetry.
- `portmapper` is off: no UPnP, PCP, or NAT-PMP port mapping on the router.
- iroh needs Rust 1.91 or newer. The local toolchain is 1.91.1; CI uses `dtolnay/rust-toolchain@stable`.
- `tokio` gains the features the room code needs (`io-util`, `macros`).
- `wmi` 0.18, through `netwatch`, accepts `windows` and `windows-core` 0.59 to 0.62. Cargo first paired it with the app's `windows` 0.61 and `windows-core` 0.62, which does not compile. `cargo update -p wmi` moved it to `windows` 0.62; repeat that if a later lock update breaks it again.

### Endpoint

- Built with `Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Default)`. `Minimal` sets only the crypto provider, so no address lookup is configured and nothing about the room is published to DNS; the invite carries what a guest needs. `presets::N0` is not used: it adds DNS lookups that would have to be cleared again, and it switches to the staging relays when `IROH_FORCE_STAGING_RELAYS` is set, which would break the invite's relay match.
- `bind()` opens UDP sockets on `0.0.0.0` and `[::]` with random ports.
- The host adds `.alpns(vec![b"streamsplease/room/1".to_vec()])`. Guests set no ALPN, so they accept no connections.
- The secret key is the builder's fresh random key.
- The endpoint exists only between `room_host` or `room_join` and `room_leave`. Solo use binds nothing.
- The host waits for `endpoint.online()` with a 10 second timeout. On timeout, hosting fails with an actionable error and the endpoint is closed.

### Invite code

Format: `sproom1:<endpoint id in z-base-32>@<relay hostname>`, 86 characters with the current relays, plain ASCII.

- It contains no IP address. The first contact goes through the relay; iroh then upgrades to a direct path.
- The host takes the first relay URL of `addr()` after `online()`. Relay hostnames in the map end with a dot (`euc1-1.relay.n0.iroh.link.`); the invite drops it, and the parser compares without it, ignoring case.
- Parsing (Rust): length at most 256, exact prefix, id through `PublicKey::from_z32`, and the relay hostname must match a relay in `iroh::defaults::prod::default_relay_map()`. The `RelayUrl` is taken from that map, never built from user text. A crafted invite cannot point a guest at an arbitrary server.
- Joining your own room is rejected.
- If the host's home relay changes, the host UI receives a new invite (Phase 6).

### Connection lifecycle

1. The guest connects with a 20 second timeout and opens one bidirectional stream.
2. The guest sends `hello`. The host drops connections that send nothing valid within 5 seconds.
3. The host checks the lock and the room limit, assigns an id, replies `welcome` with the cached room state and roster, and emits `peerJoined` to its frontend.
4. Both sides exchange frames until `bye`, `closed`, or loss.
5. A participant that sends nothing for 15 seconds is dropped. Heartbeats run every 2 seconds, so this only fires on real loss.
6. A guest that loses the link retries with the same endpoint for 15 seconds. The host recognizes the endpoint id and gives the same participant id back. After that the guest's room ends with reason `hostLost`.

### Limits enforced in Rust

| Limit | Value |
|---|---|
| Frame size | 16 KiB, checked before allocating |
| Messages from a guest, checked by the host | 10 per second, burst 20; exceeding closes the connection |
| Messages from the host, checked by a guest | 30 per second, burst 60; exceeding closes the connection |
| Outbound queue per peer | 32 frames; a full queue closes the connection |
| Participants | 8 |
| Display name | 1 to 24 characters after cleanup |
| Magnet length in a room | 8,192 bytes |

## 6. Protocol

### Framing

One QUIC bidirectional stream per guest. A frame is a 4-byte big-endian length followed by UTF-8 JSON. JSON keeps the same shapes on the wire and across IPC, and `serde_json` is already a dependency.

All message types use `#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]`. Unknown types and unknown fields are rejected. Any wire change gets a new ALPN version; a host lists every version it supports, newest first. Peers without a common version fail the handshake and the guest sees "The host uses a different StreamsPlease version."

### Messages

Guest to host:

| Type | Fields | Notes |
|---|---|---|
| `hello` | `name` | Must be the first frame. |
| `status` | `epoch`, `phase`, `progress` | On every change of epoch or phase, and every 2 seconds. A change of `progress` alone is sent at most once per 500 ms, to stay under the guest rate limit. |
| `ping` | `pingId`, `sentAt` | Clock sampling. |
| `bye` | | Clean leave. |

Host to guest:

| Type | Fields | Notes |
|---|---|---|
| `welcome` | `selfId`, `hostName`, `state`, `roster` | Reply to `hello`. Built in Rust from the last broadcast. |
| `state` | `RoomState` | On every host action, and as a heartbeat. A paused heartbeat repeats the same `seq`. |
| `roster` | `participants` | On every membership or status change, at most 4 per second. |
| `pong` | `pingId`, `sentAt`, `hostTime` | Reply to `ping`. |
| `closed` | `reason`: `ended`, `removed`, `full`, `locked` | Followed by a connection close. |

### Shared types

```ts
type RoomState = {
  seq: number;       // +1 on every broadcast change; receivers ignore seq <= the last one seen
  epoch: number;     // +1 on every load, seek, and stop; readiness is reported per epoch
  mediaSeq: number;  // +1 on every load and stop
  media: RoomMedia | null;
  playing: boolean;  // the host wants to play AND nobody is holding the room
  position: number;  // media seconds, valid at hostTime
  hostTime: number;  // host clock in ms; up to START_LEAD_MS in the future when playing turns true
  speed: number;     // a value from PLAYBACK_SPEEDS
};

type RoomMedia = {
  magnet: string;
  title: string;
  episode: string;
  slug: string;
  anilistId?: number;
  imageUrl: string;
  quality: string;
};

type ParticipantPhase = 'idle' | 'loading' | 'ready' | 'away' | 'error';

type GuestStatus = { epoch: number; phase: ParticipantPhase; progress: number | null };

type Participant = {
  id: number;        // 0 is the host
  name: string;
  host: boolean;
  phase: ParticipantPhase;
  progress: number | null;  // 0..1 while loading, null when unknown
  blocking: boolean; // true when this participant holds the room
};
```

`RoomMedia` is `EpisodePlaybackRequest` (`src/lib/types.ts`) without the schedule fields, so a guest can set `playingEpisode` from it and keep its own watched state and resume points working.

### Validation

Peer input is untrusted. Rust validates at the network boundary and again on `room_send`, so a compromised frontend cannot send what a peer would reject. TypeScript narrows every event from `unknown` before use, with `parseRoomEvent` in `protocol.ts`.

The TypeScript guards apply the rules below, with two notes. The magnet check is a shape check only (prefix, a 40-character hex or 32-character base32 v1 info hash, the byte limit); Rust stays the authority. A state with `playing: true` and no media is rejected.

| Field | Rule |
|---|---|
| Direction | The host accepts only guest types. A guest accepts only host types, and only from the host connection. |
| `name` | Control characters removed, whitespace collapsed, trimmed, 1 to 24 characters; empty becomes "Guest". |
| `magnet` | `validate_magnet` and `magnet_info_hash` from `src-tauri/src/torrent.rs` (made `pub(crate)`), plus the 8,192 byte room limit. |
| `title`, `episode`, `slug`, `quality` | Length caps (200, 16, 120, 8). `slug` only `[a-z0-9-]`. No control characters. |
| `imageUrl` | At most 500 characters; a `/` path or an `https://` URL. Rendering goes through `posterUrl()` and the existing `img-src` list, so other origins do not load. |
| Numbers | Finite. `seq`, `epoch`, `mediaSeq`, ids: non-negative integers. `position`: 0 to 86,400. `speed`: a member of `PLAYBACK_SPEEDS`. `progress`: 0 to 1 or null. |
| `anilistId` | Positive integer when present. |

## 7. Sync model

### Clock

Each app uses its own monotonic clock: `performance.timeOrigin + performance.now()`, injected as `now()` so tests control time.

A guest estimates the offset to the host clock from `ping` and `pong`: five samples 200 ms apart after joining, then one every 10 seconds. For each sample, `rtt = received - sentAt` and `offset = hostTime + rtt / 2 - received`. The estimate is the offset of the sample with the lowest round-trip time among the last 8. Pings are answered by the host's TypeScript, so both ends measure in the clock that also schedules mpv.

### The gate

The room plays when the host wants to play and nobody is blocking.

- A guest **blocks** when it has not reported `ready` for the current `epoch`. A guest that is `away` or in `error` does not block, and neither does a guest the host bypassed.
- The host is participant 0 and judges itself from its own player. It blocks until it is ready, also after an error, and it cannot be bypassed.
- **Opening**: when the last blocker clears and stays clear for `READY_SETTLE_MS`, the host broadcasts `playing: true` with `hostTime = now + START_LEAD_MS`. Everyone unpauses at that instant on its own clock.
- **Holding**: when a participant starts blocking while the room plays, the host pauses immediately and broadcasts `playing: false` at its current position. The host's intent stays "play", so the room resumes by itself.
- **Play anyway**: bypasses the guests that block right now. A bypass ends when that guest next reports `ready`, and all bypasses end on the next load.
- A guest that joins starts as `loading` and therefore holds the room until it is ready or bypassed.

### Readiness

Each participant decides its own phase with one pure function in `readiness.ts`:

- `away`: a guest that is not attached (see below).
- `error`: the local stream is in the `error` phase.
- `idle`: the room has no media.
- `loading`: connecting, buffering, a seek in flight, or not enough buffered yet.
- `ready`: the current media is loaded, mpv has a frame at the target position, and either the file is fully downloaded or at least `READY_BUFFER_SECONDS` are buffered ahead.

Hysteresis stops the room from flapping: once `ready` in an epoch, a participant stays `ready` until mpv really stalls (`paused-for-cache`, which is the existing `buffering` phase). It then stays `loading` until the buffer threshold is met again. A seek in flight does not end `ready` within an epoch, so a guest's drift-correcting seek cannot hold the room; a host seek starts a new epoch and does.

Near the end of the file the buffer needed is the time that remains, when that is less than `READY_BUFFER_SECONDS`.

"Buffered ahead" comes from the torrent piece map that the app already polls every second: contiguous downloaded bytes from the playback position, converted to seconds with the same linear bytes-to-time estimate the seek bar uses (`torrentPieceRanges`, `src/lib/torrent/media.ts:70`). A new helper `bufferedSecondsAhead` shares that piece math. When the piece map is missing, readiness falls back to mpv's state alone.

### The reconciler

`reconcile(target, local, memory, context)` is a pure function that returns the next player action, or none, together with the new memory. The `Reconciler` class owns that memory, runs one action at a time through `PlaybackPort`, and holds the timer for a scheduled start. It runs on every room-state change, every local playback change, and a 1 second tick.

As built:

- After a load or an epoch seek, the participant is not settled, and so not ready, until a local snapshot arrives after the action finished. Without a snapshot this ends after 1 second. This stops a participant from reporting ready from the buffer at its old position.
- No action is decided on a snapshot older than the last action, also with a 1 second fallback.
- Seeks wait until the duration is known, because the app's `scheduleSeek` does nothing without it.
- A paused player is aligned at most once per room position, so a seek that lands slightly off cannot loop.
- A load or an epoch seek in a playing room targets the expected live position, not the stale anchor.
- The host's player is never drift corrected. A guest is drift corrected only once its clock has a sample.
- A guest with an unsynced clock unpauses at once instead of at `hostTime`.

| Room state | Local player | Action |
|---|---|---|
| `media` is null | room media loaded | stop |
| `mediaSeq` changed | any | load the media paused at `position` |
| `epoch` changed, same media | any | pause, seek to `position` |
| not playing | playing | pause |
| not playing | paused, more than `PAUSED_ALIGN_SECONDS` off | seek to `position` |
| playing, `hostTime` in the future | paused and ready | unpause at `hostTime` |
| playing | paused and ready | unpause now |
| playing | playing, drift within `DRIFT_OK_SECONDS` | base speed |
| playing | playing, drift up to `DRIFT_HARD_SECONDS` | base speed × 0.95 or × 1.05 until within 30 ms |
| playing | playing, drift beyond `DRIFT_HARD_SECONDS` | seek to the expected position, at most once per 5 seconds |
| `speed` changed | any | set the base speed |
| any | loading or error | wait and report |
| any | guest is away | keep paused, do nothing else |

Drift is `local position - (position + (hostNow - hostTime) / 1000 × speed)`.

While playing, the host re-anchors `position` and `hostTime` from its own observed `time-pos` and sends that as the heartbeat. On the host the reconciler compares the player with its own anchor, so it only acts on loads, seeks, holds, and scheduled starts.

A guest's speed button shows the room speed, not the temporary correction speed.

### Host intents

| Intent | Room state change | Then |
|---|---|---|
| `load(media, startAt)` | `epoch` +1, `mediaSeq` +1, `playing: false`, `position: startAt`; intent becomes play; bypasses cleared | The gate opens when all are ready. |
| `play()` | intent becomes play | Opens the gate now if nobody blocks; otherwise the roster shows who is awaited. |
| `pause()` | `playing: false` at the host position; intent becomes pause | |
| `seek(target)` | `epoch` +1, `position: target`, `playing: false` | Reopens when all are ready, if the intent is play. |
| `setSpeed(speed)` | `speed`; re-anchor when playing | |
| `stop()` | `epoch` +1, `mediaSeq` +1, `media: null`, `playing: false` | Everyone releases the torrent. |

Rapid seeks are coalesced: broadcasts are limited to one per 100 ms and the latest state wins. Guests coalesce again through `SeekScheduler`.

`play()` opens the gate at once when nobody has blocked for `READY_SETTLE_MS`; otherwise it opens when that time has passed. The gate opens at the host player's own position.

`adopt(media, local, speed)` is the seventh entry point: it starts a room around the episode the host already plays, without reloading it.

The end of the file is the one pause the host does not command: with `keep-open`, mpv pauses at the end. The host controller turns an observed pause within 0.5 seconds of the duration into intent pause.

`startAt` is the host's saved resume position (`savedResumeTime`). Guests ignore their own resume points while in a room.

### Attached and away

A guest is **attached** when the Player view is active, no trailer is open, and the document is visible. Detaching pauses the local player, as the app already does today, and reports `away`. Attaching runs the reconciler against the latest room state from scratch, which may load a new episode or seek to the live position. Joining a room switches to the Player view.

The host has no away state. Its existing auto-pause on view change and on hidden window becomes a normal `pause()` intent, so the room pauses when the host looks away. Opening a trailer on the host pauses the room the same way.

### Constants

| Name | Value | Meaning |
|---|---|---|
| `START_LEAD_MS` | 500 | Delay between the play broadcast and the shared start. |
| `READY_BUFFER_SECONDS` | 10 | Buffer ahead needed to report ready. |
| `READY_SETTLE_MS` | 300 | Everyone must stay ready this long before the gate opens. |
| `STATUS_HEARTBEAT_MS` | 2,000 | Guest status heartbeat. |
| `STATE_HEARTBEAT_MS` | 2,000 playing, 5,000 paused | Host state heartbeat. It is checked on the 1 second tick, so the real interval is 2 to 3 seconds playing and 5 to 6 seconds paused. |
| `STATUS_PROGRESS_INTERVAL_MS` | 500 | Shortest time between two status messages that differ only in progress. |
| `PEER_SILENCE_MS` | 15,000 | Silence after which a peer is dropped. |
| `PAUSED_ALIGN_SECONDS` | 0.1 | Tolerated offset while paused. |
| `DRIFT_OK_SECONDS` | 0.08 | Drift that needs no correction. |
| `DRIFT_HARD_SECONDS` | 1.5 | Drift corrected by seeking. |

These are starting values. Phase 6 tunes them against real measurements.

### Flows

Host starts an episode:

```text
Host UI      Host controller                 wire                Guest controller      Guest player
play ep ──>  load(media, startAt)
             epoch+1, playing=false  ──── state ──────────────>  reconcile: load   ──> add_magnet,
             host player: load paused                                                  open paused
                                     <─── status loading 40% ──
             roster: Alice blocking  ──── roster ─────────────>  "Waiting for Alice"
                                     <─── status ready ────────
             all ready for 300 ms
             playing=true,
             hostTime=now+500        ──── state ──────────────>  unpause at hostTime ──> plays
             host player: unpause at hostTime
```

Guest stalls mid-episode:

```text
                                     <─── status loading ──────  mpv paused-for-cache
             hold: pause, playing=false ── state ─────────────>  pause
             roster: Alice blocking  ──── roster ─────────────>
                                     <─── status ready ────────  10 s buffered again
             playing=true, hostTime=now+500 ── state ─────────>  unpause at hostTime
```

## 8. App integration

The app keeps one code path for solo playback. Room mode adds seams, not a second player.

### Seams (solo behavior unchanged)

1. **Start paused.** `openEpisodeStream` always unpauses after loading (`src/lib/player/episode-stream.ts:43`). Add a `startPaused()` dependency and pass its value to `setFlag('pause', …)`. Solo passes `false`. In a room it is always `true`; the reconciler unpauses. `beginEpisode` (`StreamsPleaseApp.svelte:982`) sets the optimistic `playback.paused` from the same value. This also makes stream retries come back paused in a room.
2. **Stop.** `TorrentSession.clear()` is private (`src/lib/torrent/session.ts:80`). Add a public `stop()` that supersedes pending starts and runs `clear()` on the queue. The app wrapper also resets `phase` to `idle`.
3. **Intent and apply.** Split each transport handler into a role-aware intent and a local apply:
   - `togglePlayback` (`:1151`), `pausePlayback` (`:1158`), `scheduleSeek` (`:1220`), `cycleSpeed` (`:1256`).
   - Solo: the intent calls the apply, as today.
   - Host: the intent calls `HostController`; the reconciler calls the apply.
   - Guest: the intent does nothing.
   - Buttons, the timeline, and keyboard shortcuts (`runShortcut`, `:603`) all go through the intents, so one check covers them.
4. **Start an episode.** Split `playSubsPleaseRelease` (`:1100`) into `requestEpisode(request)`, which is role-aware, and `startEpisode(request, { startAt, startPaused })`, which holds today's mechanics. The host intent broadcasts first, so guests load in parallel with the host.
5. **Local snapshot.** A `$derived` `localPlayback` holds `{ loaded, phase, paused, position, sampledAt, duration, bufferedAhead, downloaded, seeking }`, and one `$effect` passes it to `RoomSession.localChanged`. The controller remembers which `mediaSeq` it asked the port to load, so the app does not need to know about room sequence numbers. The sync core relies on a new snapshot after every load and seek; `sampledAt` is the local clock time at which `position` was observed.

`PlaybackPort`, implemented by the app from those apply functions:

```ts
interface PlaybackPort {
  load(media: RoomMedia, position: number): Promise<void>;
  stop(): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  seek(position: number): void;
  setSpeed(speed: number): Promise<void>;
}
```

### Behavior by role

| Action | Host | Guest |
|---|---|---|
| Play, pause (button, Space, click on the video) | Applies to the room | Locked |
| Seek, scrub, ±10 s | Applies to the room | Locked |
| Speed | Applies to the room | Locked; shows the room speed |
| Start an episode, next-episode prompt | Loads for everyone | Blocked with a notice; no prompt shown |
| Stop for everyone (room panel) | Everyone stops | Not available |
| Volume, mute, audio and subtitle tracks, theater, full screen | Local | Local |
| Leave the Player view, hide the window | Pauses the room | Becomes away; the room continues |
| Open a trailer | Pauses the room | Becomes away |
| Retry a failed stream | Local; holds the room while loading | Local; holds the room while loading |
| Watched state, resume points | Own library | Own library |

Other rules:

- Starting to host while an episode plays makes that episode the room media at the current position.
- Leaving a room, or losing the host, pauses the guest's player and returns it to solo with the episode still loaded.
- Ending a room does not interrupt the host's own playback.
- If the host's own stream fails, the host blocks the room and sees the existing retry UI.
- On startup the frontend calls `room_leave` once, so a reloaded WebView never inherits a session it has no channel for. `room_host` and `room_join` replace any existing session.

### FFI safety

- The room adds no mpv property, format, or command.
- Speed corrections change at most once per second.
- Hard seeks are limited to one per 5 seconds.
- No retries are added around mpv calls.
- Every phase that touches playback is exercised in `npm run tauri dev` on Windows before it is called done.

## 9. IPC contract

Commands, added together in `src-tauri/src/room/mod.rs`, `generate_handler!` (`src-tauri/src/lib.rs:30`), `src/lib/backend/commands.ts`, `src/lib/backend/preview.ts`, and `src/lib/types.ts`:

```ts
room_host:   Command<{ name: string; onEvent: Channel<RoomEvent> }, { invite: string }>;
room_join:   Command<{ invite: string; name: string; onEvent: Channel<RoomEvent> },
                     { selfId: number; hostName: string }>;
room_send:   Command<{ message: RoomOutbound }, void>;
room_remove: Command<{ id: number }, void>;
room_lock:   Command<{ locked: boolean }, void>;
room_leave:  Command<NoArgs, void>;
```

- `room_send` is role-checked. A host may send `state`, `roster`, and `pong` (with a target id). A guest may send `status` and `ping`.
- `RoomOutbound` nests its payload like the events do: `{ type: 'state', state }`, `{ type: 'roster', participants }`, `{ type: 'pong', id, pingId, sentAt, hostTime }`, `{ type: 'status', status }`, `{ type: 'ping', pingId, sentAt }`. The types are in `src/lib/room/protocol.ts`.
- `room_remove` and `room_lock` are host-only.
- `room_leave` is idempotent.
- All commands return `Result<_, String>` with messages a user can act on.

Events on the channel (`type` tag, camelCase):

| Event | Receiver | Payload |
|---|---|---|
| `peerJoined` | host | `id`, `name` |
| `peerLeft` | host | `id`, `reason`: `left`, `lost`, `removed` |
| `peerStatus` | host | `id`, `status` |
| `peerPing` | host | `id`, `pingId`, `sentAt` |
| `inviteChanged` | host | `invite` |
| `state` | guest | `state` |
| `roster` | guest | `participants` |
| `pong` | guest | `pingId`, `sentAt`, `hostTime` |
| `link` | guest | `status`: `connected` or `reconnecting` |
| `route` | both | `id`, `route`: `direct` or `relay` |
| `closed` | both | `reason`: `ended`, `removed`, `full`, `locked`, `hostLost`, `failed` |

Browser preview: `src/lib/backend/preview-room.ts` implements all six commands with a scripted room. Hosting adds two simulated guests that go from loading to ready. Joining plays the Sintel fixture under a simulated host that pauses and seeks on a timer. `RoomTransport` creates a Tauri `Channel` in the desktop app and a plain object with `onmessage` in preview, because `Channel` depends on the Tauri runtime.

## 10. UI

Entry points:

- A "Watch together" button in `AppNavigation.svelte`, next to Account settings, with the participant count while in a room.
- A room pill in the player top bar, because the header is hidden in theater and full-screen modes.

`RoomPanel.svelte` is a modal dialog that does not change `activeView`, so opening it never triggers the leave-Player auto-pause. It follows the existing queue dialog pattern (`role="dialog"`, `aria-modal`, Escape closes, click outside closes) and uses Lily `Card`, `Button`, `Input`, `InputGroup`, `Badge`, `Progress`, `Spinner`, `Alert`, and `Tooltip`.

Panel states:

| State | Content |
|---|---|
| Not in a room | Display name field. "Host a room". "Join with a code" input and button. The join notice (section 11). |
| Connecting | Spinner, cancel. |
| Hosting | Invite code with a copy button, roster, "Lock room" switch, "Stop for everyone", "End room". |
| Joined | Host name, roster, own link state, "Leave room". |
| Error | What failed and what to do, retry. |

Roster rows show name, host marker, and a state badge: Ready, Loading with a percentage, Away, Error. The host sees direct or relayed, and a remove button per guest.

Player:

- While the room is held: "Waiting for Alice" or "Waiting for Alice and 2 others" in the existing buffering overlay style. The host also gets "Play anyway".
- A guest with no room media sees "Waiting for the host to pick something."
- `PlayerTransport.svelte` gets a `transportLocked` prop that disables play, seek buttons, and the timeline, with the hint "The host controls playback". Volume, theater, and full screen stay enabled.
- `shortcuts.ts` gets a `roomPanelOpen` context flag so Escape closes the panel first.

Other:

- The display name is saved as `roomDisplayName` in `src/lib/settings.ts`, normalized on load like the other settings.
- Copying uses `navigator.clipboard.writeText` with a fallback that selects the code. No clipboard plugin or permission.
- Every state has a label, focus order, and a keyboard path. Status changes use `aria-live="polite"`. Motion follows the existing reduced-motion handling.
- Names and titles from peers are rendered as text only, never as HTML.

## 11. Security and privacy

What changes: while a room is open, StreamsPlease holds one QUIC endpoint that is reachable from other machines. This is the first non-loopback listener in the app, so it is a deliberate, scoped exception and it is recorded in `AGENTS.md`.

- The endpoint exists only during a room and serves only the room ALPN.
- The torrent stream server stays on `127.0.0.1`, read-only. No media and no file paths cross the room connection.
- Connections are encrypted and authenticated by iroh with the room key pair. Relays forward ciphertext.
- Nothing is published to DNS, no port is mapped on the router, no metrics are sent, no key is stored.

Threats and answers:

| Threat | Answer |
|---|---|
| A stranger gets the invite | The endpoint id is a random 256-bit key, so it cannot be guessed. The roster shows every guest. The host can remove a guest and lock the room. Removing alone is not enough, because a guest gets a new key on every join; the lock is what keeps a removed guest out. The invite dies when the room ends. |
| A guest floods or sends garbage | Frame cap, strict parsing, rate limit, bounded queues; violations close the connection. |
| A guest pretends to load forever | "Play anyway", remove. |
| A host sends a harmful media descriptor | Strict validation of every field; the magnet goes through the same checks and file filter as any other magnet; images only load from the existing `img-src` origins. |
| A host makes guests download something they did not choose | Stated before joining (below). The guest can leave at any time. The 10 GB cache cap and seeding policy apply as usual. |
| A crafted invite points to a hostile relay | Relays are matched against the built-in relay map. |
| The relay operator | Sees IP addresses and endpoint ids, not content. |

Join notice, shown in the panel next to the join button:

> The host chooses what plays. StreamsPlease downloads it over BitTorrent and seeds it like any other episode. The host can see your IP address.

IP addresses: the host and each guest see each other's address once the path is direct. Guests do not connect to each other. All participants are also in the same BitTorrent swarm, where addresses are visible anyway.

## 12. Phases

Each phase ends with the checks in `AGENTS.md` green. `main` stays releasable: the header button is only shown in development builds until Phase 5 is done.

### Phase 0: transport spike

Goal: prove iroh fits before anything depends on it. Work on a branch; keep only what Phase 3 reuses.

1. Add the dependency. Record the build-time change, the installer-size change, and duplicate crates (`cargo tree -d`; iroh brings `reqwest` 0.13 next to the app's 0.12).
2. Confirm the local Rust version is 1.91 or newer and that the release workflow builds on `windows-latest`.
3. Exchange one frame between two endpoints in a test, on loopback with relays disabled.
4. Connect two machines on different networks. Record time to connect, whether the path becomes direct, and that relay-only works with UDP blocked.
5. Check whether Windows Firewall prompts on the first bind, and what happens when the prompt is declined.
6. Confirm the assumptions in section 5: `presets::N0` with cleared address lookup, `online()`, the invite built from `addr()`, the relay match against `default_relay_map()` (also across iroh versions), and path type from `Connection::paths()`.
7. Verify the two-instance recipe: a second `tauri dev` with a config overlay that changes `identifier` and clears `beforeDevCommand`, and its own `CARGO_TARGET_DIR`. The identifier gives it its own cache, torrent session, and WebView storage.

Exit: two machines exchange frames over a direct path and over relay only, the build and size costs are accepted, and the results are written into this file. If iroh fails here, stop and choose another transport. Phases 1 and 2 do not depend on it.

#### Phase 0 results

Measured 2026-11-27 on the development machine with Rust 1.91.1 (MSVC), released in v0.9.2.

Phase 3 kept the dependency, the lock fix, and `src-tauri/tauri.second-instance.conf.json`. The spike was `src-tauri/examples/room_spike.rs` (`host`, `join <invite>`, `--relay-only`, and four tests); Phase 3 replaced it with `src-tauri/src/room/` and deleted it.

| Step | Result |
|---|---|
| 1. Build time | Clean optimized build 117 s before, 124 s after. `Cargo.lock` gains 126 crates (614 to 740). |
| 1. Size | Without room code the app binary is unchanged (24.2 MB; the linker drops unused iroh). With the spike's host and join code wired into the app it is 31.3 MB, or 5.5 MB to 7.2 MB LZMA-compressed. The 83.7 MB v0.9.1 installer would grow by about 1.7 MB (2%). |
| 1. Duplicates | New duplicate families: `windows` 0.61 and 0.62 with their `windows-*` crates; RustCrypto `digest`, `sha2`, `block-buffer`, `crypto-common`, and `cpufeatures` in two generations; `rand` and `rand_core` 0.10; `lru`; `typenum`; `syn` 1. `reqwest` 0.13 is not new: the updater already brings it. |
| 2. Toolchain | Local 1.91.1 builds and passes the tests. CI's `stable` is newer than 1.91; the first CI build with iroh happens at the next release. |
| 3. Loopback | `cargo test --manifest-path src-tauri/Cargo.toml --example room_spike`: 4 pass (frame exchange on loopback with relays disabled, invite round trip, invite rejection, oversized frame). |
| 4. Two machines | Open. On one machine through the real relays: online after 354 ms, connected after 226 ms, `welcome` after 300 ms, direct by the next ping at about 2.3 s, then sub-millisecond round trips. With `--relay-only` on both sides: online after 1.1 s, connected after 189 ms, about 55 ms round trips through `euc1-1`, and the path stays relayed. |
| 5. Firewall | Open for a second machine. On this machine the installed and development `streamsplease.exe` already have program-wide Windows inbound allow rules, most likely from the prompt for the torrent engine's DHT socket, so the room endpoint adds no prompt for them. The spike executable has no rule and still reached a direct path on one machine. |
| 6. API | Confirmed in the iroh 1.5.0 source. `online()` waits for a connected home relay and has no timeout of its own. `addr()` holds the home relay URLs, possibly more than one, and the IP addresses. `default_relay_map()` holds `use1-1`, `usw1-1`, `euc1-1`, and `aps1-1` under `relay.n0.iroh.link.`, unchanged from 1.0.0 to 1.5.0; 0.98 used other hostnames, so the match only holds within 1.x. The selected path is the one in `paths()` with `is_selected()`; `is_ip()` means direct and `is_relay()` means relayed; `path_events()` streams changes. Corrections are in section 5: the endpoint preset, and the trailing dot on relay hostnames. |
| 7. Two instances | Blocked. librqbit keeps its DHT routing table, with a fixed UDP port, in `%LOCALAPPDATA%\rqbit\dht\cache\dht.json`, shared by every rqbit program on the account; here the port is 65528. A second instance loads that file, fails to bind the port, and the app's setup fails with "initializing torrent engine". Fixed in Phase 3: a `dht_config` in `session_options` (`src-tauri/src/torrent.rs`) keeps the file at `dht/dht.json` in the app cache directory; existing installs rebuild their DHT table once. The overlay and the recipe below are still to be run. |

Two-instance recipe, not yet run. The first instance also starts Vite:

```powershell
npm run tauri dev
```

The second, in another terminal:

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'src-tauri\target\second'
npm run tauri dev -- --config src-tauri/tauri.second-instance.conf.json
```

Two-machine run for steps 4 and 5: the spike executable no longer exists, so these checks run with the app itself in Phase 4 (matrix rows 1 and 17). Record the connect time and the route, answer or decline the firewall prompt, then block UDP for the program on the guest and run it again.

### Phase 1: sync core (done)

Done in `02391b1`: `npm run check` 0 errors, `npm test` 212 pass, `npm run build` ok. No native check applies, because nothing in the app uses the code yet.

Goal: the whole sync model in pure TypeScript with tests, no network and no UI.

Files: `src/lib/room/protocol.ts`, `clock.ts`, `readiness.ts`, `reconcile.ts`, `host-controller.ts`, `guest-controller.ts`; `bufferedSecondsAhead` in `src/lib/torrent/media.ts`.

Controllers take `{ transport, port, now, setTimer }` so tests use a fake transport, a fake port, and a fake clock. No constructor parameter properties or enums, because the Node test runner only strips types.

Tests:

- `room-protocol.test.ts`: guards accept valid input and reject unknown types, extra fields, non-finite numbers, oversized strings, bad magnets.
- `room-clock.test.ts`: lowest round-trip sample wins, jitter, window eviction.
- `room-readiness.test.ts`: every phase, hysteresis, missing piece map.
- `room-reconcile.test.ts`: one case per row of the reconciler table, plus actions in flight.
- `room-host.test.ts`: load, wait, open; hold on a stall and resume; late joiner; guest leaves while blocking; "Play anyway" and its expiry; seek bumps the epoch; a `ready` for an old epoch is ignored; coalesced broadcasts; end of file; speed re-anchor.
- `room-guest.test.ts`: stale `seq` ignored; scheduled start cancelled by a newer state; status on change and heartbeat; detach and attach; reset after reconnect.
- `torrent-media.test.ts`: `bufferedSecondsAhead` on piece maps with gaps, file offsets, and the end of the file.

Exit: `npm run check`, `npm test`, `npm run build`.

### Phase 2: playback seams

Goal: the app can be driven through `PlaybackPort`; solo behavior is identical.

1. `startPaused` in `episode-stream.ts` and `beginEpisode`; update `tests/episode-stream.test.ts`.
2. `TorrentSession.stop()`; update `tests/torrent-session.test.ts`.
3. Intent and apply split for play, pause, seek, speed, and episode start in `StreamsPleaseApp.svelte`.
4. The local snapshot, with nothing listening yet. Confirm it fires after every load and seek (section 7, the reconciler).

Done in v0.9.1: `npm run check` 0 errors, `npm test` 215 pass, `npm run build` ok. Native checks not run yet.

- Intents: `togglePlayback`, `pausePlayback`, `requestSeek` (behind `seekRelative` and `seekAbsolute`), `cycleSpeed`, `requestEpisode`. Applies: `applyPaused`, `scheduleSeek`, `applySpeed`, `startEpisode(request, { startAt, startPaused })`, `stopEpisode`. Phase 4 builds `PlaybackPort` from the applies.
- `episodeStartsPaused` is set per start and also read by stream retries.
- `requestEpisode` flushes the resume point before it reads `savedResumeTime`; `startEpisode` does not flush. The guest's `PlaybackPort.load` must flush before it calls `startEpisode`.
- `stopEpisode` flushes the resume point, bumps the episode generation, runs `TorrentSession.stop()`, and sets `phase` to `idle` unless a newer episode request started meanwhile.
- The snapshot is the `$derived` `localPlayback`; `positionSampledAt` comes from `localNow()` in `src/lib/room/clock.ts` on every `time-pos` event and preview tick. A `$derived` is lazy, so it costs nothing until Phase 4 reads it.
- Solo never starts paused and nothing calls `stopEpisode` yet. The paused-load and stop checks need a temporary trigger, such as `startPaused: true` in `requestEpisode`, or they move to Phase 4.

Native checks in `npm run tauri dev`:

- Solo regression: start, pause, seek, speed, trailer and return, next episode, resume point, stream retry.
- Loading with pause on: the stream reaches the `ready` phase and shows the first frame without playing. This is the one new mpv behavior the plan relies on, so it is checked here, early.
- Stop: the player returns to idle and the torrent is released.

Exit: frontend checks plus the native checks above.

### Phase 3: Rust transport and IPC

Goal: two apps can exchange validated room messages.

1. `protocol.rs`: types, limits, validation, frame codec generic over async read and write. The event and outbound shapes must match `src/lib/room/protocol.ts`, including the `peerLeft` reasons.
2. `invite.rs`.
3. `host.rs` and `guest.rs`: lifecycle from section 5, per-peer reader and writer tasks, token-bucket rate limit, silence timeout, room lock, `welcome` from the cached state and roster.
4. `mod.rs`: `RoomService` managed in `lib.rs` (not `RoomState`, which is the wire type), the six commands, the event enum. Blocking work stays off async paths. A failed `Channel` send ends the session.
5. Frontend contract: `commands.ts`, `types.ts`, `transport.ts`, `preview-room.ts`, and the preview handler map.

Rust tests beside the code:

- Codec: round trip, oversized length rejected before allocation, truncated frame, invalid JSON.
- Validation: each rule in section 6, direction enforcement.
- Invite: round trip; wrong prefix, bad id, unknown relay, and overlong input rejected.
- Rate limiter with an injected clock.
- Admission: room full, room locked, hello timeout, same id returned on reconnect.
- Integration on loopback with relays disabled: hello and welcome, state and status both ways, remove, host close, guest reconnect.

Exit: `cargo fmt --check`, `cargo test`, `cargo check`, and the frontend checks. The contract is updated in all four places together.

Done: `cargo fmt --check` clean, `cargo test` 133 pass (25 in `room::`), `cargo check` ok, `npm run check` 0 errors, `npm test` 221 pass, `npm run build` ok. No native check was run: the commands are registered but nothing calls them, and the DHT change needs one start of `npm run tauri dev` to confirm.

As built:

- Wire messages nest their payload exactly like the IPC shapes: `{ type: 'status', status }`, `{ type: 'state', state }`, `{ type: 'roster', participants }`. `bye` is `{ type: 'bye' }`; serde only rejects unknown fields on struct variants, so it is declared as an empty struct variant.
- `welcome` reaches the guest frontend as three events: `link` connected, `state`, `roster`. The same three follow every reconnect. They can arrive before the `room_join` promise resolves.
- `room_host` and `room_join` bump a generation and close the previous session first. `room_leave` during a pending host or join makes it fail with "The room was left before it was ready.", so Cancel works while connecting.
- A guest dropped as `lost` keeps its id for 30 seconds (twice the reconnect window). A returning guest passes the lock but not the room limit. A guest that left or was removed gets a new id.
- A guest whose reconnect returns another id ends with `hostLost`. A host that breaks the rules (rate, invalid message, second `welcome`) ends the guest's room with `failed`.
- At most 16 connections may be waiting for `hello`; more are refused.
- A full outbound queue on the guest drops the link and reconnects. Messages sent while reconnecting are dropped.
- Routes are read when a frame arrives and reported on change; the guest reports the host as id 0.
- `inviteChanged` is not emitted yet (Phase 6). The TypeScript guard already accepts it.
- There is one ALPN version, so a version mismatch cannot be told apart from an unreachable host yet. The specific message comes with the second version.
- Timeouts live in `Timing` (`protocol.rs`) so the loopback tests can shorten the hello, reconnect, and farewell waits.
- `BackendRoomTransport` (`transport.ts`) ignores events from a channel that a newer room replaced and does not send outside a room. Send failures go to `onError`.
- `PreviewRoom` takes the fixture media, a clock, and a timer. As host it adds Alice (direct) and Mika (relayed), who load and become ready on every new epoch. As guest it plays under "Preview host": start when the guest is ready, pause after 20 seconds, seek 60 seconds ahead 3 seconds later, and repeat. It does not hold for a stalled guest yet (Phase 5).

### Phase 4: host and guest end to end

Goal: a real room works between two apps, with a minimal panel behind the development flag.

1. `session.svelte.ts`: role state machine (`solo`, `connecting`, `host`, `guest`), controller ownership, cleanup on leave and on `closed`, generations so late async results cannot touch a newer session.
2. Wire `RoomSession` into `StreamsPleaseApp.svelte`: the port, the intents by role, the snapshot effect, attach and detach from view, trailer, and visibility, `playingEpisode` from room media for guests, the next-episode prompt hidden for guests, the room speed shown for guests.
3. Minimal `RoomPanel`: name, host, join, leave, plain roster.
4. `tests/room-session.test.ts` with a fake transport: role transitions, leave during connect, `closed` reasons, no state change after dispose.

Exit: the Phase 4 rows of the manual matrix in section 13 pass between two machines, and the solo regression passes again.

### Phase 5: UI

Goal: the feature is complete for users and for the browser preview.

1. `RoomPanel`, `RoomRoster`, `RoomStatusPill`, the header button, the player waiting overlay, "Play anyway", "Stop for everyone", remove, lock.
2. `transportLocked` in `PlayerTransport.svelte`; the guest notice when starting an episode.
3. `roomDisplayName` in settings with a test in `tests/settings.test.ts`; `roomPanelOpen` in `shortcuts.ts` with a test in `tests/player-helpers.test.ts`.
4. Join notice, copy with fallback, error and empty states, keyboard and screen-reader pass.
5. Preview simulation polished enough to show every panel and player state.
6. Remove the development flag.

Exit: frontend checks; the Phase 5 rows of the manual matrix pass; the browser preview shows hosting, joining, waiting, locked controls, and errors; visual review by the user.

### Phase 6: hardening

1. Tune the constants and the soft drift correction against drift measured between two machines.
2. Guest reconnect and the `hostLost` path; the host keeps the participant id for a returning endpoint.
3. `inviteChanged` when the home relay changes.
4. A clean `closed` or `bye` when the app window closes.
5. Seek storms: hold a key on the host for 10 seconds and check that guests settle.
6. Long run: a full episode with two guests, drift logged.

Exit: the Phase 6 rows pass, the whole matrix passes once more, and no run ends in an access violation.

### Phase 7: documentation and release

1. `README.md`: feature list, architecture diagram, a "Watch together" usage section, privacy notes, limitations (relay needed for the first contact, 8 participants, Windows only verified). Reword the existing "does not open an inbound peer port" limitation so it clearly refers to BitTorrent.
2. `AGENTS.md`: source map entries for `src/lib/room/`, `src-tauri/src/room/`, and the components; new invariants (below); two-machine check under validation.
3. Release as a minor version through the existing release workflow.

Invariants to add to `AGENTS.md`:

- The room endpoint exists only while hosting or joined, serves only the room ALPN, and carries control messages only.
- Every room message is validated in Rust in both directions and narrowed from `unknown` in TypeScript.
- Guests never control playback. The host is the only writer of room state.
- Room sync uses existing `MpvCommands` methods only.

## 13. Validation

Automated, every phase:

```powershell
npm run check
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Manual matrix, Windows, two machines on different networks unless noted:

| # | Phase | Check | Expected |
|---|---|---|---|
| 1 | 4 | Host a room, join with the code | Roster shows both names; path becomes direct. |
| 2 | 4 | Host starts an episode | Both load paused and start together; on-screen times differ by less than 0.1 s. |
| 3 | 4 | Host pauses and resumes | Both stop on the same frame; both resume together. |
| 4 | 4 | Host scrubs and uses ±10 s | Both land on the position; the room resumes when both are ready. |
| 5 | 4 | Host changes speed | Both change; sync holds for 5 minutes at 2×. |
| 6 | 4 | Guest on a slow or poorly seeded torrent | Host does not start; roster shows loading; starts when ready. |
| 7 | 4 | Guest stalls mid-episode | Room pauses, shows who is awaited, resumes by itself. |
| 8 | 4 | Guest joins mid-episode | Room holds until the guest is ready, then resumes at the same position. |
| 9 | 4 | Next episode from the prompt | Guests follow to the next episode. |
| 10 | 4 | Guest leaves the Player view, opens a trailer, hides the window, returns | Away without holding the room; resyncs on return. |
| 11 | 4 | Host leaves the Player view, opens a trailer | Room pauses; host playback restores paused. |
| 12 | 5 | "Play anyway" | Room plays; the guest catches up; a later stall holds again. |
| 13 | 5 | "Stop for everyone" | Guests return to the waiting state and release the torrent. |
| 14 | 5 | Remove a guest and lock the room; that guest rejoins; unlock | Removed; the rejoin is refused while locked and works after unlocking. |
| 15 | 6 | Guest network drops for 5 s, then for 30 s | Reconnects with the same roster entry; then ends with a clear message, paused in solo. |
| 16 | 6 | Host quits the app | Guests are released to solo within 15 s. |
| 17 | 6 | UDP blocked on the guest | Works over the relay; roster shows relayed. |
| 18 | 6 | Rapid seeks and repeated loads, twice | No `0xc0000005` exit. |
| 19 | 2, 4, 6 | Solo regression | Unchanged. |

Browser preview validates layout and state handling only. It does not validate IPC, iroh, librqbit, mpv, or sync quality.

## 14. Risks

| Risk | Mitigation |
|---|---|
| iroh adds build time and binary size | Measured in Phase 0: 7 s on a clean optimized build, about 1.7 MB on the installer. `reqwest` 0.13 was already in the graph. |
| The public relays are someone else's infrastructure | Rooms fail with a clear message; solo is unaffected. `RelayMode::Custom` allows an own relay later without protocol changes. |
| The relay list differs between iroh versions, so an invite is refused | Checked in Phase 0: unchanged from 1.0.0 to 1.5.0. Check it again on every iroh upgrade; fall back to matching the relay domain if it changes. |
| mpv does not signal readiness the same way when loaded paused | Checked natively in Phase 2, before the sync work depends on it. |
| Bytes-to-time buffer estimate is off for variable bitrate | 10 second margin; an mpv stall is always the authority; the room recovers by holding. |
| Hold and resume flapping | Hysteresis, settle delay, coalesced seeks. Tuned in Phase 6. |
| More frequent mpv calls from drift correction | Rate-limited; existing typed calls only; stress run in the matrix. |
| `StreamsPleaseApp.svelte` grows further (1,725 lines today) | Logic lives in `src/lib/room/`; the app gets the port, the role checks, and component tags. |
| Timers slow down in a hidden WebView | A hidden host has already paused the room; a hidden guest is away; the silence timeout is 15 s. |
| Windows Firewall prompt when the endpoint binds | The app already has inbound rules from the torrent engine's prompt. On one machine the spike reached a direct path without a rule; the second-machine check is open. Documented in the README. |
| Version skew between friends, since updates need consent | One ALPN per protocol version; a clear message on mismatch; hosts accept every version they still support. |

## 15. Open questions

1. Resolved: decisions 1 to 6 in section 3 are confirmed.
2. Should the host see a guest's download speed or peer count in the roster, to judge whether waiting is worthwhile? Not planned.
3. Should "Play anyway" become a remembered setting ("never wait for late joiners")? Not planned; decide after real use.
