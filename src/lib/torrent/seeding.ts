import type { SeedingEpisode, SeedingOverview, SeedingStatus } from '$lib/types';

export const SEEDING_RATIO_OPTIONS = [1, 1.5, 2, 3] as const;
export const KIB = 1024;
export const MIN_UPLOAD_LIMIT_BPS = 64 * KIB;
export const MAX_UPLOAD_LIMIT_BPS = 1024 * KIB * KIB;
export const UPLOAD_LIMIT_PRESETS_BPS = [256 * KIB, 512 * KIB, 1024 * KIB, 2048 * KIB, 5120 * KIB] as const;

const STATUSES: readonly SeedingStatus[] = ['streaming', 'seeding', 'partial', 'downloading', 'checking', 'error'];

const STATUS_LABELS: Record<SeedingStatus, string> = {
  streaming: 'Playing now',
  seeding: 'Seeding',
  partial: 'Partially cached',
  downloading: 'Downloading',
  checking: 'Checking files',
  error: 'Error'
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function uploadLimit(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_UPLOAD_LIMIT_BPS &&
    value <= MAX_UPLOAD_LIMIT_BPS
    ? value
    : null;
}

function normalizeEpisode(value: unknown): SeedingEpisode | null {
  const episode = record(value);
  const infoHash = typeof episode.infoHash === 'string' ? episode.infoHash.toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(infoHash)) return null;
  const status = STATUSES.find((item) => item === episode.status) ?? 'error';
  const name = typeof episode.name === 'string' && episode.name.trim() ? episode.name.trim() : infoHash.slice(0, 12);
  return {
    infoHash,
    name,
    status,
    sizeBytes: count(episode.sizeBytes),
    downloadedBytes: count(episode.downloadedBytes),
    uploadedBytes: count(episode.uploadedBytes),
    ratio: count(episode.ratio),
    uploadSpeedMbps: count(episode.uploadSpeedMbps),
    peers: Math.floor(count(episode.peers)),
    addedAt: count(episode.addedAt),
    lastActiveAt: count(episode.lastActiveAt),
    ...(typeof episode.error === 'string' && episode.error ? { error: episode.error } : {})
  };
}

export function normalizeSeedingOverview(value: unknown): SeedingOverview {
  const overview = record(value);
  const defaultTargetRatio = count(overview.defaultTargetRatio) || 1.5;
  return {
    targetRatio: count(overview.targetRatio) || defaultTargetRatio,
    defaultTargetRatio,
    cacheLimitBytes: count(overview.cacheLimitBytes),
    cacheUsedBytes: count(overview.cacheUsedBytes),
    totalUploadedBytes: count(overview.totalUploadedBytes),
    uploadSpeedMbps: count(overview.uploadSpeedMbps),
    uploadLimitBps: uploadLimit(overview.uploadLimitBps),
    episodes: Array.isArray(overview.episodes)
      ? overview.episodes.flatMap((episode) => normalizeEpisode(episode) ?? [])
      : []
  };
}

export function seedingStatusLabel(status: SeedingStatus): string {
  return STATUS_LABELS[status];
}

export function formatRatio(ratio: number): string {
  return Number.isFinite(ratio) && ratio > 0 ? ratio.toFixed(2) : '0.00';
}

export function formatUploadSpeed(mbps: number): string {
  if (!Number.isFinite(mbps) || mbps <= 0) return '0 KiB/s';
  return mbps >= 1 ? `${mbps.toFixed(2)} MiB/s` : `${Math.round(mbps * 1024)} KiB/s`;
}

export function formatUploadLimit(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) return 'Unlimited';
  const kib = bytesPerSecond / KIB;
  if (kib < 1024) return `${Math.round(kib)} KiB/s`;
  const mib = kib / 1024;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB/s`;
}

export function uploadLimitFromKib(kib: number): number | null {
  if (!Number.isFinite(kib)) return null;
  const bytes = Math.round(kib) * KIB;
  return bytes >= MIN_UPLOAD_LIMIT_BPS && bytes <= MAX_UPLOAD_LIMIT_BPS ? bytes : null;
}

export function normalizeTransferSpeeds(value: unknown): { downloadMbps: number; uploadMbps: number } {
  const speeds = record(value);
  return { downloadMbps: count(speeds.downloadMbps), uploadMbps: count(speeds.uploadMbps) };
}

export function percentOf(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

export function seedingDetail(episode: SeedingEpisode, targetRatio: number): string {
  switch (episode.status) {
    case 'streaming':
      return episode.ratio >= targetRatio
        ? 'Ratio reached. Removed after you stop watching.'
        : 'Shares with peers while you watch, then keeps seeding once fully downloaded.';
    case 'seeding':
      return `Removed automatically at a ${formatRatio(targetRatio)} ratio.`;
    case 'partial':
      return 'Paused and kept so you can resume quickly. Only finished episodes seed.';
    case 'downloading':
      return 'Pausing until you return to this episode.';
    case 'checking':
      return 'Verifying cached pieces.';
    case 'error':
      return episode.error ?? 'The torrent engine reported an error.';
  }
}
