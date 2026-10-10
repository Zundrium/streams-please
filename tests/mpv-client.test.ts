import assert from 'node:assert/strict';
import test from 'node:test';
import type { MpvEvent } from 'tauri-plugin-libmpv-api';
import { MpvClient, isMissingMpvInstance, type MpvApi } from '../src/lib/player/mpv-client.ts';

type Call = { fn: string; args: unknown[] };

function fakeApi(overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}) {
  const calls: Call[] = [];
  let emit: (event: MpvEvent) => void = () => undefined;
  const record = (fn: string, result: unknown = undefined) => async (...args: unknown[]) => {
    calls.push({ fn, args });
    const override = overrides[fn];
    return override ? override(...args) : result;
  };
  const api = {
    init: record('init', 'main'),
    destroy: record('destroy'),
    command: record('command'),
    setProperty: record('setProperty'),
    getProperty: record('getProperty', null),
    setVideoMarginRatio: record('setVideoMarginRatio'),
    observeProperties: async (...args: unknown[]) => {
      calls.push({ fn: 'observeProperties', args });
      return () => calls.push({ fn: 'unobserve', args: [] });
    },
    listenEvents: async (callback: (event: MpvEvent) => void) => {
      calls.push({ fn: 'listenEvents', args: [] });
      emit = callback;
      return () => calls.push({ fn: 'unlisten', args: [] });
    }
  } as unknown as MpvApi;
  return { api, calls, emit: (event: MpvEvent) => emit(event) };
}

function client(api: MpvApi, events: MpvEvent[] = []) {
  return new MpvClient(api, {
    windowLabel: 'main',
    observedProperties: [['pause', 'flag']] as const,
    enabled: () => true,
    initialOptions: () => ({ vo: 'gpu-next' }),
    initialMargins: () => ({ top: 1 }),
    onProperty: () => undefined,
    onEvent: (event) => events.push(event),
    loadTimeoutMs: 50
  });
}

test('concurrent ensure calls initialize mpv once and register listeners', async () => {
  const { api, calls } = fakeApi();
  const mpv = client(api);
  await Promise.all([mpv.ensure(), mpv.ensure(), mpv.ensure()]);
  assert.equal(calls.filter((call) => call.fn === 'init').length, 1);
  assert.deepEqual(calls.map((call) => call.fn), ['init', 'observeProperties', 'listenEvents', 'setVideoMarginRatio']);
  assert.ok(mpv.ready && mpv.settled);
});

test('disabled clients never touch the native API', async () => {
  const { api, calls } = fakeApi();
  const mpv = new MpvClient(api, {
    windowLabel: 'main', observedProperties: [] as const, enabled: () => false,
    initialOptions: () => ({}), initialMargins: () => null, onProperty: () => undefined,
    onEvent: () => undefined, loadTimeoutMs: 10
  });
  await mpv.ensure();
  await mpv.syncMargins({ top: 0 });
  assert.equal(calls.length, 0);
});

test('run retries the whole operation once when the instance is missing', async () => {
  const { api, calls } = fakeApi();
  const mpv = client(api);
  let attempts = 0;
  const result = await mpv.run(async (player) => {
    attempts += 1;
    await player.setNumber('volume', 50);
    if (attempts === 1) throw new Error('mpv instance not found: main');
    await player.setFlag('pause', true);
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(attempts, 2);
  assert.equal(calls.filter((call) => call.fn === 'init').length, 2);
  assert.ok(calls.some((call) => call.fn === 'unobserve'));
});

test('run never retries after a native panic or other failure', async () => {
  const { api, calls } = fakeApi();
  const mpv = client(api);
  let attempts = 0;
  await assert.rejects(
    mpv.run(async () => {
      attempts += 1;
      throw new Error('mpv worker failed: JoinError::Panic');
    }),
    /JoinError::Panic/
  );
  assert.equal(attempts, 1);
  assert.equal(calls.filter((call) => call.fn === 'init').length, 1);
  assert.ok(!isMissingMpvInstance(new Error('JoinError::Panic')));
  assert.ok(isMissingMpvInstance('libmpv-wrapper is not initialized'));
});

test('typed commands send FFI-safe values and never request node-format reads', async () => {
  const { api, calls } = fakeApi();
  const mpv = client(api);
  await mpv.run(async (player) => {
    await player.selectTrack('sid', 3);
    await player.selectTrack('aid', 'auto');
    await player.selectTrack('sid', 'no');
    await player.loadFile('http://127.0.0.1/video');
    await player.loadFile('http://127.0.0.1/video', 'start=42');
    await player.seek(12.5);
    await player.readPath();
    await player.readPausedForCache();
    await player.readTimePosition();
  });
  const setProperty = calls.filter((call) => call.fn === 'setProperty').map((call) => call.args.slice(0, 2));
  assert.deepEqual(setProperty, [['sid', '3'], ['aid', 'auto'], ['sid', 'no']]);
  const commands = calls.filter((call) => call.fn === 'command').map((call) => call.args.slice(0, 2));
  assert.deepEqual(commands, [
    ['loadfile', ['http://127.0.0.1/video', 'replace']],
    ['loadfile', ['http://127.0.0.1/video', 'replace', -1, 'start=42']],
    ['seek', [12.5, 'absolute+exact']]
  ]);
  const formats = calls.filter((call) => call.fn === 'getProperty').map((call) => call.args.slice(0, 2));
  assert.deepEqual(formats, [['path', 'string'], ['paused-for-cache', 'flag'], ['time-pos', 'double']]);
});

test('loadAndWait resolves once mpv reports the expected path', async () => {
  const fake = fakeApi({ getProperty: () => 'http://127.0.0.1:1/torrents/1/stream/0/a.mkv' });
  const forwarded: MpvEvent[] = [];
  const mpv = client(fake.api, forwarded);
  await mpv.ensure();
  const loading = mpv.loadAndWait('http://127.0.0.1:1/torrents/1/stream/0/a.mkv', 'http://127.0.0.1:1/torrents/1/stream/0');
  await new Promise((resolve) => setImmediate(resolve));
  fake.emit({ event: 'file-loaded' } as MpvEvent);
  await loading;
  assert.equal(forwarded[0]?.event, 'file-loaded');
});

test('loadAndWait rejects on load errors and when the client is reset', async () => {
  const fake = fakeApi();
  const mpv = client(fake.api);
  await mpv.ensure();
  const failing = mpv.loadAndWait('http://x/a', 'http://x');
  await new Promise((resolve) => setImmediate(resolve));
  fake.emit({ event: 'end-file', reason: 'error' } as MpvEvent);
  await assert.rejects(failing, /could not load the requested media/);

  const reset = mpv.loadAndWait('http://x/b', 'http://x');
  await new Promise((resolve) => setImmediate(resolve));
  mpv.reset();
  await assert.rejects(reset, /reset during a media load/);
  assert.ok(!mpv.ready);
});

test('loadAndWait times out when mpv never confirms the file', async () => {
  const fake = fakeApi();
  const mpv = client(fake.api);
  await mpv.ensure();
  await assert.rejects(mpv.loadAndWait('http://x/a', 'http://x'), /did not finish restoring/);
});

test('margin syncs skip unsettled clients and swallow missing-instance errors without recreating mpv', async () => {
  const fake = fakeApi({
    setVideoMarginRatio: () => {
      throw new Error('mpv instance not found');
    }
  });
  const mpv = client(fake.api);
  await mpv.syncMargins({ top: 0 });
  assert.equal(fake.calls.length, 0);
  await assert.rejects(mpv.ensure());
  assert.ok(!mpv.ready);
});

test('destroy marks the client unready before tearing down the native instance', async () => {
  const fake = fakeApi();
  const mpv = client(fake.api);
  await mpv.ensure();
  const destroying = mpv.destroy();
  assert.ok(!mpv.ready);
  await destroying;
  assert.ok(fake.calls.some((call) => call.fn === 'destroy'));
});
