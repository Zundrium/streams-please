import type { PlaybackQuality } from '$lib/types';

const STORAGE_KEY = 'yoru-stream.settings.v1';

export interface AppSettings {
  preferredQuality: PlaybackQuality;
}

export const DEFAULT_SETTINGS: AppSettings = {
  preferredQuality: '1080'
};

export function loadSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<AppSettings>;
    const preferredQuality = value.preferredQuality;
    return {
      preferredQuality:
        preferredQuality === '480' || preferredQuality === '720' || preferredQuality === '1080'
          ? preferredQuality
          : DEFAULT_SETTINGS.preferredQuality
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
