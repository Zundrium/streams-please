import assert from 'node:assert/strict';
import test from 'node:test';
import { episodeMediaUrl, openEpisodeStream, resumeOptions, type EpisodeStreamDeps } from '../src/lib/player/episode-stream.ts';
import type { MpvCommands, MpvSession } from '../src/lib/player/mpv-client.ts';
import type { CurrentTorrent } from '../src/lib/types.ts';

const torrent: CurrentTorrent = {
  id: 3,
  fileId: 0,
  details: { info_hash: 'x', output_folder: '' },
  video: { name: 'Show #01.mkv', components: [], length: 1, included: true }
};
const streamUrl = 'http://127.0.0.1:9/torrents/3/stream/0';

function fakeMpv(probe: { path?: string | null; pausedForCache?: boolean; time?: number | null } = {}) {
  const calls: string[] = [];
  const commands = {
    setMargins: async () => void calls.push('margins'),
    loadFile: async (url: string, options?: string) => void calls.push(`load ${url} ${options ?? ''}`.trim()),
    setFlag: async (name: string, value: boolean) => void calls.push(`${name}=${value}`),
    readPath: async () => probe.path ?? `${streamUrl}/x`,
    readPausedForCache: async () => probe.pausedForCache ?? false,
    readTimePosition: async () => (probe.time === undefined ? 0 : probe.time)
  } as unknown as MpvCommands;
  const session: MpvSession = { commands, run: (operation) => operation(commands) };
  return { session, calls };
}

function deps(session: MpvSession, patch: Partial<EpisodeStreamDeps> = {}): EpisodeStreamDeps {
  return {
    mpv: session,
    streamUrl: async () => streamUrl,
    isActive: () => true,
    isReady: () => false,
    markReady: () => undefined,
    margins: () => ({ top: 0 }),
    resumeAt: () => 0,
    livePeers: () => 0,
    startTimeoutMs: 40,
    probeIntervalMs: 5,
    ...patch
  };
}

test('media urls encode the file name and resume options use whole seconds', () => {
  assert.equal(episodeMediaUrl(streamUrl, torrent), `${streamUrl}/Show%20%2301.mkv`);
  assert.equal(resumeOptions(0), undefined);
  assert.equal(resumeOptions(0.9), undefined);
  assert.equal(resumeOptions(125.7), 'start=125');
});

test('opening a stream loads the file, unpauses, and marks ready once mpv plays it', async () => {
  const { session, calls } = fakeMpv();
  let ready = false;
  await openEpisodeStream(torrent, deps(session, { resumeAt: () => 90.4, markReady: () => (ready = true) }));
  assert.deepEqual(calls, ['margins', `load ${streamUrl}/Show%20%2301.mkv start=90`, 'pause=false']);
  assert.ok(ready);
});

test('a superseded attempt stops before touching mpv', async () => {
  const { session, calls } = fakeMpv();
  let active = true;
  await openEpisodeStream(torrent, deps(session, {
    streamUrl: async () => {
      active = false;
      return streamUrl;
    },
    isActive: () => active
  }));
  assert.deepEqual(calls, []);
});

test('probing ignores media from a different url and explains timeouts', async () => {
  const { session } = fakeMpv({ path: 'http://elsewhere/video' });
  await assert.rejects(openEpisodeStream(torrent, deps(session)), /no reachable peers/);
  const buffering = fakeMpv({ pausedForCache: true });
  await assert.rejects(
    openEpisodeStream(torrent, deps(buffering.session, { livePeers: () => 2 })),
    /did not receive a playable video segment/
  );
});

test('probing stops early when the stream is already ready', async () => {
  const { session } = fakeMpv({ time: null });
  let marked = false;
  await openEpisodeStream(torrent, deps(session, { isReady: () => true, markReady: () => (marked = true) }));
  assert.ok(!marked);
});
