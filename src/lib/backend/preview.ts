import { currentSeason } from '$lib/catalog/presentation';
import { validCatalogRequest, type CatalogProvider, type CatalogRequest } from '$lib/catalog/providers';
import { normalizeMyAnimeListClientId } from '$lib/settings';
import type {
  AnimeSeason,
  AniListSearchResult,
  AniListSeasonResponse,
  SubsPleaseIndexResponse,
  SubsPleaseScheduleResponse,
  SubsPleaseScheduleShow,
  SubsPleaseShowResponse,
  TorrentDetails,
  UpdateCheckResult
} from '$lib/types';

export const SINTEL_MAGNET =
  'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F';

const mockDetails: TorrentDetails = {
  id: 7,
  info_hash: '08ada5a7a6183aae1e09d831df6748d566095a10',
  name: 'Sintel — Open Movie',
  output_folder: 'StreamsPlease / media',
  files: [
    {
      name: 'Sintel.2010.1080p.mkv',
      components: ['Sintel.2010.1080p.mkv'],
      length: 1_294_727_168,
      included: true
    },
    {
      name: 'Sintel.en.ass',
      components: ['Sintel.en.ass'],
      length: 84_200,
      included: true
    }
  ]
};

const schedule: SubsPleaseScheduleResponse['schedule'] = {
  Monday: [
    { title: 'Grand Blue S3', page: 'grand-blue-s3', image_url: '/wp-content/uploads/2026/07/158194.jpg', time: '17:30' },
    { title: 'World Is Dancing', page: 'world-is-dancing', image_url: '/wp-content/uploads/2026/07/158709.jpg', time: '15:30' },
    { title: 'LIAR GAME', page: 'liar-game', image_url: '/wp-content/uploads/2026/04/156078.jpg', time: '18:00' }
  ],
  Tuesday: [
    { title: 'Kimi ga Shinu made Koi wo Shitai', page: 'kimi-ga-shinu-made-koi-wo-shitai', image_url: '/wp-content/uploads/2026/07/158712.jpg', time: '14:30' },
    { title: 'Sora wa Akai Kawa no Hotori', page: 'sora-wa-akai-kawa-no-hotori', image_url: '/wp-content/uploads/2026/07/158138.jpg', time: '19:40' },
    { title: 'Yoroi Shin Den Samurai Troopers', page: 'yoroi-shin-den-samurai-troopers', image_url: '/wp-content/uploads/2026/01/153952-1.jpg', time: '17:00' }
  ],
  Wednesday: [
    { title: 'Youjo Senki S2', page: 'youjo-senki-s2', image_url: '/wp-content/uploads/2026/07/158371.jpg', time: '15:30' },
    { title: 'Clevatess S2', page: 'clevatess-s2', image_url: '/wp-content/uploads/2026/07/157105.jpg', time: '14:00' },
    { title: 'Lv999 no Murabito', page: 'lv999-no-murabito', image_url: '/wp-content/uploads/2026/07/158400.jpg', time: '18:00' }
  ],
  Thursday: [
    { title: 'Bungou Stray Dogs Wan! S2', page: 'bungou-stray-dogs-wan-s2', image_url: '/wp-content/uploads/2026/07/157071.jpg', time: '14:40' },
    { title: 'BanG Dream! Yumemita', page: 'bang-dream-yumemita', image_url: '/wp-content/uploads/2026/07/158693.jpg', time: '16:00' },
    { title: 'Reiwa no Dara-san', page: 'reiwa-no-dara-san', image_url: '/wp-content/uploads/2026/07/155761.jpg', time: '14:30' }
  ],
  Friday: [
    { title: 'Tensei Shitara Slime Datta Ken S4', page: 'tensei-shitara-slime-datta-ken-s4', image_url: '/wp-content/uploads/2026/04/156389.jpg', time: '17:00' },
    { title: 'Nige Jouzu no Wakagimi S2', page: 'nige-jouzu-no-wakagimi-s2', image_url: '/wp-content/uploads/2026/07/156329.jpg', time: '18:00' },
    { title: 'Hell Mode S2', page: 'hell-mode-s2', image_url: '/wp-content/uploads/2026/07/156314.jpg', time: '18:30' }
  ],
  Saturday: [
    { title: 'Black Torch', page: 'black-torch', image_url: '/wp-content/uploads/2026/07/158363.jpg', time: '15:00' },
    { title: 'Yomi no Tsugai', page: 'yomi-no-tsugai', image_url: '/wp-content/uploads/2026/04/156397.jpg', time: '18:00' },
    { title: 'Honzuki no Gekokujou S4', page: 'honzuki-no-gekokujou-s4', image_url: '/wp-content/uploads/2026/04/155054.jpg', time: '11:30' }
  ],
  Sunday: [
    { title: 'Mushoku Tensei S3', page: 'mushoku-tensei-s3', image_url: '/wp-content/uploads/2026/07/158340.jpg', time: '17:00' },
    { title: 'One Piece', page: 'one-piece', image_url: '/wp-content/uploads/2020/10/73245.jpg', time: '18:00' },
    { title: 'Digimon Beatbreak', page: 'digimon-beatbreak', image_url: '/wp-content/uploads/2025/10/151242.jpg', time: '05:00' }
  ]
};

const scheduleShows = Object.values(schedule).flat().filter(
  (show): show is SubsPleaseScheduleShow => Boolean(show)
);

const mockIndex: SubsPleaseIndexResponse = {
  shows: [
    ...scheduleShows.map(({ title, page }) => ({ title, page })),
    { title: 'Mushoku Tensei', page: 'mushoku-tensei' },
    { title: 'Mushoku Tensei S2', page: 'mushoku-tensei-s2' }
  ]
};

function previewId(slug: string): number | undefined {
  const index = mockIndex.shows.findIndex((show) => show.page === slug);
  return index < 0 ? undefined : 900_000 + index;
}

function seasonIndex(season: AnimeSeason, year: number): number {
  return year * 4 + ['WINTER', 'SPRING', 'SUMMER', 'FALL'].indexOf(season);
}

function normalizeTitle(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function previewSeason(season: AnimeSeason, year: number): AniListSeasonResponse {
  const current = currentSeason();
  const offset = seasonIndex(season, year) - seasonIndex(current.season, current.year);
  if (Math.abs(offset) > 1) return { season, year, shows: [] };

  const selection =
    offset === 0
      ? scheduleShows
      : scheduleShows.filter((_, index) => index % 2 === (offset === -1 ? 0 : 1));
  return {
    season,
    year,
    shows: selection.map((show, index) => ({
      id: previewId(show.page)!,
      idMal: previewId(show.page)! + 100_000,
      title: { romaji: show.title, userPreferred: show.title },
      synonyms: [],
      description: 'Representative seasonal anime fixture available in the browser preview.',
      coverImage: { large: show.image_url },
      genres: ['Anime'],
      season,
      seasonYear: year,
      format: 'TV',
      status: offset === 1 ? 'NOT_YET_RELEASED' : 'RELEASING',
      episodes: 12,
      popularity: 1_000 - index
    }))
  };
}

function previewRecommendations(ids: number[]): AniListSearchResult[] {
  const seedIds = new Set(ids);
  const current = currentSeason();
  return previewSeason(current.season, current.year).shows
    .filter((show) => !seedIds.has(show.id))
    .slice(0, 10)
    .map((show) => ({
      ...show,
      trailer: { id: 'eRsGyueVLvQ', site: 'youtube' }
    }));
}

function previewSearch(query: string): AniListSearchResult[] {
  const term = normalizeTitle(query);
  const current = currentSeason();
  const candidates = [
    ...previewSeason(current.season, current.year).shows,
    ...mockIndex.shows.map((show) => ({
      id: previewId(show.page)!,
      idMal: previewId(show.page)! + 100_000,
      title: { romaji: show.title, userPreferred: show.title }
    }))
  ];
  const unique = new Map<string, AniListSearchResult>();
  for (const show of candidates) {
    const title = show.title.userPreferred ?? show.title.romaji ?? '';
    if ((!term || normalizeTitle(title).includes(term)) && !unique.has(title)) unique.set(title, show);
  }
  return [...unique.values()].slice(0, 10);
}

function previewShow(slug: string, anilistId?: number, includeMetadata = true): SubsPleaseShowResponse {
  const scheduled = scheduleShows.find((show) => show.page === slug);
  const indexed = mockIndex.shows.find((show) => show.page === slug);
  const title = scheduled?.title ?? indexed?.title ?? slug.split('-').join(' ');
  const releases = ['03', '02', '01'].map((episode, index) => ({
    time: ['Jul 20, 2026', 'Jul 13, 2026', 'Jul 6, 2026'][index],
    release_date: ['2026-07-20T17:30:00Z', '2026-07-13T17:30:00Z', '2026-07-06T17:30:00Z'][index],
    show: title,
    episode,
    downloads: ['480', '720', '1080'].map((res) => ({ res, torrent: '', magnet: SINTEL_MAGNET }))
  }));
  const metadata = includeMetadata && !['offline', 'anilist-offline'].includes(catalogPreviewMode() ?? '')
    ? {
        banner_image_url: undefined,
        trailer: { id: 'eRsGyueVLvQ', site: 'youtube' },
        genres: ['Anime', 'Adventure'],
        year: 2026,
        season: 'SUMMER' as AnimeSeason,
        start_date: { year: 2026, month: 7, day: 6 },
        format: 'TV',
        status: 'RELEASING',
        episode_count: 12,
        duration: 24,
        average_score: 78,
        popularity: 24_800,
        source: 'MANGA',
        country_of_origin: 'JP',
        tags: [
          { id: 1, name: 'Found Family', rank: 82 },
          { id: 2, name: 'Coming of Age', rank: 74 },
          { id: 3, name: 'Urban Fantasy', rank: 68 }
        ],
        studios: { nodes: [{ id: 1, name: 'Studio Preview', isAnimationStudio: true }] },
        streaming_episodes: releases.map((release) => ({
          title: `Episode ${Number(release.episode)}`,
          site: 'Crunchyroll'
        })),
        metadata_source: 'AniList',
        metadata_id: anilistId ?? previewId(slug)
      }
    : {};

  return {
    title,
    slug,
    subsplease_id: Math.abs(
      [...slug].reduce((total, character) => (total * 31 + character.charCodeAt(0)) | 0, 17)
    ),
    image_url: scheduled?.image_url ?? '',
    synopsis:
      'Representative browser-preview episodes use the legal Sintel torrent fixture and do not contact external providers.',
    batch: {},
    episode: Object.fromEntries(releases.map((release) => [`${title} - ${release.episode}`, release])),
    ...metadata
  };
}

const catalogProviders: CatalogProvider[] = [
  { id: 'anilist', label: 'AniList', capabilities: ['search', 'season', 'recommendations'] },
  { id: 'myanimelist', label: 'MyAnimeList', capabilities: ['search', 'season', 'recommendations'] },
  { id: 'jikan', label: 'MyAnimeList (Jikan)', capabilities: ['search', 'season', 'recommendations'] },
  { id: 'kitsu', label: 'Kitsu', capabilities: ['search', 'season'] }
];

function catalogPreviewMode(): string | null {
  return typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('catalogPreview');
}

function previewCatalog(
  provider: string,
  request: CatalogRequest,
  myAnimeListClientId?: string
): unknown {
  if (!catalogProviders.some((item) => item.id === provider) || !request
    || !['search', 'season', 'recommendations'].includes(request.kind)
    || (request.kind === 'search' && typeof request.query !== 'string')
    || (provider === 'myanimelist' && !normalizeMyAnimeListClientId(myAnimeListClientId))
    || !validCatalogRequest(request)) throw new Error('Invalid preview catalog request.');
  if (!catalogProviders.find((item) => item.id === provider)?.capabilities.includes(request.kind)) {
    throw new Error('This preview provider does not support the requested capability.');
  }
  const mode = catalogPreviewMode();
  if (mode === 'offline' || mode === `${provider}-offline`) {
    throw new Error('Provider unavailable in this preview scenario.');
  }
  const warnings = provider === 'jikan' || provider === 'kitsu'
    ? ['Preview alternative-provider fixture; identities remain unchanged.']
    : [];
  if (request.kind === 'search') return { provider, items: previewSearch(request.query), warnings };
  if (request.kind === 'recommendations') {
    return { provider, items: previewRecommendations(request.ids), warnings };
  }
  const season = previewSeason(request.season, request.year);
  return { provider, items: season.shows, season: season.season, year: season.year, warnings };
}

let mockStartedAt = Date.now();

export async function callPreviewBackend<T>(
  name: string,
  args?: Record<string, unknown>
): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, name === 'add_magnet' ? 650 : 80));
  if (name === 'runtime_info') {
    return {
      engine: 'librqbit',
      engineVersion: '8.1.1-demo',
      streamPort: 42420,
      downloadDir: 'StreamsPlease / media',
      mpvAvailable: true,
      mpvVersion: 'mpv 0.40 (UI preview)',
      trailerAvailable: true,
      trailerRuntimeVersion: 'Browser embed (UI preview)'
    } as T;
  }
  if (name === 'check_for_update') return { status: 'upToDate' } as UpdateCheckResult as T;
  if (name === 'install_update') return undefined as T;
  if (name === 'add_magnet') {
    const magnet = String(args?.magnet ?? '');
    if (!magnet.startsWith('magnet:?')) throw new Error('Enter a valid magnet link.');
    mockStartedAt = Date.now();
    return { id: 7, details: mockDetails, output_folder: mockDetails.output_folder } as T;
  }
  if (name === 'stream_url') return 'http://127.0.0.1:42420/torrents/7/stream/0' as T;
  if (name === 'torrent_status') {
    const elapsed = (Date.now() - mockStartedAt) / 1000;
    const progress = Math.min(1_294_727_168, 92_000_000 + elapsed * 3_800_000);
    return {
      state: 'live', file_progress: [progress, 0], progress_bytes: progress,
      uploaded_bytes: elapsed * 210_000, total_bytes: 1_294_727_168, finished: false,
      pieces: Array.from({ length: 1236 }, (_, index) => index < 105 || (index >= 420 && index < 455)),
      live: {
        download_speed: { mbps: 3.8, human_readable: '3.80 MiB/s' },
        upload_speed: { mbps: 0.21, human_readable: '0.21 MiB/s' },
        snapshot: { peer_stats: { live: 18, seen: 42, connecting: 3 } }
      }
    } as T;
  }
  if (name === 'subsplease_schedule') {
    return { tz: String(args?.timezone ?? 'Europe/Amsterdam'), schedule } as T;
  }
  if (name === 'subsplease_index') return mockIndex as T;
  if (name === 'catalog_providers') return structuredClone(catalogProviders) as T;
  if (name === 'catalog_request') {
    return previewCatalog(
      String(args?.provider ?? ''),
      args?.request as CatalogRequest,
      typeof args?.myAnimeListClientId === 'string' ? args.myAnimeListClientId : undefined
    ) as T;
  }
  if (name === 'anilist_season') {
    return previewSeason(
      String(args?.season ?? 'SUMMER').toUpperCase() as AnimeSeason,
      Number(args?.year ?? new Date().getFullYear())
    ) as T;
  }
  if (name === 'anilist_search') return previewSearch(String(args?.query ?? '')) as T;
  if (name === 'subsplease_show') {
    return previewShow(
      String(args?.slug ?? ''),
      typeof args?.anilistId === 'number' ? args.anilistId : undefined,
      args?.includeMetadata !== false
    ) as T;
  }
  if (name === 'export_library_file') return false as T;
  if (name === 'import_library_file') return null as T;
  return undefined as T;
}
