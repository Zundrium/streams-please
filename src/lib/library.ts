import type {
  DayName,
  DiscoveryVerdict,
  LibraryEntry,
  SubsPleaseScheduleShow,
  SubsPleaseShowResponse
} from '$lib/types';

const STORAGE_KEY = 'yoru-stream.library.v2';
const LEGACY_STORAGE_KEY = 'yoru-stream.library.v1';

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function sortEpisodeNumbers(values: string[]): string[] {
  return [...values].sort((left, right) => {
    const leftNumber = Number.parseFloat(left);
    const rightNumber = Number.parseFloat(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    return left.localeCompare(right, undefined, { numeric: true });
  });
}

export function loadLibrary(): LibraryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const source =
      window.localStorage.getItem(STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_STORAGE_KEY) ??
      '[]';
    const parsed = JSON.parse(source);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): LibraryEntry[] => {
      if (!value || typeof value !== 'object') return [];
      const entry = value as Partial<LibraryEntry>;
      if (!entry.slug || !entry.title) return [];
      return [{
        anilistId: entry.anilistId ?? entry.metadataId,
        slug: entry.slug,
        subspleaseId: entry.subspleaseId,
        title: entry.title,
        imageUrl: entry.imageUrl ?? '',
        bannerImageUrl: entry.bannerImageUrl,
        synopsis: entry.synopsis,
        genres: entry.genres,
        year: entry.year,
        trailer: entry.trailer,
        metadataId: entry.metadataId,
        following:
          entry.discoveryVerdict === 'love' && !entry.libraryDismissed
            ? true
            : entry.following ?? true,
        libraryDismissed: entry.libraryDismissed,
        discoveryVerdict: entry.discoveryVerdict,
        checkedAt: entry.checkedAt,
        day: entry.day,
        airingTime: entry.airingTime,
        episodeCount: entry.episodeCount,
        availableEpisodes: sortEpisodeNumbers(unique(entry.availableEpisodes ?? [])),
        watchedEpisodes: sortEpisodeNumbers(unique(entry.watchedEpisodes ?? [])),
        addedAt: entry.addedAt ?? new Date().toISOString(),
        updatedAt: entry.updatedAt ?? new Date().toISOString()
      }];
    });
  } catch {
    return [];
  }
}

export function saveLibrary(entries: LibraryEntry[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function libraryEntryMatches(
  entry: LibraryEntry,
  anilistId?: number,
  subspleaseSlug?: string
): boolean {
  if (anilistId && entry.anilistId) return entry.anilistId === anilistId;
  return Boolean(subspleaseSlug && entry.slug === subspleaseSlug);
}

export function entryFromShow(
  details: SubsPleaseShowResponse,
  scheduleShow: SubsPleaseScheduleShow,
  day?: DayName,
  previous?: LibraryEntry
): LibraryEntry {
  const now = new Date().toISOString();
  return {
    anilistId: details.metadata_id ?? scheduleShow.anilist_id ?? previous?.anilistId,
    slug: details.slug || scheduleShow.page,
    subspleaseId:
      details.subsplease_id ?? scheduleShow.subsplease_id ?? previous?.subspleaseId,
    title: details.title || scheduleShow.title,
    imageUrl: details.image_url || scheduleShow.image_url,
    bannerImageUrl: details.banner_image_url,
    synopsis: details.synopsis || previous?.synopsis,
    genres: details.genres ?? previous?.genres,
    year: details.year ?? previous?.year,
    trailer: details.trailer ?? previous?.trailer,
    metadataId: details.metadata_id ?? scheduleShow.anilist_id ?? previous?.metadataId,
    following: previous?.following ?? true,
    libraryDismissed: previous?.libraryDismissed,
    discoveryVerdict: previous?.discoveryVerdict,
    checkedAt: previous?.checkedAt,
    day: day ?? previous?.day,
    airingTime: scheduleShow.time || previous?.airingTime,
    episodeCount: details.episode_count,
    availableEpisodes: sortEpisodeNumbers(
      unique(Object.values(details.episode ?? {}).map((release) => release.episode))
    ),
    watchedEpisodes: previous?.watchedEpisodes ?? [],
    addedAt: previous?.addedAt ?? now,
    updatedAt: now
  };
}

export function entryFromDiscovery(
  details: SubsPleaseShowResponse,
  scheduleShow: SubsPleaseScheduleShow,
  verdict: DiscoveryVerdict,
  day?: DayName,
  previous?: LibraryEntry
): LibraryEntry {
  const entry = entryFromShow(details, scheduleShow, day, previous);
  return {
    ...entry,
    following: verdict === 'love' || previous?.following === true,
    libraryDismissed: verdict === 'love' ? false : previous?.libraryDismissed,
    discoveryVerdict: verdict,
    checkedAt: new Date().toISOString()
  };
}

export function watchedCount(entry: LibraryEntry): number {
  const available = new Set(entry.availableEpisodes);
  return entry.watchedEpisodes.filter((episode) => available.has(episode)).length;
}

export function nextUnwatchedEpisode(entry: LibraryEntry): string | undefined {
  const watched = new Set(entry.watchedEpisodes);
  return sortEpisodeNumbers(entry.availableEpisodes).find((episode) => !watched.has(episode));
}
