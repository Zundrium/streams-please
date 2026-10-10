import type { MpvConfig, MpvObservableProperty } from 'tauri-plugin-libmpv-api';
import type { SubtitleLanguage } from '$lib/types';

export const MPV_WINDOW_LABEL = 'main';

export const OBSERVED_PROPERTIES = [
  ['pause', 'flag'],
  ['time-pos', 'double', 'none'],
  ['duration', 'double', 'none'],
  ['volume', 'double'],
  ['mute', 'flag'],
  ['speed', 'double'],
  ['track-list', 'node'],
  ['media-title', 'string', 'none'],
  ['path', 'string', 'none'],
  ['paused-for-cache', 'flag']
] as const satisfies readonly MpvObservableProperty[];

export type ObservedProperty = (typeof OBSERVED_PROPERTIES)[number];

export const TRAILER_LOAD_OPTIONS = 'pause=no,start=0,speed=1,vid=auto,aid=auto,sid=no,secondary-sid=no';

export function subtitleLanguagePreference(language: SubtitleLanguage): string {
  return language === 'en' ? 'en' : `${language},en`;
}

export function mpvInitialOptions(
  subtitleLanguage: SubtitleLanguage
): NonNullable<MpvConfig['initialOptions']> {
  return {
    vo: 'gpu-next',
    hwdec: 'auto-safe',
    'keep-open': 'yes',
    idle: 'yes',
    'force-window': 'yes',
    osc: 'no',
    'input-default-bindings': 'no',
    ytdl: 'yes',
    'ytdl-format': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    'ytdl-raw-options': 'sub-langs=none',
    cache: 'yes',
    'cache-pause': 'yes',
    'cache-pause-initial': 'yes',
    'cache-pause-wait': 3,
    'cache-secs': 180,
    'demuxer-max-bytes': '512MiB',
    'demuxer-max-back-bytes': '192MiB',
    'demuxer-readahead-secs': 180,
    'demuxer-seekable-cache': 'yes',
    'demuxer-cache-wait': 'yes',
    'sub-auto': 'all',
    slang: subtitleLanguagePreference(subtitleLanguage),
    alang: 'jpn,eng,nld'
  };
}
