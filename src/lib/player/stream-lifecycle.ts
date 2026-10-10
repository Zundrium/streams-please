import { Generation } from '$lib/async/generation';
import type { CurrentTorrent, Phase, TorrentStats } from '$lib/types';

export type StreamPhase = Extract<Phase, 'buffering' | 'ready' | 'error'>;

export type StreamLifecycleOptions = {
  minStartBytes: number;
  retryDelayMs: number;
  maxFailures: number;
  watchdogMs: number;
  phase: () => Phase;
  onPhase: (phase: StreamPhase, error?: string) => void;
};

export function selectedFileProgress(torrent: CurrentTorrent, stats: TorrentStats | null): number {
  return stats?.file_progress?.[torrent.fileId] ?? stats?.progress_bytes ?? 0;
}

export class StreamLifecycle {
  private readonly options: StreamLifecycleOptions;
  private torrentValue: CurrentTorrent | null = null;
  private statsValue: TorrentStats | null = null;
  private started = false;
  private failures = 0;
  private retryAt = 0;
  private pausedForCache = false;
  private bufferingSince = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private readonly attempts = new Generation();

  constructor(options: StreamLifecycleOptions) {
    this.options = options;
  }

  get torrent(): CurrentTorrent | null {
    return this.torrentValue;
  }

  get stats(): TorrentStats | null {
    return this.statsValue;
  }

  get bufferingStartedAt(): number {
    return this.bufferingSince;
  }

  get livePeers(): number {
    return this.statsValue?.live?.snapshot.peer_stats.live ?? 0;
  }

  begin(torrent: CurrentTorrent | null): void {
    this.torrentValue = torrent;
    this.statsValue = null;
    this.started = false;
    this.failures = 0;
    this.retryAt = 0;
    this.pausedForCache = false;
    this.bufferingSince = Date.now();
    this.clearWatchdog();
    this.attempts.next();
  }

  updateStats(stats: TorrentStats): void {
    this.statsValue = stats;
  }

  isCurrent(attempt: number): boolean {
    return this.attempts.isCurrent(attempt);
  }

  claimAttempt(): number | null {
    const torrent = this.torrentValue;
    const stats = this.statsValue;
    if (
      !torrent ||
      !stats ||
      stats.state === 'error' ||
      this.started ||
      this.failures >= this.options.maxFailures ||
      Date.now() < this.retryAt
    ) {
      return null;
    }
    if (!stats.finished && selectedFileProgress(torrent, stats) < this.options.minStartBytes) {
      return null;
    }
    return this.claim();
  }

  restart(): void {
    this.bufferingSince = Date.now();
    this.clearWatchdog();
    this.pausedForCache = false;
    this.attempts.next();
    this.started = false;
    this.failures = 0;
    this.retryAt = 0;
  }

  claimRetry(): number | null {
    const torrent = this.torrentValue;
    if (!torrent) return null;
    const enoughBuffered =
      this.statsValue?.finished ||
      selectedFileProgress(torrent, this.statsValue) >= this.options.minStartBytes;
    return enoughBuffered ? this.claim() : null;
  }

  suspend(): void {
    this.attempts.next();
    this.clearWatchdog();
  }

  fail(message: string, attempt = this.attempts.current): void {
    if (!this.torrentValue || !this.attempts.isCurrent(attempt)) return;
    this.clearWatchdog();
    this.pausedForCache = false;
    this.attempts.next();
    this.started = false;
    this.failures += 1;
    if (this.failures >= this.options.maxFailures) {
      this.retryAt = Number.POSITIVE_INFINITY;
      this.options.onPhase(
        'error',
        `${message} The local stream was attempted ${this.options.maxFailures} times.`
      );
      return;
    }
    this.retryAt = Date.now() + this.options.retryDelayMs;
    this.bufferingSince = Date.now();
    this.options.onPhase('buffering', '');
  }

  markReady(): void {
    if (!this.torrentValue || !this.started) return;
    this.clearWatchdog();
    this.pausedForCache = false;
    this.failures = 0;
    this.retryAt = 0;
    this.options.onPhase('ready', '');
  }

  fileStarted(): void {
    this.pausedForCache = true;
    this.bufferingSince = Date.now();
    this.options.onPhase('buffering');
    this.armWatchdog();
  }

  cacheStateChanged(paused: boolean, hasProgress: boolean): void {
    if (!this.torrentValue || !this.started) return;
    if (paused) {
      this.pausedForCache = true;
      if (this.options.phase() !== 'buffering') this.bufferingSince = Date.now();
      this.options.onPhase('buffering');
      this.armWatchdog();
      return;
    }
    this.pausedForCache = false;
    if (hasProgress) this.markReady();
  }

  progressObserved(): void {
    if (!this.pausedForCache) this.markReady();
  }

  dispose(): void {
    this.clearWatchdog();
  }

  private claim(): number {
    this.started = true;
    return this.attempts.next();
  }

  private armWatchdog(attempt = this.attempts.current): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (!this.attempts.isCurrent(attempt) || this.options.phase() !== 'buffering' || !this.started) {
        return;
      }
      this.fail('mpv kept waiting for video data from the local torrent stream.', attempt);
    }, this.options.watchdogMs);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}
