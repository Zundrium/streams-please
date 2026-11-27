import { READY_BUFFER_SECONDS } from '$lib/room/protocol';
import type { GuestStatus, ParticipantPhase } from '$lib/room/protocol';
import type { Phase } from '$lib/types';

export type ReadinessInput = {
  attached: boolean;
  hasMedia: boolean;
  settled: boolean;
  phase: Phase;
  seeking: boolean;
  downloaded: boolean;
  bufferedAhead: number | null;
  position: number;
  duration: number;
};

const BUFFER_TOLERANCE_SECONDS = 0.25;

function requiredBuffer(input: ReadinessInput): number {
  if (input.duration <= 0) return READY_BUFFER_SECONDS;
  return Math.min(READY_BUFFER_SECONDS, Math.max(0, input.duration - input.position));
}

export function participantPhase(input: ReadinessInput, previous: ParticipantPhase): ParticipantPhase {
  if (!input.attached) return 'away';
  if (input.phase === 'error') return 'error';
  if (!input.hasMedia) return 'idle';
  if (!input.settled || input.phase !== 'ready') return 'loading';
  if (previous === 'ready') return 'ready';
  if (input.seeking) return 'loading';
  if (input.downloaded || input.bufferedAhead === null) return 'ready';
  return input.bufferedAhead + BUFFER_TOLERANCE_SECONDS >= requiredBuffer(input) ? 'ready' : 'loading';
}

export function loadingProgress(input: ReadinessInput): number | null {
  const required = requiredBuffer(input);
  if (!input.settled || input.downloaded || input.bufferedAhead === null || required <= 0) return null;
  return Math.round(Math.max(0, Math.min(1, input.bufferedAhead / required)) * 100) / 100;
}

export class ReadinessTracker {
  private epoch = -1;
  private phase: ParticipantPhase = 'loading';

  update(epoch: number, input: ReadinessInput): GuestStatus {
    const previous = epoch === this.epoch ? this.phase : 'loading';
    this.epoch = epoch;
    this.phase = participantPhase(input, previous);
    return {
      epoch,
      phase: this.phase,
      progress: this.phase === 'loading' ? loadingProgress(input) : null
    };
  }
}
