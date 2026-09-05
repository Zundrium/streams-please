import type {
  DayName, DiscoveryVerdict, EpisodePlaybackRequest, LibraryEntry, PlaybackQuality,
  SubsPleaseScheduleShow, SubsPleaseShowResponse, TrailerPlaybackRequest
} from '$lib/types';

export interface CatalogDetailsActions {
  loadShow: (slug: string, timezone: string, anilistId?: number, includeMetadata?: boolean) => Promise<SubsPleaseShowResponse>;
  onPlay: (request: EpisodePlaybackRequest) => Promise<void>;
  onPlayTrailer: (request: TrailerPlaybackRequest) => void | Promise<void>;
  libraryEntries: LibraryEntry[];
  onToggleLibrary: (details: SubsPleaseShowResponse, show: SubsPleaseScheduleShow, day?: DayName) => void;
  onSetDiscoveryVerdict: (details: SubsPleaseShowResponse, show: SubsPleaseScheduleShow, day: DayName | undefined, verdict?: DiscoveryVerdict) => void;
  onToggleWatched: (slug: string, episode: string) => void;
  onShowLoaded: (details: SubsPleaseShowResponse, show: SubsPleaseScheduleShow, day?: DayName) => void;
  preferredQuality: PlaybackQuality;
  openSlug?: string;
  onOpenConsumed?: () => void;
}
