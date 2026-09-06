import { CONFIRMED_MATCH_CONFIDENCE, matchSubsPleaseSeason } from '$lib/catalog/matching';
import type {
  CatalogMedia,
  LibraryEntry,
  SubsPleaseIndexShow,
  SubsPleaseShowResponse
} from '$lib/types';

export interface RecommendationMatch {
  anime: CatalogMedia;
  provider: SubsPleaseIndexShow;
  confidence: number;
}

function entryTimestamp(entry: LibraryEntry): number {
  for (const value of [entry.checkedAt, entry.updatedAt, entry.addedAt]) {
    const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

export function recommendationSeedIds(entries: LibraryEntry[], limit = 10): number[] {
  const maximum = Math.max(0, Math.min(10, Math.floor(limit)));
  const loved = entries
    .filter(
      (entry): entry is LibraryEntry & { anilistId: number } =>
        entry.discoveryVerdict === 'love' &&
        typeof entry.anilistId === 'number' &&
        Number.isSafeInteger(entry.anilistId) &&
        entry.anilistId > 0 &&
        entry.anilistId <= 2_147_483_647
    )
    .sort(
      (left, right) =>
        entryTimestamp(right) - entryTimestamp(left) ||
        left.anilistId - right.anilistId ||
        left.slug.localeCompare(right.slug)
    );

  return [...new Set(loved.map((entry) => entry.anilistId))].slice(0, maximum);
}

export function matchAvailableRecommendations(
  recommendations: CatalogMedia[],
  providerShows: SubsPleaseIndexShow[],
  mappings: Record<string, string> = {}
): RecommendationMatch[] {
  const matches = matchSubsPleaseSeason(recommendations, providerShows, mappings);
  return recommendations.flatMap((anime): RecommendationMatch[] => {
    const match = matches.get(anime.id);
    return match && match.confidence >= CONFIRMED_MATCH_CONFIDENCE
      ? [{ anime, provider: match.provider, confidence: match.confidence }]
      : [];
  });
}

export function filterReviewedRecommendations(
  recommendations: RecommendationMatch[],
  entries: LibraryEntry[]
): RecommendationMatch[] {
  const reviewed = entries.filter((entry) => Boolean(entry.discoveryVerdict));
  return recommendations.filter(
    ({ anime, provider }) =>
      !reviewed.some(
        (entry) =>
          (entry.anilistId !== undefined && entry.anilistId === anime.id) ||
          entry.slug === provider.page
      )
  );
}

function preferredTitle(media: CatalogMedia): string {
  return media.title.english || media.title.userPreferred || media.title.romaji ||
    media.title.native || `AniList #${media.id}`;
}

export function mergeRecommendationDetails(
  details: SubsPleaseShowResponse,
  recommendation: CatalogMedia,
  metadataSource?: string
): SubsPleaseShowResponse {
  return {
    ...details,
    title: preferredTitle(recommendation),
    synopsis: recommendation.description ?? details.synopsis,
    image_url:
      recommendation.coverImage?.extraLarge ??
      recommendation.coverImage?.large ??
      details.image_url,
    banner_image_url: recommendation.bannerImage ?? details.banner_image_url,
    trailer: recommendation.trailer ?? details.trailer,
    genres: recommendation.genres ?? details.genres,
    year: recommendation.startDate?.year ?? recommendation.seasonYear ?? details.year,
    season: recommendation.season ?? details.season,
    start_date: recommendation.startDate ?? details.start_date,
    end_date: recommendation.endDate ?? details.end_date,
    format: recommendation.format ?? details.format,
    status: recommendation.status ?? details.status,
    episode_count: recommendation.episodes ?? details.episode_count,
    duration: recommendation.duration ?? details.duration,
    average_score: recommendation.averageScore ?? details.average_score,
    popularity: recommendation.popularity ?? details.popularity,
    next_airing_episode: recommendation.nextAiringEpisode ?? details.next_airing_episode,
    relations: recommendation.relations ?? details.relations,
    metadata_source: metadataSource ?? details.metadata_source,
    metadata_url: recommendation.siteUrl ?? details.metadata_url,
    metadata_id: recommendation.id
  };
}
