export const DAY_ORDER = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday'
] as const;

export type DayName = (typeof DAY_ORDER)[number];
export type Phase = 'idle' | 'connecting' | 'buffering' | 'ready' | 'error';
export type AppView = 'player' | 'library' | 'search' | 'discovery' | 'subsplease' | 'account';
export type PlaybackQuality = '480' | '720' | '1080';
export type SubtitleLanguage = 'en' | 'ja' | 'nl';
export type DiscoveryVerdict = 'love' | 'maybe' | 'pass';
export type AnimeSeason = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

export interface RuntimeInfo {
  engine: string;
  engineVersion: string;
  streamPort: number;
  downloadDir: string;
  mpvAvailable: boolean;
  mpvVersion?: string;
  trailerAvailable: boolean;
  trailerRuntimeVersion?: string;
}

export type UpdateCheckResult =
  | { status: 'notConfigured' }
  | { status: 'upToDate' }
  | {
      status: 'available';
      version: string;
      currentVersion: string;
      notes?: string;
    };

export type UpdateDownloadEvent =
  | { event: 'started'; data: { contentLength?: number } }
  | { event: 'progress'; data: { chunkLength: number } }
  | { event: 'finished' };

export type AppUpdateStatus =
  | {
      phase: 'downloading';
      version: string;
      downloadedBytes: number;
      totalBytes?: number;
    }
  | { phase: 'error'; message: string };

export interface TrailerPlaybackRequest {
  url: string;
  title: string;
  thumbnail?: string;
  viewport?: HTMLElement;
}

export interface TorrentFile {
  name: string;
  components: string[];
  length: number;
  included: boolean;
}

export interface TorrentDetails {
  id?: number;
  info_hash: string;
  name?: string;
  output_folder: string;
  files?: TorrentFile[];
}

export interface AddTorrentResponse {
  id?: number;
  details: TorrentDetails;
  output_folder: string;
}

export interface TorrentStats {
  state: 'initializing' | 'live' | 'paused' | 'error';
  file_progress: number[];
  progress_bytes: number;
  uploaded_bytes: number;
  total_bytes: number;
  finished: boolean;
  pieces?: boolean[];
  error?: string;
  live?: {
    download_speed: { mbps: number; human_readable?: string };
    upload_speed: { mbps: number; human_readable?: string };
    snapshot: { peer_stats: { live: number; seen: number; connecting: number } };
  };
}

export interface CurrentTorrent {
  id: number;
  details: TorrentDetails;
  video: TorrentFile;
  fileId: number;
}

export interface MpvTrack {
  id: number;
  type: 'video' | 'audio' | 'sub';
  lang?: string;
  title?: string;
  codec?: string;
  selected?: boolean;
  external?: boolean;
}

export interface PlaybackState {
  paused: boolean;
  time: number;
  duration: number;
  volume: number;
  muted: boolean;
  speed: number;
  mediaTitle?: string;
}

export interface SubsPleaseScheduleShow {
  title: string;
  page: string;
  image_url: string;
  time: string;
  anilist_id?: number;
  subsplease_id?: number;
}

export interface SubsPleaseScheduleResponse {
  tz: string;
  schedule: Partial<Record<DayName, SubsPleaseScheduleShow[]>>;
}

export interface AniListDate {
  year?: number;
  month?: number;
  day?: number;
}

export interface AniListMediaTitle {
  romaji?: string;
  english?: string;
  native?: string;
  userPreferred?: string;
}

export interface AniListStreamingEpisode {
  title?: string;
  thumbnail?: string;
  site?: string;
}

export interface AniListAiringEpisode {
  episode: number;
  airingAt: number;
  timeUntilAiring?: number;
}

export interface AniListMediaTag {
  id: number;
  name: string;
  rank?: number;
  isGeneralSpoiler?: boolean;
  isMediaSpoiler?: boolean;
}

export interface AniListStudio {
  id: number;
  name: string;
  isAnimationStudio?: boolean;
  siteUrl?: string;
}

export interface AniListMatchableMedia {
  id: number;
  title: AniListMediaTitle;
  synonyms?: string[];
}

export interface CatalogMedia extends AniListMatchableMedia {
  idMal?: number;
  coverImage?: {
    extraLarge?: string;
    large?: string;
    color?: string;
  };
  season?: AnimeSeason;
  seasonYear?: number;
  format?: string;
  status?: string;
  episodes?: number;
}

export type AniListSearchResult = CatalogMedia;

export interface AniListRelationNode extends AniListMatchableMedia {
  type?: string;
  format?: string;
  status?: string;
  season?: AnimeSeason;
  seasonYear?: number;
  coverImage?: {
    extraLarge?: string;
    large?: string;
    color?: string;
  };
  siteUrl?: string;
}

export interface AniListRelationEdge {
  relationType?: string;
  node?: AniListRelationNode;
}

export interface CatalogSeasonMedia extends CatalogMedia {
  idMal?: number;
  description?: string;
  trailer?: {
    id: string;
    site: string;
    thumbnail?: string;
  };
  coverImage?: {
    extraLarge?: string;
    large?: string;
    color?: string;
  };
  bannerImage?: string;
  genres?: string[];
  season: AnimeSeason;
  seasonYear: number;
  startDate?: AniListDate;
  endDate?: AniListDate;
  format?: string;
  status?: string;
  episodes?: number;
  duration?: number;
  averageScore?: number;
  popularity?: number;
  siteUrl?: string;
  nextAiringEpisode?: {
    episode: number;
    airingAt: number;
    timeUntilAiring: number;
  };
  relations?: {
    edges?: AniListRelationEdge[];
  };
}

export type AniListSeasonShow = CatalogSeasonMedia;

export interface CatalogSeasonResponse {
  provenance?: import('$lib/catalog/providers').CatalogProvenance;
  cacheWarning?: string;
  season: AnimeSeason;
  year: number;
  shows: AniListSeasonShow[];
}

export type AniListSeasonResponse = CatalogSeasonResponse;

export interface SubsPleaseIndexShow {
  title: string;
  page: string;
}

export interface SubsPleaseIndexResponse {
  cacheWarning?: string;
  shows: SubsPleaseIndexShow[];
}

export interface SubsPleaseDownload {
  res: string;
  torrent: string;
  magnet: string;
  xdcc?: string;
}

export interface SubsPleaseRelease {
  time: string;
  release_date: string;
  show: string;
  episode: string;
  downloads: SubsPleaseDownload[];
}

export interface SubsPleaseShowResponse {
  title: string;
  synopsis: string;
  image_url: string;
  banner_image_url?: string;
  slug: string;
  subsplease_id?: number;
  episode: Record<string, SubsPleaseRelease>;
  batch: Record<string, SubsPleaseRelease>;
  trailer?: {
    id: string;
    site: string;
    thumbnail?: string;
  };
  genres?: string[];
  year?: number;
  season?: AnimeSeason;
  start_date?: AniListDate;
  end_date?: AniListDate;
  format?: string;
  status?: string;
  episode_count?: number;
  duration?: number;
  average_score?: number;
  popularity?: number;
  source?: string;
  country_of_origin?: string;
  tags?: AniListMediaTag[];
  studios?: {
    nodes?: AniListStudio[];
  };
  next_airing_episode?: AniListAiringEpisode;
  streaming_episodes?: AniListStreamingEpisode[];
  metadata_source?: string;
  metadata_url?: string;
  metadata_id?: number;
  has_series_prequel?: boolean;
  relations?: {
    edges?: AniListRelationEdge[];
  };
}

export interface LibraryEntry {
  anilistId?: number;
  slug: string;
  subspleaseId?: number;
  title: string;
  imageUrl: string;
  bannerImageUrl?: string;
  synopsis?: string;
  genres?: string[];
  year?: number;
  trailer?: SubsPleaseShowResponse['trailer'];
  metadataId?: number;
  following: boolean;
  libraryDismissed?: boolean;
  discoveryVerdict?: DiscoveryVerdict;
  checkedAt?: string;
  day?: DayName;
  airingTime?: string;
  episodeCount?: number;
  availableEpisodes: string[];
  watchedEpisodes: string[];
  addedAt: string;
  updatedAt: string;
}

export interface LibraryBackupEntry {
  anilistId?: number;
  subspleaseId?: number;
  slug: string;
  following: boolean;
  libraryDismissed?: boolean;
  discoveryVerdict?: DiscoveryVerdict;
  checkedAt?: string;
  watchedEpisodes: string[];
  addedAt: string;
  updatedAt: string;
}

export interface EpisodePlaybackRequest {
  anilistId?: number;
  slug: string;
  title: string;
  imageUrl: string;
  episode: string;
  magnet: string;
  quality: string;
  day?: DayName;
  airingTime?: string;
}
