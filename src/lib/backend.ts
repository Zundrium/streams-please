import { invoke } from '@tauri-apps/api/core';
import type {
  AnimeSeason,
  AniListSearchResult,
  AniListSeasonResponse,
  SubsPleaseIndexResponse,
  SubsPleaseScheduleResponse,
  SubsPleaseShowResponse,
  TorrentDetails
} from '$lib/types';

export const SINTEL_MAGNET =
  'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

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

const mockSubsPleaseSchedule: SubsPleaseScheduleResponse = {
  tz: 'Europe/Amsterdam',
  schedule: {
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
  }
};

function mockSubsPleaseShow(slug: string, anilistId?: number): SubsPleaseShowResponse {
  const show = Object.values(mockSubsPleaseSchedule.schedule)
    .flat()
    .find((item) => item?.page === slug);
  const title = show?.title ?? slug.split('-').join(' ');
  const makeRelease = (episode: string, daysAgo: number) => ({
    time: new Date(Date.now() - daysAgo * 86_400_000).toLocaleDateString('en-US'),
    release_date: new Date(Date.now() - daysAgo * 86_400_000).toUTCString(),
    show: title,
    episode,
    downloads: ['480', '720', '1080'].map((res) => ({
      res,
      torrent: '',
      magnet: SINTEL_MAGNET
    }))
  });
  const releases = [makeRelease('03', 0), makeRelease('02', 7), makeRelease('01', 14)];
  const episodeTitles: Record<string, string> = {
    '01': 'A New Beginning',
    '02': 'The Road Ahead',
    '03': 'An Unexpected Visitor'
  };

  return {
    title,
    slug,
    subsplease_id: Math.abs(
      [...slug].reduce((total, character) => (total * 31 + character.charCodeAt(0)) | 0, 17)
    ),
    image_url: show?.image_url ?? '',
    synopsis:
      'New episodes appear here according to the current SubsPlease schedule. Select an episode to open it in the StreamsPlease player.',
    batch: {},
    genres: ['Anime', 'Adventure'],
    year: 2026,
    season: 'SUMMER',
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
      title: `Episode ${Number(release.episode)} - ${episodeTitles[release.episode]}`,
      site: 'Crunchyroll'
    })),
    metadata_source: 'AniList',
    metadata_id: anilistId,
    episode: Object.fromEntries(
      releases.map((release) => [`${title} - ${release.episode}`, release])
    )
  };
}

async function enrichMockShow(show: SubsPleaseShowResponse): Promise<SubsPleaseShowResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5_000);
  try {
    const [exact, normalized, short] = anilistSearchQueries(show.title);
    const hasId = Boolean(show.metadata_id);
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        query: `query ($id: Int, $hasId: Boolean!, $exact: String!, $normalized: String!, $short: String!) {
          direct: Media(id: $id, type: ANIME) @include(if: $hasId) {
            ...Metadata
          }
          exact: Page(page: 1, perPage: 6) @skip(if: $hasId) {
            media(search: $exact, type: ANIME) { ...Metadata }
          }
          normalized: Page(page: 1, perPage: 6) @skip(if: $hasId) {
            media(search: $normalized, type: ANIME) { ...Metadata }
          }
          short: Page(page: 1, perPage: 6) @skip(if: $hasId) {
            media(search: $short, type: ANIME) { ...Metadata }
          }
        }
        fragment Metadata on Media {
            id
            idMal
            title { romaji english native userPreferred }
            synonyms
            description(asHtml: false)
            trailer { id site thumbnail }
            coverImage { extraLarge large }
            bannerImage
            genres
            season
            seasonYear
            startDate { year month day }
            endDate { year month day }
            format
            status
            episodes
            duration
            averageScore
            popularity
            source(version: 3)
            countryOfOrigin
            tags { id name rank isGeneralSpoiler isMediaSpoiler }
            studios(isMain: true) {
              nodes { id name isAnimationStudio siteUrl }
            }
            nextAiringEpisode { episode airingAt timeUntilAiring }
            streamingEpisodes { title thumbnail site }
            siteUrl
            relations {
              edges {
                relationType
                node {
                  id
                  type
                  format
                  status
                  season
                  seasonYear
                  title { romaji english native userPreferred }
                  synonyms
                  coverImage { extraLarge large color }
                  siteUrl
                }
              }
            }
        }`,
        variables: { id: show.metadata_id, hasId, exact, normalized, short }
      })
    });
    if (!response.ok) return show;
    const payload = await response.json();
    const candidates = hasId
      ? [payload?.data?.direct]
      : ['exact', 'normalized', 'short'].flatMap(
          (key) => payload?.data?.[key]?.media ?? []
        );
    const seen = new Set<number>();
    const media = hasId
      ? candidates.find((candidate) => candidate?.id === show.metadata_id)
      : candidates
          .filter((candidate) => {
            if (!candidate?.id || seen.has(candidate.id)) return false;
            seen.add(candidate.id);
            return true;
          })
          .map((candidate) => ({
            candidate,
            score: anilistCandidateScore(show.title, candidate)
          }))
          .filter(({ score }) => score >= 0.62)
          .sort((left, right) => right.score - left.score)[0]?.candidate;
    if (!media) return show;
    return {
      ...show,
      title:
        media.title?.english ??
        media.title?.userPreferred ??
        media.title?.romaji ??
        media.title?.native ??
        show.title,
      synopsis: media.description || show.synopsis,
      image_url: media.coverImage?.extraLarge || media.coverImage?.large || show.image_url,
      banner_image_url: media.bannerImage || undefined,
      trailer: media.trailer || undefined,
      genres: media.genres || show.genres,
      year: media.seasonYear || show.year,
      season: media.season || show.season,
      start_date: media.startDate || show.start_date,
      end_date: media.endDate || show.end_date,
      format: media.format || show.format,
      status: media.status || show.status,
      episode_count: media.episodes || show.episode_count,
      duration: media.duration || show.duration,
      average_score: media.averageScore || show.average_score,
      popularity: media.popularity || show.popularity,
      source: media.source || show.source,
      country_of_origin: media.countryOfOrigin || show.country_of_origin,
      tags: media.tags || show.tags,
      studios: media.studios || show.studios,
      next_airing_episode: media.nextAiringEpisode || show.next_airing_episode,
      streaming_episodes:
        Array.isArray(media.streamingEpisodes) && media.streamingEpisodes.length
          ? media.streamingEpisodes
          : show.streaming_episodes,
      relations: media.relations || undefined,
      has_series_prequel: (media.relations?.edges ?? []).some(
        (edge: Record<string, any>) =>
          edge?.relationType === 'PREQUEL' &&
          edge?.node?.type === 'ANIME' &&
          ['TV', 'TV_SHORT', 'ONA'].includes(edge?.node?.format)
      ),
      metadata_source: 'AniList',
      metadata_url: media.siteUrl || undefined,
      metadata_id: media.id || undefined
    };
  } catch {
    return show;
  } finally {
    window.clearTimeout(timeout);
  }
}

const mockSubsPleaseIndex: SubsPleaseIndexResponse = {
  shows: [
    ...Object.values(mockSubsPleaseSchedule.schedule)
      .flat()
      .filter((show): show is NonNullable<typeof show> => Boolean(show))
      .map((show) => ({ title: show.title, page: show.page })),
    { title: 'Mushoku Tensei', page: 'mushoku-tensei' },
    { title: 'Mushoku Tensei S2', page: 'mushoku-tensei-s2' }
  ]
};

function currentAnimeSeason(date = new Date()): { season: AnimeSeason; year: number } {
  const month = date.getMonth() + 1;
  const season: AnimeSeason =
    month <= 3 ? 'WINTER' : month <= 6 ? 'SPRING' : month <= 9 ? 'SUMMER' : 'FALL';
  return { season, year: date.getFullYear() };
}

async function mockAniListSeason(season: AnimeSeason, year: number): Promise<AniListSeasonResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const query = `query ($season: MediaSeason!, $year: Int!) {
      page1: Page(page: 1, perPage: 50) { media(type: ANIME, season: $season, seasonYear: $year, format_in: [TV, TV_SHORT, ONA], isAdult: false, sort: [POPULARITY_DESC, START_DATE]) { ...SeasonCard } }
      page2: Page(page: 2, perPage: 50) { media(type: ANIME, season: $season, seasonYear: $year, format_in: [TV, TV_SHORT, ONA], isAdult: false, sort: [POPULARITY_DESC, START_DATE]) { ...SeasonCard } }
      page3: Page(page: 3, perPage: 50) { media(type: ANIME, season: $season, seasonYear: $year, format_in: [TV, TV_SHORT, ONA], isAdult: false, sort: [POPULARITY_DESC, START_DATE]) { ...SeasonCard } }
    }
    fragment SeasonCard on Media {
      id
      title { romaji english native userPreferred }
      synonyms
      coverImage { extraLarge large color }
      season
      seasonYear
      startDate { year month day }
      endDate { year month day }
      format
      status
      episodes
      nextAiringEpisode { episode airingAt timeUntilAiring }
    }`;
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ query, variables: { season, year } })
    });
    if (!response.ok) throw new Error(`AniList returned ${response.status}.`);
    const payload = await response.json();
    const shows: AniListSeasonResponse['shows'] = ['page1', 'page2', 'page3'].flatMap(
      (page) => (Array.isArray(payload?.data?.[page]?.media) ? payload.data[page].media : [])
    );
    return { season, year, shows };
  } catch {
    const current = currentAnimeSeason();
    const shows =
      current.season === season && current.year === year
        ? Object.values(mockSubsPleaseSchedule.schedule)
            .flat()
            .filter((show): show is NonNullable<typeof show> => Boolean(show))
            .map((show, index) => ({
              id: 900_000 + index,
              title: { romaji: show.title, userPreferred: show.title },
              synonyms: [],
              description: 'Seasonal anime available through SubsPlease.',
              coverImage: { large: show.image_url },
              genres: ['Anime'],
              season,
              seasonYear: year,
              format: 'TV',
              status: 'RELEASING',
              episodes: 12,
              popularity: 1_000 - index
            }))
        : [];
    return { season, year, shows };
  } finally {
    window.clearTimeout(timeout);
  }
}

function normalizeAniListTitle(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\bs(\d+)\b/g, '$1');
}

function anilistSearchQueries(title: string): [string, string, string] {
  const exact = title.trim();
  const normalized = normalizeAniListTitle(title);
  const boundary = [...title].findIndex(
    (character, index) => index >= 4 && '.:!?–—'.includes(character)
  );
  let short = boundary >= 0 ? normalizeAniListTitle([...title].slice(0, boundary).join('')) : '';
  if (short.split(/\s+/).filter(Boolean).length < 2) {
    short = normalized.split(/\s+/).slice(0, 4).join(' ');
  }
  return [exact, normalized, short || normalized];
}

function anilistTitleSimilarity(sourceValue: string, candidateValue: string): number {
  const source = normalizeAniListTitle(sourceValue);
  const candidate = normalizeAniListTitle(candidateValue);
  if (!source || !candidate) return 0;
  const sourceCompact = source.replaceAll(' ', '');
  const candidateCompact = candidate.replaceAll(' ', '');
  if (sourceCompact === candidateCompact) return 1;

  const sourceTokens = new Set(source.split(' '));
  const candidateTokens = new Set(candidate.split(' '));
  const shared = [...sourceTokens].filter((token) => candidateTokens.has(token)).length;
  const tokenScore = (2 * shared) / (sourceTokens.size + candidateTokens.size);
  const contains = sourceCompact.includes(candidateCompact) || candidateCompact.includes(sourceCompact);
  const containmentScore = contains
    ? 0.72 + (0.2 * Math.min(sourceCompact.length, candidateCompact.length)) /
        Math.max(sourceCompact.length, candidateCompact.length)
    : 0;
  return Math.max(tokenScore, containmentScore);
}

function anilistCandidateScore(source: string, candidate: Record<string, any>): number {
  const titles = [
    candidate?.title?.romaji,
    candidate?.title?.english,
    candidate?.title?.native,
    ...(Array.isArray(candidate?.synonyms) ? candidate.synonyms : [])
  ].filter((value): value is string => typeof value === 'string' && Boolean(value));
  return titles.reduce(
    (best, title) => Math.max(best, anilistTitleSimilarity(source, title)),
    0
  );
}

async function mockAniListSearch(query: string): Promise<AniListSearchResult[]> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        query: `query ($search: String!) {
          Page(page: 1, perPage: 10) {
            media(search: $search, type: ANIME) {
              id
              title { romaji english native }
              synonyms
            }
          }
        }`,
        variables: { search: query.trim() }
      })
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload?.data?.Page?.media) ? payload.data.Page.media : [];
  } catch {
    return [];
  } finally {
    window.clearTimeout(timeout);
  }
}

let mockStartedAt = Date.now();

export async function callBackend<T>(
  name: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (isTauri()) return invoke<T>(name, args);

  await new Promise((resolve) => window.setTimeout(resolve, name === 'add_magnet' ? 650 : 80));
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
  if (name === 'add_magnet') {
    const magnet = String(args?.magnet ?? '');
    if (!magnet.startsWith('magnet:?')) throw new Error('Enter a valid magnet link.');
    mockStartedAt = Date.now();
    return { id: 7, details: mockDetails, output_folder: mockDetails.output_folder } as T;
  }
  if (name === 'stream_url') {
    return 'http://127.0.0.1:42420/torrents/7/stream/0' as T;
  }
  if (name === 'torrent_status') {
    const elapsed = (Date.now() - mockStartedAt) / 1000;
    const progress = Math.min(1_294_727_168, 92_000_000 + elapsed * 3_800_000);
    return {
      state: 'live',
      file_progress: [progress, 0],
      progress_bytes: progress,
      uploaded_bytes: elapsed * 210_000,
      total_bytes: 1_294_727_168,
      finished: false,
      pieces: Array.from({ length: 1236 }, (_, index) =>
        index < 105 || (index >= 420 && index < 455)
      ),
      live: {
        download_speed: { mbps: 3.8, human_readable: '3.80 MiB/s' },
        upload_speed: { mbps: 0.21, human_readable: '0.21 MiB/s' },
        snapshot: { peer_stats: { live: 18, seen: 42, connecting: 3 } }
      }
    } as T;
  }
  if (name === 'subsplease_schedule') return mockSubsPleaseSchedule as T;
  if (name === 'subsplease_index') return mockSubsPleaseIndex as T;
  if (name === 'anilist_season') {
    return (await mockAniListSeason(
      String(args?.season ?? 'SUMMER').toUpperCase() as AnimeSeason,
      Number(args?.year ?? new Date().getFullYear())
    )) as T;
  }
  if (name === 'anilist_search') {
    return (await mockAniListSearch(String(args?.query ?? ''))) as T;
  }
  if (name === 'subsplease_show') {
    return (await enrichMockShow(
      mockSubsPleaseShow(
        String(args?.slug ?? ''),
        typeof args?.anilistId === 'number' ? args.anilistId : undefined
      )
    )) as T;
  }
  return undefined as T;
}
