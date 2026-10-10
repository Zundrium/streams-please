import type { PlaybackState } from '$lib/types';

export const SEEK_RECONCILE_TOLERANCE_SECONDS = 1;
export const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 2, 0.75] as const;

export function applyPlaybackProperty(
  playback: PlaybackState,
  name: string,
  data: unknown
): PlaybackState {
  switch (name) {
    case 'pause':
      return { ...playback, paused: Boolean(data) };
    case 'time-pos':
      return { ...playback, time: Number(data ?? 0) };
    case 'duration':
      return { ...playback, duration: Number(data ?? 0) };
    case 'volume':
      return { ...playback, volume: Number(data ?? 0) };
    case 'mute':
      return { ...playback, muted: Boolean(data) };
    case 'speed':
      return { ...playback, speed: Number(data ?? 1) };
    case 'media-title':
      return { ...playback, mediaTitle: typeof data === 'string' ? data : undefined };
    default:
      return playback;
  }
}

export function signalsPlaybackProgress(name: string, data: unknown): boolean {
  return (
    (name === 'duration' && Number(data) > 0) ||
    (name === 'time-pos' && typeof data === 'number' && Number.isFinite(data))
  );
}

export function reconcileSeekTarget(seekTarget: number | null, time: number): number | null {
  return seekTarget !== null && Math.abs(time - seekTarget) <= SEEK_RECONCILE_TOLERANCE_SECONDS
    ? null
    : seekTarget;
}

export function nextPlaybackSpeed(speed: number): number {
  return PLAYBACK_SPEEDS[(PLAYBACK_SPEEDS.indexOf(speed as (typeof PLAYBACK_SPEEDS)[number]) + 1) % PLAYBACK_SPEEDS.length];
}

export function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}

export function percentToTime(percent: number, duration: number): number {
  return (clampPercent(percent) / 100) * duration;
}

export function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}
