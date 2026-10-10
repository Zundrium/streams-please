import type { Channel } from '@tauri-apps/api/core';
import type { CatalogRequest } from '$lib/catalog/providers';
import type {
  AddTorrentResponse,
  RuntimeInfo,
  SeedingOverview,
  SubsPleaseScheduleResponse,
  SubsPleaseShowResponse,
  TorrentStats,
  TransferSpeeds,
  UpdateCheckResult,
  UpdateDownloadEvent
} from '$lib/types';

type Command<Args, Result> = { args: Args; result: Result };
type NoArgs = Record<string, never>;

export type BackendCommands = {
  runtime_info: Command<NoArgs, RuntimeInfo>;
  check_for_update: Command<NoArgs, UpdateCheckResult>;
  install_update: Command<{ onEvent: Channel<UpdateDownloadEvent> }, void>;
  add_magnet: Command<{ magnet: string }, AddTorrentResponse>;
  torrent_status: Command<{ id: number }, TorrentStats>;
  stream_url: Command<{ id: number; fileId: number }, string>;
  release_torrent: Command<{ id: number }, void>;
  transfer_speeds: Command<NoArgs, TransferSpeeds>;
  remove_torrent: Command<{ infoHash: string }, void>;
  seeding_overview: Command<NoArgs, SeedingOverview>;
  set_seeding_target_ratio: Command<{ ratio: number }, SeedingOverview>;
  set_seeding_upload_limit: Command<{ bytesPerSecond: number | null }, SeedingOverview>;
  export_library_file: Command<{ contents: string }, boolean>;
  import_library_file: Command<NoArgs, string | null>;
  catalog_providers: Command<NoArgs, unknown>;
  catalog_request: Command<
    { provider: string; request: CatalogRequest; myAnimeListClientId?: string },
    unknown
  >;
  subsplease_schedule: Command<{ timezone: string }, SubsPleaseScheduleResponse>;
  subsplease_index: Command<NoArgs, unknown>;
  subsplease_show: Command<
    { slug: string; timezone: string; anilistId?: number; includeMetadata?: boolean },
    SubsPleaseShowResponse
  >;
};

export type BackendCommand = keyof BackendCommands;
export type BackendArgs<K extends BackendCommand> = BackendCommands[K]['args'];
export type BackendResult<K extends BackendCommand> = BackendCommands[K]['result'];
export type BackendArgsTuple<K extends BackendCommand> =
  BackendArgs<K> extends NoArgs ? [args?: NoArgs] : [args: BackendArgs<K>];

export type BackendCall = <K extends BackendCommand>(
  name: K,
  ...args: BackendArgsTuple<K>
) => Promise<BackendResult<K>>;
