import type { VideoMarginRatio } from 'tauri-plugin-libmpv-api';
import { delay } from '$lib/async/polling';
import type { MpvCommands, MpvSession } from '$lib/player/mpv-client';
import type { CurrentTorrent } from '$lib/types';

export type EpisodeStreamDeps = {
  mpv: MpvSession;
  streamUrl: (torrent: CurrentTorrent) => Promise<string>;
  isActive: () => boolean;
  isReady: () => boolean;
  markReady: () => void;
  margins: () => VideoMarginRatio | null;
  resumeAt: () => number;
  startPaused: () => boolean;
  livePeers: () => number;
  startTimeoutMs: number;
  probeIntervalMs: number;
};

export function episodeMediaUrl(streamUrl: string, torrent: CurrentTorrent): string {
  return `${streamUrl}/${encodeURIComponent(torrent.video.name)}`;
}

export function resumeOptions(seconds: number): string | undefined {
  const start = Math.floor(seconds);
  return start > 0 ? `start=${start}` : undefined;
}

export async function openEpisodeStream(
  torrent: CurrentTorrent,
  deps: EpisodeStreamDeps
): Promise<void> {
  if (!deps.isActive()) return;
  const streamUrl = await deps.streamUrl(torrent);
  const url = episodeMediaUrl(streamUrl, torrent);
  const options = resumeOptions(deps.resumeAt());
  if (!deps.isActive()) return;
  await deps.mpv.run(async (mpv) => {
    if (!deps.isActive()) return;
    const margins = deps.margins();
    if (margins) await mpv.setMargins(margins);
    if (!deps.isActive()) return;
    await mpv.loadFile(url, options);
    await mpv.setFlag('pause', deps.startPaused());
  });
  if (!deps.isActive()) return;
  await waitForPlaybackStart(streamUrl, deps.mpv.commands, deps);
}

async function waitForPlaybackStart(
  streamUrl: string,
  mpv: MpvCommands,
  deps: EpisodeStreamDeps
): Promise<void> {
  const deadline = Date.now() + deps.startTimeoutMs;
  let verifiedPath = false;
  while (deps.isActive() && Date.now() < deadline) {
    if (deps.isReady()) return;
    if (!verifiedPath) {
      const path = await mpv.readPath().catch(() => null);
      verifiedPath = typeof path === 'string' && path.startsWith(streamUrl);
    }
    const pausedForCache = await mpv.readPausedForCache().catch(() => true);
    const time = await mpv.readTimePosition().catch(() => null);
    if (!deps.isActive()) return;
    if (verifiedPath && pausedForCache === false && typeof time === 'number' && Number.isFinite(time)) {
      deps.markReady();
      return;
    }
    await delay(deps.probeIntervalMs);
  }
  if (!deps.isActive()) return;
  throw new Error(
    deps.livePeers() === 0
      ? 'There are no reachable peers for this torrent yet.'
      : 'mpv did not receive a playable video segment in time.'
  );
}
