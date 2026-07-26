import type { AniListStreamingEpisode, SubsPleaseShowResponse } from '$lib/types';

export interface EpisodeSupplement {
  title?: string;
  thumbnail?: string;
  site?: string;
}

export function episodeNumberKey(value: string | number): string {
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return normalized.toLocaleLowerCase();
  return String(Number(normalized));
}

function parseStreamingEpisode(episode: AniListStreamingEpisode): {
  key: string;
  title?: string;
} | undefined {
  const match = /^\s*(?:episode|ep\.?)[\s#]*(\d+(?:\.\d+)?)(?:\s*[-–—:]\s*(.+))?\s*$/i.exec(
    episode.title ?? ''
  );
  if (!match) return undefined;
  const title = match[2]?.trim();
  return {
    key: episodeNumberKey(match[1]),
    title: title || undefined
  };
}

function safeThumbnail(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function supplementScore(supplement: EpisodeSupplement): number {
  return Number(Boolean(supplement.title)) * 2 + Number(Boolean(supplement.thumbnail));
}

export function buildEpisodeSupplements(
  show?: SubsPleaseShowResponse | null
): Map<string, EpisodeSupplement> {
  const supplements = new Map<string, EpisodeSupplement>();
  const candidates = (show?.streaming_episodes ?? []).flatMap((episode) => {
    const parsed = parseStreamingEpisode(episode);
    if (!parsed) return [];
    return [{ episode, parsed, thumbnail: safeThumbnail(episode.thumbnail) }];
  });
  const thumbnailEpisodes = new Map<string, Set<string>>();

  for (const candidate of candidates) {
    if (!candidate.thumbnail) continue;
    const keys = thumbnailEpisodes.get(candidate.thumbnail) ?? new Set<string>();
    keys.add(candidate.parsed.key);
    thumbnailEpisodes.set(candidate.thumbnail, keys);
  }

  for (const candidate of candidates) {
    const thumbnail = candidate.thumbnail;
    const supplement: EpisodeSupplement = {
      title: candidate.parsed.title,
      thumbnail:
        thumbnail && thumbnailEpisodes.get(thumbnail)?.size === 1 ? thumbnail : undefined,
      site: candidate.episode.site?.trim() || undefined
    };
    const existing = supplements.get(candidate.parsed.key);
    if (!existing || supplementScore(supplement) > supplementScore(existing)) {
      supplements.set(candidate.parsed.key, supplement);
    }
  }

  return supplements;
}
