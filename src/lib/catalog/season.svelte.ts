import {
  currentSeason,
  loadProviderMappings,
  matchSubsPleaseSeason,
  shiftSeason
} from '$lib/catalog';
import {
  DAY_ORDER,
  type AnimeSeason,
  type AniListSeasonResponse,
  type AniListSeasonShow,
  type DayName,
  type SubsPleaseIndexResponse,
  type SubsPleaseIndexShow,
  type SubsPleaseScheduleResponse,
  type SubsPleaseScheduleShow
} from '$lib/types';

export const CONFIRMED_PROVIDER_MATCH_CONFIDENCE = 0.95;

export type LoadSeasonCatalog = (
  season: AnimeSeason,
  year: number
) => Promise<AniListSeasonResponse>;
export type LoadProviderIndex = () => Promise<SubsPleaseIndexResponse>;
export type LoadProviderSchedule = (
  timezone: string
) => Promise<SubsPleaseScheduleResponse>;

export interface SeasonCatalogMatch {
  anime: AniListSeasonShow;
  provider: SubsPleaseIndexShow;
  confidence: number;
  schedule?: SubsPleaseScheduleShow;
  day?: DayName;
}

interface SeasonCatalogOptions {
  loadSeason: LoadSeasonCatalog;
  loadIndex: LoadProviderIndex;
  loadSchedule: LoadProviderSchedule;
  timezone: string;
  initialSeason?: { season: AnimeSeason; year: number };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function createSeasonCatalog({
  loadSeason,
  loadIndex,
  loadSchedule,
  timezone,
  initialSeason = currentSeason()
}: SeasonCatalogOptions) {
  let season = $state<AnimeSeason>(initialSeason.season);
  let year = $state(initialSeason.year);
  let catalog = $state<AniListSeasonResponse | null>(null);
  let providerIndex = $state<SubsPleaseIndexResponse | null>(null);
  let schedule = $state<SubsPleaseScheduleResponse | null>(null);
  let catalogLoading = $state(true);
  let providerLoading = $state(true);
  let scheduleLoading = $state(true);
  let catalogError = $state('');
  let providerError = $state('');
  let scheduleError = $state('');

  let disposed = false;
  let seasonGeneration = 0;
  let providerGeneration = 0;
  let scheduleGeneration = 0;
  let seasonRequest: { key: string; promise: Promise<AniListSeasonResponse | null> } | null = null;
  let providerRequest: Promise<SubsPleaseIndexResponse | null> | null = null;
  let scheduleRequest: Promise<SubsPleaseScheduleResponse | null> | null = null;

  let seasonMatches = $derived.by((): SeasonCatalogMatch[] => {
    const catalogData = catalog;
    const providerData = providerIndex;
    if (!catalogData || !providerData) return [];

    const matches = matchSubsPleaseSeason(
      catalogData.shows,
      providerData.shows,
      loadProviderMappings()
    );
    return catalogData.shows.flatMap((anime): SeasonCatalogMatch[] => {
      const match = matches.get(anime.id);
      if (!match || match.confidence < CONFIRMED_PROVIDER_MATCH_CONFIDENCE) return [];

      const scheduled = scheduledProvider(match.provider.page, schedule);
      return [{
        anime,
        provider: match.provider,
        confidence: match.confidence,
        schedule: scheduled?.show,
        day: scheduled?.day
      }];
    });
  });

  function scheduledProvider(
    slug: string,
    scheduleData: SubsPleaseScheduleResponse | null
  ): { show: SubsPleaseScheduleShow; day: DayName } | undefined {
    for (const day of DAY_ORDER) {
      const show = scheduleData?.schedule[day]?.find((candidate) => candidate.page === slug);
      if (show) return { show, day };
    }
    return undefined;
  }

  async function runSeasonRequest(
    generation: number,
    requestedSeason: AnimeSeason,
    requestedYear: number
  ): Promise<AniListSeasonResponse | null> {
    try {
      const result = await loadSeason(requestedSeason, requestedYear);
      if (
        disposed ||
        generation !== seasonGeneration ||
        season !== requestedSeason ||
        year !== requestedYear
      ) {
        return null;
      }
      catalog = result;
      return result;
    } catch (reason) {
      if (
        !disposed &&
        generation === seasonGeneration &&
        season === requestedSeason &&
        year === requestedYear
      ) {
        catalog = null;
        catalogError = errorMessage(reason);
      }
      return null;
    } finally {
      if (!disposed && generation === seasonGeneration) catalogLoading = false;
    }
  }

  function refreshSeason(): Promise<AniListSeasonResponse | null> {
    if (disposed) return Promise.resolve(null);
    const key = `${season}:${year}`;
    if (seasonRequest?.key === key) return seasonRequest.promise;

    const generation = ++seasonGeneration;
    const requestedSeason = season;
    const requestedYear = year;
    catalog = null;
    catalogError = '';
    catalogLoading = true;

    const promise = runSeasonRequest(generation, requestedSeason, requestedYear);
    seasonRequest = { key, promise };
    void promise.finally(() => {
      if (seasonRequest?.promise === promise) seasonRequest = null;
    });
    return promise;
  }

  async function runProviderRequest(
    generation: number
  ): Promise<SubsPleaseIndexResponse | null> {
    try {
      const result = await loadIndex();
      if (disposed || generation !== providerGeneration) return null;
      providerIndex = result;
      return result;
    } catch (reason) {
      if (!disposed && generation === providerGeneration) {
        providerError = errorMessage(reason);
      }
      return null;
    } finally {
      if (!disposed && generation === providerGeneration) providerLoading = false;
    }
  }

  function refreshProvider(): Promise<SubsPleaseIndexResponse | null> {
    if (disposed) return Promise.resolve(null);
    if (providerRequest) return providerRequest;

    const generation = ++providerGeneration;
    providerError = '';
    providerLoading = true;
    const promise = runProviderRequest(generation);
    providerRequest = promise;
    void promise.finally(() => {
      if (providerRequest === promise) providerRequest = null;
    });
    return promise;
  }

  async function runScheduleRequest(
    generation: number
  ): Promise<SubsPleaseScheduleResponse | null> {
    try {
      const result = await loadSchedule(timezone);
      if (disposed || generation !== scheduleGeneration) return null;
      schedule = result;
      return result;
    } catch (reason) {
      if (!disposed && generation === scheduleGeneration) {
        scheduleError = errorMessage(reason);
      }
      return null;
    } finally {
      if (!disposed && generation === scheduleGeneration) scheduleLoading = false;
    }
  }

  function refreshSchedule(): Promise<SubsPleaseScheduleResponse | null> {
    if (disposed) return Promise.resolve(null);
    if (scheduleRequest) return scheduleRequest;

    const generation = ++scheduleGeneration;
    scheduleError = '';
    scheduleLoading = true;
    const promise = runScheduleRequest(generation);
    scheduleRequest = promise;
    void promise.finally(() => {
      if (scheduleRequest === promise) scheduleRequest = null;
    });
    return promise;
  }

  async function load(): Promise<void> {
    await Promise.all([refreshSeason(), refreshProvider(), refreshSchedule()]);
  }

  function selectSeason(nextSeason: AnimeSeason, nextYear: number): void {
    if (disposed || (nextSeason === season && nextYear === year)) return;

    seasonGeneration += 1;
    seasonRequest = null;
    season = nextSeason;
    year = nextYear;
    catalog = null;
    catalogError = '';
    catalogLoading = true;
    void refreshSeason();
  }

  function moveSeason(amount: number): void {
    const next = shiftSeason(season, year, amount);
    selectSeason(next.season, next.year);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    seasonGeneration += 1;
    providerGeneration += 1;
    scheduleGeneration += 1;
    seasonRequest = null;
    providerRequest = null;
    scheduleRequest = null;
  }

  return {
    get season() { return season; },
    get year() { return year; },
    get catalog() { return catalog; },
    get providerIndex() { return providerIndex; },
    get schedule() { return schedule; },
    get seasonMatches() { return seasonMatches; },
    get catalogLoading() { return catalogLoading; },
    get providerLoading() { return providerLoading; },
    get scheduleLoading() { return scheduleLoading; },
    get catalogError() { return catalogError; },
    get providerError() { return providerError; },
    get scheduleError() { return scheduleError; },
    load,
    refreshSeason,
    refreshProvider,
    refreshSchedule,
    selectSeason,
    moveSeason,
    dispose
  };
}
