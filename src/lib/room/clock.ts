import { CLOCK_SAMPLE_WINDOW } from '$lib/room/protocol';

type ClockSample = { roundTrip: number; offset: number };

export class HostClock {
  private samples: ClockSample[] = [];

  get synced(): boolean {
    return this.samples.length > 0;
  }

  get offset(): number {
    let best: ClockSample | null = null;
    for (const sample of this.samples) {
      if (!best || sample.roundTrip < best.roundTrip) best = sample;
    }
    return best?.offset ?? 0;
  }

  addSample(sentAt: number, hostTime: number, receivedAt: number): void {
    const roundTrip = receivedAt - sentAt;
    if (!Number.isFinite(roundTrip) || !Number.isFinite(hostTime) || roundTrip < 0) return;
    this.samples.push({ roundTrip, offset: hostTime + roundTrip / 2 - receivedAt });
    if (this.samples.length > CLOCK_SAMPLE_WINDOW) this.samples.shift();
  }

  hostNow(localNow: number): number {
    return localNow + this.offset;
  }

  reset(): void {
    this.samples = [];
  }
}
