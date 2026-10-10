import assert from 'node:assert/strict';
import test from 'node:test';
import type { MpvEvent } from 'tauri-plugin-libmpv-api';
import {
  MAX_TRAILER_STREAM_RETRIES,
  TrailerPlayerController,
  trailerStreamEndedEarly,
  type TrailerPlaybackState
} from '../src/lib/trailer-player.ts';

const REQUEST = { url: 'ytdl://ytsearch1:Frieren trailer English subtitles', title: 'Frieren · Trailer' };

function harness() {
  let now = 1_000_000;
  let entry = 0;
  const loads: string[] = [];
  const seeks: number[] = [];
  let state: TrailerPlaybackState | null = null;
  const controller = new TrailerPlayerController<object>(
    {
      open: () => ({}),
      prepare: async () => undefined,
      load: async (request) => {
        loads.push(request.url);
      },
      abort: async () => undefined,
      teardown: async () => undefined,
      setPaused: async () => undefined,
      seek: async (time) => {
        seeks.push(time);
      },
      setVolume: async () => undefined,
      setMuted: async () => undefined
    },
    (next) => {
      state = next;
    },
    () => undefined,
    () => now
  );
  const event = (value: Record<string, unknown>) => controller.handleEvent(value as unknown as MpvEvent);
  return {
    controller,
    loads,
    seeks,
    state: () => state,
    advance: (ms: number) => {
      now += ms;
    },
    becomeReady: () => {
      if (entry > 0) event({ event: 'end-file', reason: 'stop', playlist_entry_id: entry });
      entry += 1;
      event({ event: 'start-file', playlist_entry_id: entry });
      controller.handleProperty('duration', 130);
      event({ event: 'file-loaded' });
      event({ event: 'playback-restart' });
    }
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('an instant jump to the end is recognized as a failed stream', () => {
  assert.ok(trailerStreamEndedEarly(130, 130, 0.2));
  assert.ok(!trailerStreamEndedEarly(129.5, 130, 128));
  assert.ok(!trailerStreamEndedEarly(60, 130, 0.2));
  assert.ok(!trailerStreamEndedEarly(4, 4, 0));
});

test('a trailer whose stream is refused is resolved again, then reports an error', async () => {
  const player = harness();
  await player.controller.start(REQUEST, 80, false);
  assert.equal(player.loads.length, 1);

  for (let attempt = 1; attempt <= MAX_TRAILER_STREAM_RETRIES; attempt += 1) {
    player.becomeReady();
    assert.equal(player.state()?.status, 'ready');
    player.controller.handleProperty('time-pos', 130);
    await settle();
    assert.equal(player.loads.length, attempt + 1);
    assert.equal(player.state()?.status, 'searching');
  }

  player.becomeReady();
  player.controller.handleProperty('time-pos', 130);
  await settle();
  assert.equal(player.loads.length, MAX_TRAILER_STREAM_RETRIES + 1);
  assert.equal(player.state()?.status, 'error');
  assert.match(player.state()?.error ?? '', /refused the trailer stream/);
  player.controller.dispose();
});

test('an end position observed before the trailer is ready still triggers a new resolve', async () => {
  const player = harness();
  await player.controller.start(REQUEST, 80, false);
  player.controller.handleEvent({ event: 'start-file', playlist_entry_id: 1 } as unknown as MpvEvent);
  player.controller.handleProperty('duration', 130);
  player.controller.handleEvent({ event: 'file-loaded' } as unknown as MpvEvent);
  player.controller.handleProperty('time-pos', 130);
  player.controller.handleEvent({ event: 'playback-restart' } as unknown as MpvEvent);
  await settle();
  assert.equal(player.loads.length, 2);
  player.controller.dispose();
});

test('normal playback and user seeks to the end are left alone', async () => {
  const player = harness();
  await player.controller.start(REQUEST, 80, false);
  player.becomeReady();
  player.advance(10_000);
  player.controller.handleProperty('time-pos', 10);
  await player.controller.seek(130);
  player.controller.handleProperty('time-pos', 130);
  await settle();
  assert.equal(player.loads.length, 1);
  assert.deepEqual(player.seeks, [130]);
  assert.equal(player.state()?.status, 'ready');
  player.controller.dispose();
});
