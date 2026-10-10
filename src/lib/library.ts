import {
  DAY_ORDER,
  type DayName,
  type DiscoveryVerdict,
  type LibraryBackupEntry,
  type LibraryEntry,
  type SubsPleaseScheduleShow,
  type SubsPleaseShowResponse
} from '$lib/types';

const STORAGE_KEY = 'streamsplease.library.v2';
export const REGENERABLE_CACHE_KEYS = [
  'streamsplease.catalog-results.v1',
  'streamsplease.season-cache.v1',
  'streamsplease.provider-index.v1'
];
const EXPORT_FORMAT = 'streamsplease-library';
const EXPORT_VERSION = 1;
const MAX_LIBRARY_ENTRIES = 10_000;
const MAX_EPISODES_PER_ENTRY = 10_000;
export const MAX_LIBRARY_FILE_BYTES = 5_000_000;

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalDate(value: unknown): string | undefined {
  const source = optionalString(value);
  return source && Number.isFinite(Date.parse(source)) ? source : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? stringArray(value) : undefined;
}

function dayName(value: unknown): DayName | undefined {
  return typeof value === 'string' && DAY_ORDER.some((day) => day === value)
    ? (value as DayName)
    : undefined;
}

function subspleaseSlug(value: unknown): string | undefined {
  const slug = optionalString(value);
  return slug && slug.length <= 160 && /^[a-z0-9-]+$/.test(slug) ? slug : undefined;
}

function discoveryVerdict(value: unknown): DiscoveryVerdict | undefined {
  return value === 'love' || value === 'maybe' || value === 'pass' ? value : undefined;
}

function trailer(value: unknown): SubsPleaseShowResponse['trailer'] | undefined {
  if (!isRecord(value)) return undefined;
  const id = optionalString(value.id);
  const site = optionalString(value.site);
  if (!id || !site) return undefined;
  return { id, site, thumbnail: optionalString(value.thumbnail) };
}

function optionalField(
  value: Record<string, unknown>,
  key: string,
  validate: (field: unknown) => boolean
): boolean {
  return !(key in value) || value[key] === undefined || validate(value[key]);
}

function isLibraryBackupEntry(value: unknown): value is LibraryBackupEntry {
  if (!isRecord(value)) return false;
  const validId = (field: unknown) => optionalId(field) !== undefined;
  const validBoolean = (field: unknown) => typeof field === 'boolean';
  const validDate = (field: unknown) => optionalDate(field) !== undefined;
  const validEpisodes = (field: unknown) =>
    Array.isArray(field) &&
    field.length <= MAX_EPISODES_PER_ENTRY &&
    field.every((item) => {
      const episode = optionalString(item);
      return Boolean(episode && episode.length <= 64 && !/\p{Cc}/u.test(episode));
    });

  return Boolean(subspleaseSlug(value.slug)) &&
    validBoolean(value.following) &&
    validEpisodes(value.watchedEpisodes) &&
    validDate(value.addedAt) &&
    validDate(value.updatedAt) &&
    optionalField(value, 'anilistId', validId) &&
    optionalField(value, 'subspleaseId', validId) &&
    optionalField(value, 'libraryDismissed', validBoolean) &&
    optionalField(value, 'discoveryVerdict', (field) => discoveryVerdict(field) !== undefined) &&
    optionalField(value, 'checkedAt', validDate);
}

function normalizeLibraryEntry(value: unknown, now: string): LibraryEntry | undefined {
  if (!isRecord(value)) return undefined;
  const slug = subspleaseSlug(value.slug);
  const title = optionalString(value.title);
  if (!slug || !title) return undefined;

  const metadataId = optionalId(value.metadataId);
  const verdict = discoveryVerdict(value.discoveryVerdict);
  const libraryDismissed = optionalBoolean(value.libraryDismissed);
  return {
    anilistId: optionalId(value.anilistId) ?? metadataId,
    slug,
    subspleaseId: optionalId(value.subspleaseId),
    title,
    imageUrl: typeof value.imageUrl === 'string' ? value.imageUrl : '',
    bannerImageUrl: optionalString(value.bannerImageUrl),
    synopsis: optionalString(value.synopsis),
    genres: optionalStringArray(value.genres),
    year: optionalNumber(value.year),
    trailer: trailer(value.trailer),
    metadataId,
    following:
      verdict === 'love' && libraryDismissed !== true
        ? true
        : optionalBoolean(value.following) ?? true,
    libraryDismissed,
    discoveryVerdict: verdict,
    checkedAt: optionalDate(value.checkedAt),
    day: dayName(value.day),
    airingTime: optionalString(value.airingTime),
    episodeCount: optionalNumber(value.episodeCount),
    availableEpisodes: sortEpisodeNumbers(unique(stringArray(value.availableEpisodes))),
    watchedEpisodes: sortEpisodeNumbers(unique(stringArray(value.watchedEpisodes))),
    addedAt: optionalDate(value.addedAt) ?? now,
    updatedAt: optionalDate(value.updatedAt) ?? now
  };
}

function normalizeLibraryEntries(value: unknown): LibraryEntry[] {
  if (!Array.isArray(value)) return [];
  const now = new Date().toISOString();
  const entries = value.flatMap((entry) => {
    const normalized = normalizeLibraryEntry(entry, now);
    return normalized ? [normalized] : [];
  });
  return collapseLibraryDuplicates(entries);
}

function collapseLibraryDuplicates(entries: LibraryEntry[]): LibraryEntry[] {
  const result: LibraryEntry[] = [];
  for (const entry of entries) {
    const matches = result.flatMap((existing, index) =>
      existing.slug === entry.slug ||
      (entry.anilistId !== undefined && existing.anilistId === entry.anilistId)
        ? [index]
        : []
    );
    if (matches.length === 0) {
      result.push(entry);
      continue;
    }
    const [first, ...rest] = matches;
    const identity = result[first];
    let merged = mergeLibraryEntry(identity, entry);
    for (const index of rest) merged = mergeLibraryEntry(merged, result[index]);
    result[first] = {
      ...merged,
      slug: identity.slug,
      anilistId: identity.anilistId ?? merged.anilistId,
      metadataId: identity.metadataId ?? merged.metadataId,
      subspleaseId: identity.subspleaseId ?? merged.subspleaseId
    };
    for (const index of [...rest].reverse()) result.splice(index, 1);
  }
  return result;
}

function mergeLibraryEntry(current: LibraryEntry, imported: LibraryEntry): LibraryEntry {
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const importedUpdatedAt = Date.parse(imported.updatedAt);
  const newer = importedUpdatedAt >= currentUpdatedAt ? imported : current;
  const older = newer === imported ? current : imported;
  return {
    ...older,
    ...newer,
    anilistId: newer.anilistId ?? older.anilistId,
    subspleaseId: newer.subspleaseId ?? older.subspleaseId,
    metadataId: newer.metadataId ?? older.metadataId,
    availableEpisodes: newer.availableEpisodes,
    watchedEpisodes: sortEpisodeNumbers(unique([
      ...current.watchedEpisodes,
      ...imported.watchedEpisodes
    ])),
    addedAt:
      Date.parse(current.addedAt) <= Date.parse(imported.addedAt)
        ? current.addedAt
        : imported.addedAt
  };
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
    const source = window.localStorage.getItem(STORAGE_KEY) ?? '[]';
    return normalizeLibraryEntries(JSON.parse(source));
  } catch {
    return [];
  }
}

function isQuotaError(reason: unknown): boolean {
  if (!isRecord(reason) && !(reason instanceof Error)) return false;
  const { name, code } = reason as { name?: unknown; code?: unknown };
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014
  );
}

function clearRegenerableCaches(storage: Storage): void {
  const prefixes = REGENERABLE_CACHE_KEYS;
  const keys = new Set(prefixes);
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) keys.add(key);
    }
  } catch {
    return;
  }
  for (const key of keys) {
    try {
      storage.removeItem(key);
    } catch {
      continue;
    }
  }
}

export function saveLibrary(entries: LibraryEntry[]): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const storage = window.localStorage;
    const serialized = JSON.stringify(entries);
    try {
      storage.setItem(STORAGE_KEY, serialized);
      return true;
    } catch (reason) {
      if (!isQuotaError(reason)) return false;
      clearRegenerableCaches(storage);
      storage.setItem(STORAGE_KEY, serialized);
      return true;
    }
  } catch {
    return false;
  }
}

export function createLibraryExport(entries: LibraryEntry[]): string {
  if (entries.length > MAX_LIBRARY_ENTRIES) {
    throw new Error('The current library contains too many entries.');
  }
  const backups: LibraryBackupEntry[] = entries.map((entry) => ({
    anilistId: entry.anilistId,
    subspleaseId: entry.subspleaseId,
    slug: entry.slug,
    following: entry.following,
    libraryDismissed: entry.libraryDismissed,
    discoveryVerdict: entry.discoveryVerdict,
    checkedAt: entry.checkedAt,
    watchedEpisodes: sortEpisodeNumbers(unique(entry.watchedEpisodes)),
    addedAt: entry.addedAt,
    updatedAt: entry.updatedAt
  }));
  if (!backups.every(isLibraryBackupEntry)) {
    throw new Error('The current library contains data that cannot be exported.');
  }
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    entries: backups
  }, null, 2);
}

export function parseLibraryExport(source: string): LibraryBackupEntry[] {
  if (new TextEncoder().encode(source).byteLength > MAX_LIBRARY_FILE_BYTES) {
    throw new Error('The selected library file is too large.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }

  if (!isRecord(parsed) || parsed.format !== EXPORT_FORMAT) {
    throw new Error('Choose a StreamsPlease library JSON file.');
  }
  if (parsed.version !== EXPORT_VERSION) {
    throw new Error('This library export version is not supported.');
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error('The library file does not contain an entries list.');
  }
  if (parsed.entries.length > MAX_LIBRARY_ENTRIES) {
    throw new Error('The library file contains too many entries.');
  }
  if (!parsed.entries.every(isLibraryBackupEntry)) {
    throw new Error('The library file contains an invalid entry.');
  }

  const anilistIds = new Set<number>();
  const slugs = new Set<string>();
  for (const entry of parsed.entries) {
    if ((entry.anilistId && anilistIds.has(entry.anilistId)) || slugs.has(entry.slug)) {
      throw new Error('The library file contains duplicate shows.');
    }
    if (entry.anilistId) anilistIds.add(entry.anilistId);
    slugs.add(entry.slug);
  }
  return parsed.entries;
}

export function mergeLibraryEntries(
  current: LibraryEntry[],
  imported: LibraryEntry[]
): LibraryEntry[] {
  if (current.length > MAX_LIBRARY_ENTRIES) {
    throw new Error('The current library contains too many entries.');
  }
  const merged = [...current];
  const anilistIds = new Map<number, number>();
  const slugs = new Map<string, number>();

  for (const [index, entry] of merged.entries()) {
    if (
      (entry.anilistId && anilistIds.has(entry.anilistId)) ||
      slugs.has(entry.slug)
    ) {
      throw new Error('The current library contains conflicting show identities.');
    }
    if (entry.anilistId) anilistIds.set(entry.anilistId, index);
    slugs.set(entry.slug, index);
  }

  for (const entry of imported) {
    const anilistIndex = entry.anilistId ? anilistIds.get(entry.anilistId) : undefined;
    const slugIndex = slugs.get(entry.slug);
    if (
      anilistIndex !== undefined &&
      slugIndex !== undefined &&
      anilistIndex !== slugIndex
    ) {
      throw new Error(`The imported identity for ${entry.title} conflicts with this library.`);
    }

    const index = anilistIndex ?? slugIndex;
    if (index === undefined) {
      if (merged.length >= MAX_LIBRARY_ENTRIES) {
        throw new Error('The imported library would contain too many entries.');
      }
      const nextIndex = merged.length;
      merged.push(entry);
      if (entry.anilistId) anilistIds.set(entry.anilistId, nextIndex);
      slugs.set(entry.slug, nextIndex);
      continue;
    }

    const previous = merged[index];
    if (
      previous.anilistId &&
      entry.anilistId &&
      previous.anilistId !== entry.anilistId
    ) {
      throw new Error(`The imported identity for ${entry.title} conflicts with this library.`);
    }

    const next = mergeLibraryEntry(previous, entry);
    if (previous.slug !== next.slug && slugs.get(previous.slug) === index) {
      slugs.delete(previous.slug);
    }
    merged[index] = next;
    if (next.anilistId) anilistIds.set(next.anilistId, index);
    slugs.set(next.slug, index);
  }
  return merged;
}

export function findLibraryEntryIndex(
  entries: readonly LibraryEntry[],
  anilistId?: number,
  subspleaseSlug?: string
): number {
  if (anilistId) {
    const index = entries.findIndex((entry) => entry.anilistId === anilistId);
    if (index >= 0) return index;
  }
  return subspleaseSlug ? entries.findIndex((entry) => entry.slug === subspleaseSlug) : -1;
}

export function libraryEntryMatches(
  entry: LibraryEntry,
  anilistId?: number,
  subspleaseSlug?: string
): boolean {
  return findLibraryEntryIndex([entry], anilistId, subspleaseSlug) === 0;
}

export function entryFromShow(
  details: SubsPleaseShowResponse,
  scheduleShow: SubsPleaseScheduleShow,
  day?: DayName,
  previous?: LibraryEntry,
  now = new Date().toISOString()
): LibraryEntry {
  return {
    anilistId: details.metadata_id ?? scheduleShow.anilist_id ?? previous?.anilistId,
    slug: details.slug || scheduleShow.page,
    subspleaseId:
      details.subsplease_id ?? scheduleShow.subsplease_id ?? previous?.subspleaseId,
    title:
      previous && !details.metadata_id
        ? previous.title
        : details.title || scheduleShow.title,
    imageUrl:
      previous && !details.metadata_id
        ? previous.imageUrl
        : details.image_url || scheduleShow.image_url,
    bannerImageUrl: details.banner_image_url ?? previous?.bannerImageUrl,
    synopsis:
      previous && !details.metadata_id
        ? previous.synopsis ?? details.synopsis
        : details.synopsis || previous?.synopsis,
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
    episodeCount: details.episode_count ?? previous?.episodeCount,
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
  previous?: LibraryEntry,
  now = new Date().toISOString()
): LibraryEntry {
  const entry = entryFromShow(details, scheduleShow, day, previous, now);
  return {
    ...entry,
    following: verdict === 'love' || previous?.following === true,
    libraryDismissed: verdict === 'love' ? false : previous?.libraryDismissed,
    discoveryVerdict: verdict,
    checkedAt: now
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

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

export interface LibraryIdentity {
  anilistId?: number;
  slug: string;
}

function showIdentity(
  details: SubsPleaseShowResponse,
  show: SubsPleaseScheduleShow
): LibraryIdentity {
  return {
    anilistId: details.metadata_id ?? show.anilist_id,
    slug: details.slug || show.page
  };
}

function keepIdentity(
  entries: LibraryEntry[],
  index: number,
  next: LibraryEntry
): LibraryEntry {
  const previous = entries[index];
  const slugTaken = entries.some(
    (entry, entryIndex) => entryIndex !== index && entry.slug === next.slug
  );
  const idTaken =
    next.anilistId !== undefined &&
    entries.some(
      (entry, entryIndex) => entryIndex !== index && entry.anilistId === next.anilistId
    );
  return {
    ...next,
    slug: slugTaken ? previous.slug : next.slug,
    anilistId: previous.anilistId ?? (idTaken ? undefined : next.anilistId),
    metadataId: previous.metadataId ?? (idTaken ? undefined : next.metadataId)
  };
}

function replaceAt(entries: LibraryEntry[], index: number, next: LibraryEntry): LibraryEntry[] {
  const result = [...entries];
  result[index] = next;
  return result;
}

export function syncLibraryShow(
  entries: LibraryEntry[],
  details: SubsPleaseShowResponse,
  show: SubsPleaseScheduleShow,
  day?: DayName,
  now = new Date().toISOString()
): LibraryEntry[] {
  const identity = showIdentity(details, show);
  const index = findLibraryEntryIndex(entries, identity.anilistId, identity.slug);
  if (index < 0) return entries;
  const previous = entries[index];
  const next = {
    ...keepIdentity(entries, index, entryFromShow(details, show, day, previous, now)),
    updatedAt: previous.updatedAt
  };
  return deepEqual(previous, next) ? entries : replaceAt(entries, index, next);
}

export function toggleLibraryShow(
  entries: LibraryEntry[],
  details: SubsPleaseShowResponse,
  show: SubsPleaseScheduleShow,
  day?: DayName,
  now = new Date().toISOString()
): LibraryEntry[] {
  const identity = showIdentity(details, show);
  const index = findLibraryEntryIndex(entries, identity.anilistId, identity.slug);
  if (index < 0) return [...entries, entryFromShow(details, show, day, undefined, now)];
  const existing = entries[index];
  if (existing.following) {
    if (!existing.discoveryVerdict) return entries.filter((_, entryIndex) => entryIndex !== index);
    return replaceAt(entries, index, {
      ...existing,
      following: false,
      libraryDismissed: true,
      updatedAt: now
    });
  }
  return replaceAt(entries, index, {
    ...keepIdentity(entries, index, entryFromShow(details, show, day, existing, now)),
    following: true,
    libraryDismissed: false,
    updatedAt: now
  });
}

export function applyDiscoveryVerdict(
  entries: LibraryEntry[],
  details: SubsPleaseShowResponse,
  show: SubsPleaseScheduleShow,
  day: DayName | undefined,
  verdict?: DiscoveryVerdict,
  now = new Date().toISOString()
): LibraryEntry[] {
  const identity = showIdentity(details, show);
  const index = findLibraryEntryIndex(entries, identity.anilistId, identity.slug);
  if (!verdict) {
    if (index < 0) return entries;
    const existing = entries[index];
    if (!existing.following) return entries.filter((_, entryIndex) => entryIndex !== index);
    return replaceAt(entries, index, {
      ...existing,
      discoveryVerdict: undefined,
      checkedAt: undefined,
      updatedAt: now
    });
  }
  if (index < 0) {
    return [...entries, entryFromDiscovery(details, show, verdict, day, undefined, now)];
  }
  const next = keepIdentity(
    entries,
    index,
    entryFromDiscovery(details, show, verdict, day, entries[index], now)
  );
  return replaceAt(entries, index, { ...next, updatedAt: now });
}

export function setEpisodeWatched(
  entries: LibraryEntry[],
  identity: LibraryIdentity,
  episode: string,
  watched: boolean,
  now = new Date().toISOString()
): LibraryEntry[] {
  const index = findLibraryEntryIndex(entries, identity.anilistId, identity.slug);
  if (index < 0) return entries;
  const entry = entries[index];
  if (entry.watchedEpisodes.includes(episode) === watched) return entries;
  const watchedEpisodes = watched
    ? [...entry.watchedEpisodes, episode]
    : entry.watchedEpisodes.filter((value) => value !== episode);
  return replaceAt(entries, index, { ...entry, watchedEpisodes, updatedAt: now });
}

export function toggleEpisodeWatched(
  entries: LibraryEntry[],
  identity: LibraryIdentity,
  episode: string,
  now = new Date().toISOString()
): LibraryEntry[] {
  const index = findLibraryEntryIndex(entries, identity.anilistId, identity.slug);
  if (index < 0) return entries;
  return setEpisodeWatched(
    entries,
    identity,
    episode,
    !entries[index].watchedEpisodes.includes(episode),
    now
  );
}

export function setEpisodeProgress(
  entries: LibraryEntry[],
  identity: LibraryIdentity,
  progressCount: number,
  now = new Date().toISOString()
): LibraryEntry[] {
  const index = findLibraryEntryIndex(entries, identity.anilistId, identity.slug);
  if (index < 0) return entries;
  const entry = entries[index];
  const count = Math.min(Math.max(Math.round(progressCount), 0), entry.availableEpisodes.length);
  const watchedEpisodes = sortEpisodeNumbers(entry.availableEpisodes).slice(0, count);
  if (deepEqual(watchedEpisodes, entry.watchedEpisodes)) return entries;
  return replaceAt(entries, index, { ...entry, watchedEpisodes, updatedAt: now });
}
