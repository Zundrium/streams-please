import type { PlaybackQuality, SubtitleLanguage } from '$lib/types';

const STORAGE_KEY = 'yoru-stream.settings.v1';

export interface AppSettings {
  preferredQuality: PlaybackQuality;
  preferredSubtitleLanguage: SubtitleLanguage;
}

export const DEFAULT_SETTINGS: AppSettings = {
  preferredQuality: '1080',
  preferredSubtitleLanguage: 'en'
};

export function loadSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<AppSettings>;
    const preferredQuality = value.preferredQuality;
    const preferredSubtitleLanguage = value.preferredSubtitleLanguage;
    return {
      preferredQuality:
        preferredQuality === '480' || preferredQuality === '720' || preferredQuality === '1080'
          ? preferredQuality
          : DEFAULT_SETTINGS.preferredQuality,
      preferredSubtitleLanguage:
        preferredSubtitleLanguage === 'en' ||
        preferredSubtitleLanguage === 'ja' ||
        preferredSubtitleLanguage === 'nl'
          ? preferredSubtitleLanguage
          : DEFAULT_SETTINGS.preferredSubtitleLanguage
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
