import { decodeEntities, posterUrl, preferredTitle, seasonLabel } from '$lib/catalog/presentation';
import type { SeasonCatalogMatch } from '$lib/catalog/season.svelte';
import type {
  AnimeSeason,
  AniListSeasonShow,
  CatalogMedia,
  DayName,
  SubsPleaseIndexShow,
  SubsPleaseScheduleShow
} from '$lib/types';

export type DiscoveryMode = 'airing' | 'recommendations';

export interface DiscoveryCandidate {
  mode: DiscoveryMode;
  anime: CatalogMedia;
  show: SubsPleaseScheduleShow;
  season?: AnimeSeason;
  year?: number;
  day?: DayName;
}

export function candidateKey(candidate: DiscoveryCandidate | null | undefined): string {
  return candidate
    ? `${candidate.mode}:${candidate.anime.id}:${candidate.show.page}`
    : '';
}

export function hasSeriesPrequel(show: AniListSeasonShow): boolean {
  return (show.relations?.edges ?? []).some(
    (edge) =>
      edge.relationType === 'PREQUEL' &&
      edge.node?.type === 'ANIME' &&
      ['TV', 'TV_SHORT', 'ONA'].includes(edge.node.format ?? '')
  );
}

export function isObviousSequelTitle(value: string): boolean {
  const title = decodeEntities(value).toLowerCase();
  const numberedMarkers = [
    /\bs\s*(\d+)\b/g,
    /\bseason\s*(\d+)\b/g,
    /\bpart\s*(\d+)\b/g,
    /\bcour\s*(\d+)\b/g,
    /\b(\d+)(?:nd|rd|th)\s+(?:season|part|cour)\b/g
  ];
  if (
    numberedMarkers.some((pattern) =>
      [...title.matchAll(pattern)].some((match) => Number(match[1]) >= 2)
    )
  ) {
    return true;
  }
  return /\b(?:second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:season|part|cour)\b/.test(
    title
  );
}

export function candidateTiming(candidate: DiscoveryCandidate): string {
  if (candidate.day && candidate.show.time) {
    return `${candidate.day} · ${candidate.show.time}`;
  }
  const { year, month, day } = candidate.anime.startDate ?? {};
  if (year && month && day) {
    return new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }).format(new Date(year, month - 1, day));
  }
  if (candidate.season && candidate.year) {
    return `${seasonLabel(candidate.season)} ${candidate.year}`;
  }
  return 'Release date unavailable';
}

export function toAiringCandidate(
  match: SeasonCatalogMatch,
  season: AnimeSeason,
  year: number
): DiscoveryCandidate | undefined {
  const anime = match.anime;
  if (hasSeriesPrequel(anime) || isObviousSequelTitle(preferredTitle(anime))) return undefined;
  return {
    mode: 'airing',
    anime,
    show: {
      title: preferredTitle(anime),
      page: match.provider.page,
      image_url: posterUrl(
        anime.coverImage?.extraLarge ??
          anime.coverImage?.large ??
          match.schedule?.image_url ??
          ''
      ),
      time: match.schedule?.time ?? '',
      anilist_id: anime.id,
      subsplease_id: match.schedule?.subsplease_id
    },
    season,
    year,
    day: match.day
  };
}

export function toRecommendationCandidate(match: {
  anime: CatalogMedia;
  provider: SubsPleaseIndexShow;
}): DiscoveryCandidate {
  const { anime, provider } = match;
  return {
    mode: 'recommendations',
    anime,
    show: {
      title: preferredTitle(anime),
      page: provider.page,
      image_url: anime.coverImage?.extraLarge ?? anime.coverImage?.large ?? '',
      time: '',
      anilist_id: anime.id
    },
    season: anime.season,
    year: anime.seasonYear
  };
}
