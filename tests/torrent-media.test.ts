import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseVideoFile,
  formatBytes,
  inferPieceLength,
  normalizeTracks,
  readableTitle,
  torrentPieceRanges
} from '../src/lib/torrent/media.ts';
import type { CurrentTorrent, TorrentFile, TorrentStats } from '../src/lib/types.ts';

function file(name: string, length: number): TorrentFile {
  return { name, components: [name], length, included: true };
}

test('chooses the largest supported video file and ignores subtitles', () => {
  const files = [file('show.en.ass', 90_000), file('sample.mp4', 5_000), file('Show.MKV', 900_000)];
  assert.deepEqual(chooseVideoFile(files), { file: files[2], fileId: 2 });
  assert.equal(chooseVideoFile([file('notes.txt', 10)]), undefined);
  assert.equal(chooseVideoFile(undefined), undefined);
});

test('formats byte counts and release file names for display', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1_294_727_168), '1.21 GB');
  assert.equal(readableTitle('[SubsPlease] Black_Torch.-.01.(1080p).mkv'), 'Black Torch - 01 (1080p)');
});

test('normalizes observed mpv tracks and drops entries without a usable integer id', () => {
  assert.deepEqual(normalizeTracks(null), []);
  assert.deepEqual(
    normalizeTracks([
      { id: 2, type: 'audio', lang: 'jpn', selected: true },
      { id: 'x', type: 'sub' },
      { id: 0, type: 'sub' },
      { id: 3, type: 'chapter' },
      null
    ]),
    [{ id: 2, type: 'audio', lang: 'jpn', title: undefined, codec: undefined, selected: true, external: false }]
  );
});

test('maps downloaded pieces onto the selected file timeline', () => {
  assert.equal(inferPieceLength(0, 10), 0);
  assert.equal(inferPieceLength(16 * 2 ** 20, 16), 2 ** 20);

  const files = [file('a.ass', 2 ** 20), file('b.mkv', 3 * 2 ** 20)];
  const torrent: CurrentTorrent = {
    id: 1,
    details: { info_hash: 'x', output_folder: '', files },
    video: files[1],
    fileId: 1
  };
  const stats = {
    total_bytes: 4 * 2 ** 20,
    pieces: [true, true, false, true]
  } as TorrentStats;
  const ranges = torrentPieceRanges(stats, torrent, 600);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].start, 0);
  assert.ok(Math.abs(ranges[0].end - 100 / 3) < 1e-9);
  assert.ok(Math.abs(ranges[1].start - 200 / 3) < 1e-9);
  assert.equal(ranges[1].end, 100);
  assert.deepEqual(torrentPieceRanges(stats, torrent, 0), []);
});
