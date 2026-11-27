import { isRecord } from '$lib/catalog/guards';
import { PLAYBACK_SPEEDS } from '$lib/player/playback-state';

export const START_LEAD_MS = 500;
export const READY_BUFFER_SECONDS = 10;
export const READY_SETTLE_MS = 300;
export const STATUS_HEARTBEAT_MS = 2_000;
export const STATUS_PROGRESS_INTERVAL_MS = 500;
export const STATE_HEARTBEAT_PLAYING_MS = 2_000;
export const STATE_HEARTBEAT_PAUSED_MS = 5_000;
export const STATE_BROADCAST_INTERVAL_MS = 100;
export const ROSTER_BROADCAST_INTERVAL_MS = 250;
export const PEER_SILENCE_MS = 15_000;
export const TICK_MS = 1_000;
export const PAUSED_ALIGN_SECONDS = 0.1;
export const DRIFT_OK_SECONDS = 0.08;
export const DRIFT_SETTLED_SECONDS = 0.03;
export const DRIFT_HARD_SECONDS = 1.5;
export const DRIFT_CORRECTION_RATIO = 0.05;
export const SPEED_CORRECTION_INTERVAL_MS = 1_000;
export const HARD_SEEK_INTERVAL_MS = 5_000;
export const END_OF_FILE_SECONDS = 0.5;
export const CLOCK_SAMPLE_WINDOW = 8;
export const CLOCK_BURST_SAMPLES = 5;
export const CLOCK_BURST_INTERVAL_MS = 200;
export const CLOCK_SAMPLE_INTERVAL_MS = 10_000;

export const MAX_PARTICIPANTS = 8;
export const MAX_NAME_LENGTH = 24;
export const MAX_ROOM_MAGNET_BYTES = 8_192;
export const MAX_POSITION_SECONDS = 86_400;
export const MAX_INVITE_LENGTH = 256;
export const INVITE_PREFIX = 'sproom1:';
export const DEFAULT_GUEST_NAME = 'Guest';

export type RoomMedia = {
  magnet: string;
  title: string;
  episode: string;
  slug: string;
  anilistId?: number;
  imageUrl: string;
  quality: string;
};

export type RoomState = {
  seq: number;
  epoch: number;
  mediaSeq: number;
  media: RoomMedia | null;
  playing: boolean;
  position: number;
  hostTime: number;
  speed: number;
};

export const PARTICIPANT_PHASES = ['idle', 'loading', 'ready', 'away', 'error'] as const;
export type ParticipantPhase = (typeof PARTICIPANT_PHASES)[number];

export type GuestStatus = { epoch: number; phase: ParticipantPhase; progress: number | null };

export type Participant = {
  id: number;
  name: string;
  host: boolean;
  phase: ParticipantPhase;
  progress: number | null;
  blocking: boolean;
};

export const PEER_LEFT_REASONS = ['left', 'lost', 'removed'] as const;
export type PeerLeftReason = (typeof PEER_LEFT_REASONS)[number];
export const ROOM_CLOSE_REASONS = ['ended', 'removed', 'full', 'locked', 'hostLost', 'failed'] as const;
export type RoomCloseReason = (typeof ROOM_CLOSE_REASONS)[number];
export type RoomLinkStatus = 'connected' | 'reconnecting';
export type RoomRoute = 'direct' | 'relay';

export type RoomEvent =
  | { type: 'peerJoined'; id: number; name: string }
  | { type: 'peerLeft'; id: number; reason: PeerLeftReason }
  | { type: 'peerStatus'; id: number; status: GuestStatus }
  | { type: 'peerPing'; id: number; pingId: number; sentAt: number }
  | { type: 'inviteChanged'; invite: string }
  | { type: 'state'; state: RoomState }
  | { type: 'roster'; participants: Participant[] }
  | { type: 'pong'; pingId: number; sentAt: number; hostTime: number }
  | { type: 'link'; status: RoomLinkStatus }
  | { type: 'route'; id: number; route: RoomRoute }
  | { type: 'closed'; reason: RoomCloseReason };

export type RoomOutbound =
  | { type: 'state'; state: RoomState }
  | { type: 'roster'; participants: Participant[] }
  | { type: 'pong'; id: number; pingId: number; sentAt: number; hostTime: number }
  | { type: 'status'; status: GuestStatus }
  | { type: 'ping'; pingId: number; sentAt: number };

export interface RoomTransport {
  send(message: RoomOutbound): void;
}

export type RoomChannel = { onmessage: (event: unknown) => void };

export type SetTimer = (callback: () => void, ms: number) => () => void;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARACTERS_GLOBAL = /[\u0000-\u001f\u007f-\u009f]+/g;
const MAGNET_INFO_HASH = /[?&]xt=urn:btih:(?:[0-9a-fA-F]{40}|[a-zA-Z2-7]{32})(?:&|$)/;
const SLUG = /^[a-z0-9-]*$/;

export const INITIAL_ROOM_STATE: RoomState = {
  seq: 0,
  epoch: 0,
  mediaSeq: 0,
  media: null,
  playing: false,
  position: 0,
  hostTime: 0,
  speed: 1
};

export function cleanDisplayName(input: string): string {
  const cleaned = input.replace(CONTROL_CHARACTERS_GLOBAL, ' ').replace(/\s+/g, ' ').trim();
  return [...cleaned].slice(0, MAX_NAME_LENGTH).join('').trim() || DEFAULT_GUEST_NAME;
}

export function isPlaybackSpeed(value: unknown): value is (typeof PLAYBACK_SPEEDS)[number] {
  return (PLAYBACK_SPEEDS as readonly unknown[]).includes(value);
}

export function clampPosition(position: number, duration = 0): number {
  if (!Number.isFinite(position)) return 0;
  const limit = duration > 0 ? Math.min(duration, MAX_POSITION_SECONDS) : MAX_POSITION_SECONDS;
  return Math.max(0, Math.min(limit, position));
}

function hasExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(record);
  return (
    required.every((key) => key in record) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isClockTime(value: unknown): value is number {
  return isInRange(value, 0, Number.MAX_SAFE_INTEGER);
}

function isText(value: unknown, max: number, min = 0): value is string {
  return (
    typeof value === 'string' &&
    value.length >= min &&
    value.length <= max &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function isMember<T extends string>(value: unknown, members: readonly T[]): value is T {
  return (members as readonly unknown[]).includes(value);
}

function isName(value: unknown): value is string {
  return isText(value, MAX_NAME_LENGTH * 2, 1) && [...value].length <= MAX_NAME_LENGTH && value === value.trim();
}

export function isRoomMagnet(value: unknown): value is string {
  return (
    isText(value, MAX_ROOM_MAGNET_BYTES) &&
    new TextEncoder().encode(value).length <= MAX_ROOM_MAGNET_BYTES &&
    value.startsWith('magnet:?') &&
    MAGNET_INFO_HASH.test(value)
  );
}

function isImageUrl(value: unknown): value is string {
  return (
    isText(value, 500, 1) &&
    !/\s/.test(value) &&
    (value.startsWith('https://') || (value.startsWith('/') && !value.startsWith('//')))
  );
}

export function parseRoomMedia(value: unknown): RoomMedia | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['magnet', 'title', 'episode', 'slug', 'imageUrl', 'quality'], ['anilistId'])
  ) {
    return null;
  }
  const { magnet, title, episode, slug, imageUrl, quality, anilistId } = value;
  if (
    !isRoomMagnet(magnet) ||
    !isText(title, 200, 1) ||
    !isText(episode, 16) ||
    !isText(slug, 120) ||
    !SLUG.test(slug) ||
    !isImageUrl(imageUrl) ||
    !isText(quality, 8)
  ) {
    return null;
  }
  if (anilistId === undefined) return { magnet, title, episode, slug, imageUrl, quality };
  if (!isCount(anilistId) || anilistId === 0) return null;
  return { magnet, title, episode, slug, anilistId, imageUrl, quality };
}

export function parseRoomState(value: unknown): RoomState | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['seq', 'epoch', 'mediaSeq', 'media', 'playing', 'position', 'hostTime', 'speed'])
  ) {
    return null;
  }
  const { seq, epoch, mediaSeq, playing, position, hostTime, speed } = value;
  const media = value.media === null ? null : parseRoomMedia(value.media);
  if (
    !isCount(seq) ||
    !isCount(epoch) ||
    !isCount(mediaSeq) ||
    (value.media !== null && !media) ||
    typeof playing !== 'boolean' ||
    !isInRange(position, 0, MAX_POSITION_SECONDS) ||
    !isClockTime(hostTime) ||
    !isPlaybackSpeed(speed) ||
    (playing && !media)
  ) {
    return null;
  }
  return { seq, epoch, mediaSeq, media, playing, position, hostTime, speed };
}

export function parseGuestStatus(value: unknown): GuestStatus | null {
  if (!isRecord(value) || !hasExactKeys(value, ['epoch', 'phase', 'progress'])) return null;
  const { epoch, phase, progress } = value;
  if (
    !isCount(epoch) ||
    !isMember(phase, PARTICIPANT_PHASES) ||
    (progress !== null && !isInRange(progress, 0, 1))
  ) {
    return null;
  }
  return { epoch, phase, progress };
}

function parseParticipant(value: unknown): Participant | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'name', 'host', 'phase', 'progress', 'blocking'])
  ) {
    return null;
  }
  const { id, name, host, phase, progress, blocking } = value;
  if (
    !isCount(id) ||
    !isName(name) ||
    typeof host !== 'boolean' ||
    host !== (id === 0) ||
    !isMember(phase, PARTICIPANT_PHASES) ||
    (progress !== null && !isInRange(progress, 0, 1)) ||
    typeof blocking !== 'boolean'
  ) {
    return null;
  }
  return { id, name, host, phase, progress, blocking };
}

export function parseParticipants(value: unknown): Participant[] | null {
  if (!Array.isArray(value) || value.length > MAX_PARTICIPANTS) return null;
  const participants: Participant[] = [];
  for (const item of value) {
    const participant = parseParticipant(item);
    if (!participant || participants.some((other) => other.id === participant.id)) return null;
    participants.push(participant);
  }
  return participants;
}

export function parseRoomEvent(value: unknown): RoomEvent | null {
  if (!isRecord(value)) return null;
  const exact = (...keys: string[]) => hasExactKeys(value, ['type', ...keys]);
  switch (value.type) {
    case 'peerJoined': {
      const { id, name } = value;
      return exact('id', 'name') && isCount(id) && id > 0 && isName(name)
        ? { type: 'peerJoined', id, name }
        : null;
    }
    case 'peerLeft': {
      const { id, reason } = value;
      return exact('id', 'reason') && isCount(id) && id > 0 && isMember(reason, PEER_LEFT_REASONS)
        ? { type: 'peerLeft', id, reason }
        : null;
    }
    case 'peerStatus': {
      const { id } = value;
      const status = parseGuestStatus(value.status);
      return exact('id', 'status') && isCount(id) && id > 0 && status
        ? { type: 'peerStatus', id, status }
        : null;
    }
    case 'peerPing': {
      const { id, pingId, sentAt } = value;
      return exact('id', 'pingId', 'sentAt') && isCount(id) && id > 0 && isCount(pingId) && isClockTime(sentAt)
        ? { type: 'peerPing', id, pingId, sentAt }
        : null;
    }
    case 'inviteChanged': {
      const { invite } = value;
      return exact('invite') && isText(invite, MAX_INVITE_LENGTH, INVITE_PREFIX.length + 1) && invite.startsWith(INVITE_PREFIX)
        ? { type: 'inviteChanged', invite }
        : null;
    }
    case 'state': {
      const state = parseRoomState(value.state);
      return exact('state') && state ? { type: 'state', state } : null;
    }
    case 'roster': {
      const participants = parseParticipants(value.participants);
      return exact('participants') && participants ? { type: 'roster', participants } : null;
    }
    case 'pong': {
      const { pingId, sentAt, hostTime } = value;
      return exact('pingId', 'sentAt', 'hostTime') && isCount(pingId) && isClockTime(sentAt) && isClockTime(hostTime)
        ? { type: 'pong', pingId, sentAt, hostTime }
        : null;
    }
    case 'link': {
      const { status } = value;
      return exact('status') && isMember(status, ['connected', 'reconnecting'] as const)
        ? { type: 'link', status }
        : null;
    }
    case 'route': {
      const { id, route } = value;
      return exact('id', 'route') && isCount(id) && isMember(route, ['direct', 'relay'] as const)
        ? { type: 'route', id, route }
        : null;
    }
    case 'closed': {
      const { reason } = value;
      return exact('reason') && isMember(reason, ROOM_CLOSE_REASONS) ? { type: 'closed', reason } : null;
    }
    default:
      return null;
  }
}
