import {
  applyDiscoveryVerdict,
  loadLibrary,
  mergeLibraryEntries,
  saveLibrary,
  setEpisodeProgress,
  setEpisodeWatched,
  syncLibraryShow,
  toggleEpisodeWatched,
  toggleLibraryShow,
  type LibraryIdentity
} from '$lib/library';
import { hydrateLibraryBackups, type LibraryHydrationDeps } from '$lib/library-import';
import type {
  DayName,
  DiscoveryVerdict,
  LibraryBackupEntry,
  LibraryEntry,
  SubsPleaseScheduleShow,
  SubsPleaseShowResponse
} from '$lib/types';

export type LibraryPersistence = {
  load: () => LibraryEntry[];
  save: (entries: LibraryEntry[]) => boolean;
};

export type LibraryImportDeps = Omit<LibraryHydrationDeps, 'existing'>;

const browserPersistence: LibraryPersistence = { load: loadLibrary, save: saveLibrary };

export class LibraryStore {
  entries = $state<LibraryEntry[]>([]);
  private readonly persistence: LibraryPersistence;

  constructor(persistence: LibraryPersistence = browserPersistence) {
    this.persistence = persistence;
    this.entries = persistence.load();
  }

  syncShow = (details: SubsPleaseShowResponse, show: SubsPleaseScheduleShow, day?: DayName): void => {
    this.commit(syncLibraryShow(this.entries, details, show, day));
  };

  toggleShow = (details: SubsPleaseShowResponse, show: SubsPleaseScheduleShow, day?: DayName): void => {
    this.commit(toggleLibraryShow(this.entries, details, show, day));
  };

  setVerdict = (
    details: SubsPleaseShowResponse,
    show: SubsPleaseScheduleShow,
    day: DayName | undefined,
    verdict?: DiscoveryVerdict
  ): void => {
    this.commit(applyDiscoveryVerdict(this.entries, details, show, day, verdict));
  };

  setEpisodeWatched = (identity: LibraryIdentity, episode: string, watched: boolean): void => {
    this.commit(setEpisodeWatched(this.entries, identity, episode, watched));
  };

  toggleEpisodeWatched = (slug: string, episode: string): void => {
    this.commit(toggleEpisodeWatched(this.entries, { slug }, episode));
  };

  setEpisodeProgress = (slug: string, progressCount: number): void => {
    this.commit(setEpisodeProgress(this.entries, { slug }, progressCount));
  };

  importBackups = async (
    backups: LibraryBackupEntry[],
    deps: LibraryImportDeps
  ): Promise<{ failed: string[] }> => {
    const { entries, failed } = await hydrateLibraryBackups(backups, { ...deps, existing: this.entries });
    if (entries.length) this.commit(mergeLibraryEntries(this.entries, entries));
    return { failed };
  };

  private commit(entries: LibraryEntry[]): void {
    if (entries === this.entries) return;
    if (!this.persistence.save(entries)) console.error('The library could not be saved to local storage.');
    this.entries = entries;
  }
}
