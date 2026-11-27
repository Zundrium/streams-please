import { cleanDisplayName } from '$lib/room/protocol';
import type { PlaybackQuality, SubtitleLanguage } from '$lib/types';

const STORAGE_KEY = 'streamsplease.settings.v1';

export const CATALOG_PROVIDERS = [
  { id: 'anilist', label: 'AniList' },
  { id: 'myanimelist', label: 'MyAnimeList (official)' },
  { id: 'jikan', label: 'MyAnimeList (Jikan)' },
  { id: 'kitsu', label: 'Kitsu' }
] as const;

export type CatalogProviderId = (typeof CATALOG_PROVIDERS)[number]['id'];

export interface AppSettings {
  preferredQuality: PlaybackQuality;
  preferredSubtitleLanguage: SubtitleLanguage;
  catalogProviderOrder: CatalogProviderId[];
  myAnimeListClientId?: string;
  roomDisplayName?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  preferredQuality: '1080',
  preferredSubtitleLanguage: 'en',
  catalogProviderOrder: CATALOG_PROVIDERS.map((provider) => provider.id)
};

export function normalizeMyAnimeListClientId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clientId = value.trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(clientId) ? clientId : undefined;
}

export function normalizeRoomDisplayName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? cleanDisplayName(value) : undefined;
}

export function normalizeCatalogProviderOrder(value: unknown): CatalogProviderId[] {
  const known = new Set<string>(CATALOG_PROVIDERS.map((provider) => provider.id));
  const selected = Array.isArray(value)
    ? value.filter((provider): provider is CatalogProviderId =>
      typeof provider === 'string' && known.has(provider))
    : [];
  return [...new Set(selected), ...DEFAULT_SETTINGS.catalogProviderOrder.filter((provider) => !selected.includes(provider))];
}

function normalizeSettings(value: unknown): AppSettings {
  const settings = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<AppSettings>
    : {};
  const preferredQuality = settings.preferredQuality;
  const preferredSubtitleLanguage = settings.preferredSubtitleLanguage;
  const myAnimeListClientId = normalizeMyAnimeListClientId(settings.myAnimeListClientId);
  const roomDisplayName = normalizeRoomDisplayName(settings.roomDisplayName);
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
        : DEFAULT_SETTINGS.preferredSubtitleLanguage,
    catalogProviderOrder: normalizeCatalogProviderOrder(settings.catalogProviderOrder),
    ...(myAnimeListClientId ? { myAnimeListClientId } : {}),
    ...(roomDisplayName ? { roomDisplayName } : {})
  };
}

export function loadSettings(): AppSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS, catalogProviderOrder: [...DEFAULT_SETTINGS.catalogProviderOrder] };
  try {
    return normalizeSettings(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}'));
  } catch {
    return { ...DEFAULT_SETTINGS, catalogProviderOrder: [...DEFAULT_SETTINGS.catalogProviderOrder] };
  }
}

export function saveSettings(settings: Partial<AppSettings>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSettings({ ...loadSettings(), ...settings })));
  } catch {
    return;
  }
}
