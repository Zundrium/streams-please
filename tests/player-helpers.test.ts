import assert from 'node:assert/strict';
import test from 'node:test';
import { errorMessage, toError } from '../src/lib/errors.ts';
import { mpvInitialOptions, subtitleLanguagePreference } from '../src/lib/player/mpv-config.ts';
import {
  applyPlaybackProperty,
  formatPlaybackTime,
  nextPlaybackSpeed,
  percentToTime,
  reconcileSeekTarget,
  signalsPlaybackProgress
} from '../src/lib/player/playback-state.ts';
import { resolvePlayerShortcut, type ShortcutContext } from '../src/lib/player/shortcuts.ts';
import { isPointerAtEdge, relativePlacement, viewportMargins } from '../src/lib/player/viewport.ts';
import { isSupportedTrailerUrl, youtubeTrailerSearchPlaybackUrl } from '../src/lib/trailers.ts';
import type { PlaybackState } from '../src/lib/types.ts';

const idle: ShortcutContext = { roomPanelOpen: false, queueOpen: false, fullscreen: false, trailerOpen: false, theater: false, episodeLoaded: true };
const key = (keyName: string, code = keyName, fromEditable = false) => ({ key: keyName, code, fromEditable });

test('escape closes the innermost layer first', () => {
  const all = { ...idle, queueOpen: true, fullscreen: true, trailerOpen: true, theater: true };
  assert.equal(resolvePlayerShortcut(key('Escape'), { ...all, roomPanelOpen: true }), 'close-room-panel');
  assert.equal(resolvePlayerShortcut(key('Escape', 'Escape', true), { ...idle, roomPanelOpen: true }), 'close-room-panel');
  assert.equal(resolvePlayerShortcut(key(' ', 'Space'), { ...idle, roomPanelOpen: true }), null);
  assert.equal(resolvePlayerShortcut(key('Escape'), all), 'close-queue');
  assert.equal(resolvePlayerShortcut(key('Escape'), { ...all, queueOpen: false }), 'exit-fullscreen');
  assert.equal(resolvePlayerShortcut(key('Escape'), { ...idle, trailerOpen: true, theater: true }), 'close-trailer');
  assert.equal(resolvePlayerShortcut(key('Escape'), { ...idle, theater: true }), 'exit-theater');
  assert.equal(resolvePlayerShortcut(key('Escape', 'Escape', true), { ...idle, theater: true }), 'exit-theater');
  assert.equal(resolvePlayerShortcut(key('Escape'), idle), null);
});

test('media keys need an active player and are ignored in form fields', () => {
  assert.equal(resolvePlayerShortcut(key(' ', 'Space'), idle), 'toggle-playback');
  assert.equal(resolvePlayerShortcut(key('ArrowLeft'), idle), 'seek-backward');
  assert.equal(resolvePlayerShortcut(key('ArrowRight'), idle), 'seek-forward');
  assert.equal(resolvePlayerShortcut(key('M', 'KeyM'), idle), 'toggle-mute');
  assert.equal(resolvePlayerShortcut(key('f', 'KeyF'), { ...idle, episodeLoaded: false, trailerOpen: true }), 'toggle-fullscreen');
  assert.equal(resolvePlayerShortcut(key(' ', 'Space'), { ...idle, episodeLoaded: false }), null);
  assert.equal(resolvePlayerShortcut(key(' ', 'Space', true), idle), null);
  assert.equal(resolvePlayerShortcut(key('x', 'KeyX'), idle), null);
});

test('viewport helpers convert element rectangles into mpv margins and placements', () => {
  assert.deepEqual(viewportMargins({ left: 100, top: 50, right: 900, bottom: 550 }, 1000, 1000), {
    left: 0.1, right: 0.1, top: 0.05, bottom: 0.45
  });
  assert.deepEqual(viewportMargins({ left: -10, top: -10, right: 1010, bottom: 1010 }, 1000, 1000), {
    left: 0, right: 0, top: 0, bottom: 0
  });
  assert.deepEqual(
    relativePlacement({ left: 120, top: 80, width: 300, height: 200 }, { left: 20, top: 30 }),
    { left: 100, top: 50, width: 300, height: 200 }
  );
});

test('observed properties update playback state without touching unrelated fields', () => {
  const playback: PlaybackState = { paused: false, time: 1, duration: 10, volume: 80, muted: false, speed: 1 };
  assert.equal(applyPlaybackProperty(playback, 'pause', 1).paused, true);
  assert.equal(applyPlaybackProperty(playback, 'time-pos', null).time, 0);
  assert.equal(applyPlaybackProperty(playback, 'speed', null).speed, 1);
  assert.equal(applyPlaybackProperty(playback, 'media-title', 42).mediaTitle, undefined);
  assert.equal(applyPlaybackProperty(playback, 'path', 'x'), playback);
  assert.ok(signalsPlaybackProgress('duration', 5));
  assert.ok(!signalsPlaybackProgress('duration', 0));
  assert.ok(signalsPlaybackProgress('time-pos', 0));
  assert.ok(!signalsPlaybackProgress('time-pos', null));
  assert.equal(reconcileSeekTarget(30, 30.8), null);
  assert.equal(reconcileSeekTarget(30, 25), 30);
  assert.equal(reconcileSeekTarget(null, 25), null);
});

test('speed cycling, percent seeking, and subtitle preferences', () => {
  assert.deepEqual([1, 1.25, 1.5, 2, 0.75, 3].map(nextPlaybackSpeed), [1.25, 1.5, 2, 0.75, 1, 1]);
  assert.equal(percentToTime(50, 120), 60);
  assert.equal(percentToTime(150, 120), 120);
  assert.equal(percentToTime(-5, 120), 0);
  assert.equal(subtitleLanguagePreference('en'), 'en');
  assert.equal(subtitleLanguagePreference('nl'), 'nl,en');
  assert.equal(mpvInitialOptions('ja').slang, 'ja,en');
});

test('pointer edge detection hides player controls only at the surface border', () => {
  const rect = { left: 0, top: 40, right: 1000, bottom: 600 };
  assert.ok(isPointerAtEdge(rect, 0, 300));
  assert.ok(isPointerAtEdge(rect, 997, 300));
  assert.ok(isPointerAtEdge(rect, 500, 44));
  assert.ok(isPointerAtEdge(rect, 500, 599));
  assert.ok(!isPointerAtEdge(rect, 500, 300));
  assert.ok(!isPointerAtEdge(rect, 10, 60));
  assert.ok(isPointerAtEdge(rect, 10, 60, 12));
});

test('only https trailers from supported hosts or bundled searches are playable', () => {
  assert.ok(isSupportedTrailerUrl('https://www.youtube.com/watch?v=x'));
  assert.ok(isSupportedTrailerUrl('https://youtu.be/x'));
  assert.ok(isSupportedTrailerUrl('https://www.dailymotion.com/video/x'));
  assert.ok(isSupportedTrailerUrl(youtubeTrailerSearchPlaybackUrl('Black Torch')));
  assert.ok(!isSupportedTrailerUrl('http://www.youtube.com/watch?v=x'));
  assert.ok(!isSupportedTrailerUrl('https://evil-youtube.com/x'));
  assert.ok(!isSupportedTrailerUrl('https://sub.youtu.be/x'));
  assert.ok(!isSupportedTrailerUrl('not a url'));
});

test('error helpers normalize unknown rejection values', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(toError('plain').message, 'plain');
  const original = new Error('kept');
  assert.equal(toError(original), original);
});

test('playback times format as clock values', () => {
  assert.equal(formatPlaybackTime(0), '0:00');
  assert.equal(formatPlaybackTime(754.9), '12:34');
  assert.equal(formatPlaybackTime(3_725), '1:02:05');
  assert.equal(formatPlaybackTime(Number.NaN), '0:00');
});
