import { preferredDownload } from '$lib/catalog/media';
import { libraryEntryMatches, nextUnwatchedEpisode, sortEpisodeNumbers } from '$lib/library';
import type {
  EpisodePlaybackRequest,
  LibraryEntry,
  PlaybackQuality,
  SubsPleaseDownload,
  SubsPleaseRelease,
  SubsPleaseShowResponse
} from '$lib/types';

export type NextEpisodePlan = {
  episode: EpisodePlaybackRequest | null;
  fromLibrary: boolean;
};

export type NextEpisodeDeps = {
  timezone: string;
  preferredQuality: PlaybackQuality;
  libraryEntries: () => readonly LibraryEntry[];
  loadShow: (slug: string, timezone: string, anilistId?: number) => Promise<SubsPleaseShowResponse>;
  isCurrent: () => boolean;
};

export function episodePlaybackKey(request: Pick<EpisodePlaybackRequest, 'slug' | 'episode'>): string {
  return `${request.slug}:${request.episode}`;
}

export function sameEpisode(left: string, right: string): boolean {
  if (left === right) return true;
  const leftNumber = Number.parseFloat(left);
  const rightNumber = Number.parseFloat(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
}

export function nextRelease(
  details: SubsPleaseShowResponse,
  currentEpisode: string
): SubsPleaseRelease | undefined {
  const releases = Object.values(details.episode ?? {});
  const episodeOrder = sortEpisodeNumbers(releases.map((release) => release.episode));
  const currentIndex = episodeOrder.findIndex((episode) => sameEpisode(episode, currentEpisode));
  if (currentIndex < 0) return undefined;
  const nextEpisodeNumber = episodeOrder[currentIndex + 1];
  return nextEpisodeNumber
    ? releases.find((release) => release.episode === nextEpisodeNumber)
    : undefined;
}

export function continuationDownload(
  release: SubsPleaseRelease,
  currentQuality: string,
  preferredQuality: PlaybackQuality
): SubsPleaseDownload | undefined {
  return (
    release.downloads.find((download) => download.res === currentQuality) ??
    preferredDownload(release, preferredQuality)
  );
}

export function libraryRecommendationCandidates(
  entries: readonly LibraryEntry[],
  request: EpisodePlaybackRequest
): LibraryEntry[] {
  const candidates = entries.filter(
    (entry) =>
      entry.following &&
      !libraryEntryMatches(entry, request.anilistId, request.slug) &&
      Boolean(nextUnwatchedEpisode(entry))
  );
  return [
    ...candidates.filter((entry) => entry.watchedEpisodes.length > 0),
    ...candidates.filter((entry) => entry.watchedEpisodes.length === 0)
  ];
}

function playbackRequest(
  details: SubsPleaseShowResponse,
  release: SubsPleaseRelease,
  download: SubsPleaseDownload,
  fallback: Pick<EpisodePlaybackRequest, 'anilistId' | 'slug' | 'title' | 'imageUrl' | 'day' | 'airingTime'>
): EpisodePlaybackRequest {
  return {
    anilistId: details.metadata_id ?? fallback.anilistId,
    slug: details.slug || fallback.slug,
    title: details.title || fallback.title,
    imageUrl: details.image_url || fallback.imageUrl,
    episode: release.episode,
    magnet: download.magnet,
    quality: download.res,
    day: fallback.day,
    airingTime: fallback.airingTime
  };
}

async function libraryRecommendation(
  request: EpisodePlaybackRequest,
  deps: NextEpisodeDeps
): Promise<EpisodePlaybackRequest | null | undefined> {
  for (const entry of libraryRecommendationCandidates(deps.libraryEntries(), request)) {
    const episode = nextUnwatchedEpisode(entry);
    if (!episode) continue;
    try {
      const details = await deps.loadShow(entry.slug, deps.timezone, entry.anilistId);
      if (!deps.isCurrent()) return undefined;
      const release = Object.values(details.episode ?? {}).find((item) =>
        sameEpisode(item.episode, episode)
      );
      const download = release
        ? continuationDownload(release, request.quality, deps.preferredQuality)
        : undefined;
      if (!release || !download?.magnet) continue;
      return playbackRequest(details, release, download, {
        anilistId: entry.anilistId,
        slug: entry.slug,
        title: entry.title,
        imageUrl: entry.imageUrl,
        day: entry.day,
        airingTime: entry.airingTime
      });
    } catch {
      if (!deps.isCurrent()) return undefined;
    }
  }
  return null;
}

export async function planNextEpisode(
  request: EpisodePlaybackRequest,
  deps: NextEpisodeDeps
): Promise<NextEpisodePlan | undefined> {
  try {
    const details = await deps.loadShow(request.slug, deps.timezone, request.anilistId);
    if (!deps.isCurrent()) return undefined;

    const release = nextRelease(details, request.episode);
    const download = release
      ? continuationDownload(release, request.quality, deps.preferredQuality)
      : undefined;
    if (release && download?.magnet) {
      return { episode: playbackRequest(details, release, download, request), fromLibrary: false };
    }

    const recommendation = await libraryRecommendation(request, deps);
    if (recommendation === undefined || !deps.isCurrent()) return undefined;
    return { episode: recommendation, fromLibrary: Boolean(recommendation) };
  } catch {
    return deps.isCurrent() ? { episode: null, fromLibrary: false } : undefined;
  }
}
