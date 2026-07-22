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
export type AppView = 'player' | 'library' | 'discovery' | 'subsplease' | 'account';
export type PlaybackQuality = '480' | '720' | '1080';
export type DiscoveryVerdict = 'love' | 'maybe' | 'pass';

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

export interface TrailerPlaybackRequest {
  url: string;
  title: string;
  thumbnail?: string;
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
}

export interface SubsPleaseScheduleResponse {
  tz: string;
  schedule: Partial<Record<DayName, SubsPleaseScheduleShow[]>>;
}

export interface AniListSearchResult {
  id: number;
  title: {
    romaji?: string;
    english?: string;
    native?: string;
  };
  synonyms?: string[];
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
  episode: Record<string, SubsPleaseRelease>;
  batch: Record<string, SubsPleaseRelease>;
  trailer?: {
    id: string;
    site: string;
    thumbnail?: string;
  };
  genres?: string[];
  year?: number;
  format?: string;
  status?: string;
  episode_count?: number;
  metadata_source?: string;
  metadata_url?: string;
  metadata_id?: number;
  has_series_prequel?: boolean;
}

export interface LibraryEntry {
  slug: string;
  title: string;
  imageUrl: string;
  bannerImageUrl?: string;
  synopsis?: string;
  genres?: string[];
  year?: number;
  trailer?: SubsPleaseShowResponse['trailer'];
  metadataId?: number;
  following: boolean;
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

export interface EpisodePlaybackRequest {
  slug: string;
  title: string;
  imageUrl: string;
  episode: string;
  magnet: string;
  quality: string;
  day?: DayName;
  airingTime?: string;
}
