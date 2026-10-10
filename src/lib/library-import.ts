import { entryFromShow, findLibraryEntryIndex } from '$lib/library';
import {
  DAY_ORDER,
  type DayName,
  type LibraryBackupEntry,
  type LibraryEntry,
  type SubsPleaseScheduleResponse,
  type SubsPleaseScheduleShow,
  type SubsPleaseShowResponse
} from '$lib/types';

export interface LibraryHydrationDeps {
  timezone: string;
  loadSchedule(timezone: string): Promise<SubsPleaseScheduleResponse>;
  loadShow(
    slug: string,
    timezone: string,
    anilistId?: number
  ): Promise<SubsPleaseShowResponse>;
  existing?: readonly LibraryEntry[];
  concurrency?: number;
}

type ScheduledShows = Map<string, { day: DayName; show: SubsPleaseScheduleShow }>;

async function loadScheduledShows(deps: LibraryHydrationDeps): Promise<ScheduledShows> {
  const scheduled: ScheduledShows = new Map();
  try {
    const schedule = await deps.loadSchedule(deps.timezone);
    for (const day of DAY_ORDER) {
      for (const show of schedule.schedule[day] ?? []) scheduled.set(show.page, { day, show });
    }
  } catch {
    scheduled.clear();
  }
  return scheduled;
}

function fallbackEntry(backup: LibraryBackupEntry, existing: readonly LibraryEntry[]): LibraryEntry {
  const local = existing[findLibraryEntryIndex(existing, backup.anilistId, backup.slug)];
  if (local) {
    return {
      ...local,
      following: backup.following,
      libraryDismissed: backup.libraryDismissed,
      discoveryVerdict: backup.discoveryVerdict,
      checkedAt: backup.checkedAt,
      watchedEpisodes: [...backup.watchedEpisodes],
      addedAt: backup.addedAt,
      updatedAt: backup.updatedAt
    };
  }
  return {
    anilistId: backup.anilistId,
    slug: backup.slug,
    subspleaseId: backup.subspleaseId,
    title: backup.slug,
    imageUrl: '',
    metadataId: backup.anilistId,
    following: backup.following,
    libraryDismissed: backup.libraryDismissed,
    discoveryVerdict: backup.discoveryVerdict,
    checkedAt: backup.checkedAt,
    availableEpisodes: [],
    watchedEpisodes: [...backup.watchedEpisodes],
    addedAt: backup.addedAt,
    updatedAt: backup.updatedAt
  };
}

async function hydrateBackup(
  backup: LibraryBackupEntry,
  deps: LibraryHydrationDeps,
  scheduledShows: ScheduledShows
): Promise<LibraryEntry> {
  const details = await deps.loadShow(backup.slug, deps.timezone, backup.anilistId);
  const scheduled = scheduledShows.get(backup.slug);
  const show = scheduled?.show ?? {
    title: details.title,
    page: details.slug || backup.slug,
    image_url: details.image_url,
    time: '',
    anilist_id: details.metadata_id ?? backup.anilistId,
    subsplease_id: details.subsplease_id ?? backup.subspleaseId
  };
  return {
    ...entryFromShow(details, show, scheduled?.day),
    anilistId: details.metadata_id ?? backup.anilistId,
    subspleaseId: details.subsplease_id ?? backup.subspleaseId,
    following: backup.following,
    libraryDismissed: backup.libraryDismissed,
    discoveryVerdict: backup.discoveryVerdict,
    checkedAt: backup.checkedAt,
    watchedEpisodes: backup.watchedEpisodes,
    addedAt: backup.addedAt,
    updatedAt: backup.updatedAt
  };
}

export async function hydrateLibraryBackups(
  backups: LibraryBackupEntry[],
  deps: LibraryHydrationDeps
): Promise<{ entries: LibraryEntry[]; failed: string[] }> {
  if (backups.length === 0) return { entries: [], failed: [] };
  const scheduledShows = await loadScheduledShows(deps);
  const size = Math.max(1, Math.floor(deps.concurrency ?? 4));
  const entries: LibraryEntry[] = [];
  const failed: string[] = [];

  for (let index = 0; index < backups.length; index += size) {
    const batch = backups.slice(index, index + size);
    const settled = await Promise.allSettled(
      batch.map((backup) => hydrateBackup(backup, deps, scheduledShows))
    );
    settled.forEach((result, position) => {
      if (result.status === 'fulfilled') {
        entries.push(result.value);
      } else {
        failed.push(batch[position].slug);
        entries.push(fallbackEntry(batch[position], deps.existing ?? []));
      }
    });
  }
  return { entries, failed };
}
