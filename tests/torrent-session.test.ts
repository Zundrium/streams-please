import assert from 'node:assert/strict';
import test from 'node:test';
import { TorrentSession, type TorrentBackend } from '../src/lib/torrent/session.ts';
import type { AddTorrentResponse, CurrentTorrent, TorrentFile } from '../src/lib/types.ts';

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(condition());
}

function file(name: string, length = 10): TorrentFile {
  return { name, components: [name], length, included: true };
}

function response(id: number, files: TorrentFile[] = [file('episode.mkv')]): AddTorrentResponse {
  return { id, output_folder: '', details: { info_hash: String(id), output_folder: '', files } };
}

function harness(add: TorrentBackend['addMagnet'], release: TorrentBackend['release'] = async () => undefined) {
  const events: string[] = [];
  const released: number[] = [];
  const session = new TorrentSession(
    {
      addMagnet: add,
      release: async (id) => {
        released.push(id);
        await release(id);
      }
    },
    {
      stopPlayback: async (previous) => void events.push(`stop ${previous.id}`),
      onCleared: () => events.push('cleared'),
      onStarted: (torrent: CurrentTorrent) => void events.push(`started ${torrent.id}`)
    }
  );
  return { session, events, released };
}

test('starting a torrent selects its video and replaces the previous session', async () => {
  let next = 1;
  const { session, events, released } = harness(async () => response(next++, [file('a.ass'), file('a.mkv', 50)]));
  const first = await session.start('magnet:?xt=urn:btih:a');
  assert.equal(first.status, 'started');
  assert.equal(session.current?.fileId, 1);
  await session.start('magnet:?xt=urn:btih:b');
  assert.deepEqual(events, ['started 1', 'stop 1', 'cleared', 'started 2']);
  assert.deepEqual(released, [1]);
  assert.equal(session.current?.id, 2);
});

test('a start issued while another is mid-flight supersedes it and releases its torrent', async () => {
  const releases: Array<() => void> = [];
  let next = 10;
  const { session, released } = harness(
    () =>
      new Promise((resolve) => {
        const id = next++;
        releases.push(() => resolve(response(id)));
      })
  );
  const first = session.start('magnet:?first');
  await waitFor(() => releases.length === 1);
  const second = session.start('magnet:?second');
  releases[0]();
  assert.deepEqual(await first, { status: 'superseded' });
  assert.deepEqual(released, [10]);
  await waitFor(() => releases.length === 2);
  releases[1]();
  assert.equal((await second).status, 'started');
  assert.equal(session.current?.id, 11);
});

test('back-to-back starts skip the superseded one before it reaches the engine', async () => {
  const added: string[] = [];
  const { session, released } = harness(async (magnet) => {
    added.push(magnet);
    return response(added.length);
  });
  const [first, second] = await Promise.all([session.start('magnet:?a'), session.start('magnet:?b')]);
  assert.deepEqual(first, { status: 'superseded' });
  assert.equal(second.status, 'started');
  assert.deepEqual(added, ['magnet:?b']);
  assert.deepEqual(released, []);
});

test('torrents without a playable video are released and reported', async () => {
  const { session, released } = harness(async () => response(4, [file('notes.txt')]));
  await assert.rejects(session.start('magnet:?x'), /does not contain a supported video file/);
  assert.deepEqual(released, [4]);
  assert.equal(session.current, null);
});

test('a failed release or stop never blocks the next start', async () => {
  let next = 1;
  const { session } = harness(
    async () => response(next++),
    async () => {
      throw new Error('already gone');
    }
  );
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await session.start('magnet:?a');
    const result = await session.start('magnet:?b');
    assert.equal(result.status, 'started');
  } finally {
    console.warn = originalWarn;
  }
});

test('engine errors surface only for the latest start', async () => {
  let fail = true;
  const { session } = harness(async () => {
    if (fail) throw new Error('engine down');
    return response(1);
  });
  await assert.rejects(session.start('magnet:?a'), /engine down/);
  const stale = session.start('magnet:?b');
  fail = false;
  const latest = session.start('magnet:?c');
  assert.deepEqual(await stale, { status: 'superseded' });
  assert.equal((await latest).status, 'started');
});
