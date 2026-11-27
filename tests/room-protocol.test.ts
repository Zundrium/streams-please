import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ROOM_MAGNET_BYTES,
  cleanDisplayName,
  parseGuestStatus,
  parseParticipants,
  parseRoomEvent,
  parseRoomMedia,
  parseRoomState,
  roomMediaFrom
} from '../src/lib/room/protocol.ts';
import { MAGNET, media, roomState } from './room-fakes.ts';

const participant = { id: 1, name: 'Alice', host: false, phase: 'loading', progress: 0.4, blocking: true };

test('valid room input is accepted and copied', () => {
  const state = roomState({ playing: true, position: 12.5, hostTime: 1_000, speed: 1.25 });
  assert.deepEqual(parseRoomState(state), state);
  assert.notEqual(parseRoomState(state), state);
  assert.deepEqual(parseRoomState(roomState({ media: null })), roomState({ media: null }));
  const { anilistId: _anilistId, ...withoutAniList } = media();
  assert.deepEqual(parseRoomMedia(withoutAniList), withoutAniList);
  assert.deepEqual(parseRoomMedia({ ...media(), imageUrl: '/poster.png' })?.imageUrl, '/poster.png');
  assert.deepEqual(parseRoomMedia({ ...media(), imageUrl: '' })?.imageUrl, '');
  assert.deepEqual(parseGuestStatus({ epoch: 2, phase: 'ready', progress: null }), {
    epoch: 2,
    phase: 'ready',
    progress: null
  });
  assert.deepEqual(parseParticipants([participant]), [participant]);
});

test('an episode request becomes room media without its extra fields, or nothing when invalid', () => {
  const request = { ...media(), magnet: ` ${MAGNET}\n`, imageUrl: '', day: 'Monday', airingTime: '15:00' };
  assert.deepEqual(roomMediaFrom(request), { ...media(), imageUrl: '' });
  const { anilistId: _anilistId, ...withoutAniList } = media();
  assert.deepEqual(roomMediaFrom({ ...media(), anilistId: null as unknown as number }), withoutAniList);
  assert.equal(roomMediaFrom({ ...media(), slug: 'Not A Slug' }), null);
  assert.equal(roomMediaFrom({ ...media(), magnet: 'https://example.com/video.mkv' }), null);
});

test('room events are narrowed by type and reject unknown types and extra fields', () => {
  const events = [
    { type: 'peerJoined', id: 1, name: 'Alice' },
    { type: 'peerLeft', id: 1, reason: 'lost' },
    { type: 'peerStatus', id: 1, status: { epoch: 1, phase: 'loading', progress: 0.5 } },
    { type: 'peerPing', id: 1, pingId: 3, sentAt: 10 },
    { type: 'inviteChanged', invite: 'sproom1:abc@relay.example' },
    { type: 'state', state: roomState() },
    { type: 'roster', participants: [participant] },
    { type: 'pong', pingId: 3, sentAt: 10, hostTime: 20 },
    { type: 'link', status: 'reconnecting' },
    { type: 'route', id: 0, route: 'direct' },
    { type: 'closed', reason: 'hostLost' }
  ];
  for (const event of events) {
    assert.deepEqual(parseRoomEvent(event), event, event.type);
    assert.equal(parseRoomEvent({ ...event, extra: 1 }), null, `${event.type} with an extra field`);
  }
  assert.equal(parseRoomEvent({ type: 'chat', text: 'hi' }), null);
  assert.equal(parseRoomEvent({ id: 1, name: 'Alice' }), null);
  assert.equal(parseRoomEvent(null), null);
  assert.equal(parseRoomEvent('state'), null);
  assert.equal(parseRoomEvent({ type: 'peerJoined', id: 0, name: 'Alice' }), null);
  assert.equal(parseRoomEvent({ type: 'peerJoined', id: 1, name: '' }), null);
  assert.equal(parseRoomEvent({ type: 'closed', reason: 'bored' }), null);
  assert.equal(parseRoomEvent({ type: 'inviteChanged', invite: 'https://example.com' }), null);
  assert.equal(parseRoomEvent({ type: 'state', state: { ...roomState(), extra: true } }), null);
});

test('room state rejects non-finite numbers, bad counters, and unknown speeds', () => {
  const invalid: Array<Record<string, unknown>> = [
    { seq: -1 },
    { seq: 1.5 },
    { epoch: Number.NaN },
    { mediaSeq: '1' },
    { position: Number.POSITIVE_INFINITY },
    { position: -1 },
    { position: 86_401 },
    { hostTime: Number.NaN },
    { speed: 3 },
    { playing: 1 },
    { playing: true, media: null }
  ];
  for (const patch of invalid) {
    assert.equal(parseRoomState({ ...roomState(), ...patch }), null, JSON.stringify(patch));
  }
  const { speed: _speed, ...missingSpeed } = roomState();
  assert.equal(parseRoomState(missingSpeed), null);
});

test('room media rejects bad magnets, oversized strings, and unsafe text', () => {
  const invalid: Array<Record<string, unknown>> = [
    { magnet: 'https://example.com/file.torrent' },
    { magnet: 'magnet:?dn=NoHash' },
    { magnet: 'magnet:?xt=urn:btih:nothex' },
    { magnet: `${MAGNET}&dn=${'a'.repeat(MAX_ROOM_MAGNET_BYTES)}` },
    { title: '' },
    { title: 'a'.repeat(201) },
    { title: 'bad\u0000title' },
    { episode: '1'.repeat(17) },
    { slug: 'Not A Slug' },
    { slug: 'a'.repeat(121) },
    { quality: '1080p-extra' },
    { imageUrl: 'http://example.com/a.jpg' },
    { imageUrl: '//example.com/a.jpg' },
    { imageUrl: 'javascript:alert(1)' },
    { imageUrl: `https://example.com/${'a'.repeat(500)}` },
    { anilistId: 0 },
    { anilistId: 1.5 },
    { extra: true }
  ];
  for (const patch of invalid) {
    assert.equal(parseRoomMedia({ ...media(), ...patch }), null, JSON.stringify(patch).slice(0, 60));
  }
});

test('statuses and rosters reject invalid phases, progress, and oversized rosters', () => {
  assert.equal(parseGuestStatus({ epoch: 1, phase: 'sleeping', progress: null }), null);
  assert.equal(parseGuestStatus({ epoch: 1, phase: 'ready', progress: 1.2 }), null);
  assert.equal(parseGuestStatus({ epoch: 1, phase: 'ready' }), null);
  assert.equal(parseParticipants({}), null);
  assert.equal(parseParticipants([{ ...participant, host: true }]), null);
  assert.equal(parseParticipants([participant, participant]), null);
  assert.equal(parseParticipants([{ ...participant, name: 'a'.repeat(25) }]), null);
  assert.equal(
    parseParticipants(Array.from({ length: 9 }, (_, id) => ({ ...participant, id: id + 1 }))),
    null
  );
});

test('display names are cleaned, capped, and never empty', () => {
  assert.equal(cleanDisplayName('  Alice\u0007\n  Liddell '), 'Alice Liddell');
  assert.equal(cleanDisplayName('\u0000 \t'), 'Guest');
  assert.equal(cleanDisplayName('a'.repeat(40)).length, 24);
});
