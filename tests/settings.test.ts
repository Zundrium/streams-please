import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeCatalogProviderOrder,
  saveSettings
} from '../src/lib/settings.ts';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

test('catalog provider order normalizes legacy and malformed settings without losing existing preferences', () => {
  assert.deepEqual(normalizeCatalogProviderOrder(undefined), ['anilist', 'jikan', 'kitsu']);
  assert.deepEqual(normalizeCatalogProviderOrder(['kitsu', 'kitsu', 'unknown', 'anilist']), ['kitsu', 'anilist', 'jikan']);

  const storage = new MemoryStorage();
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage }
  });
  try {
    storage.setItem('streamsplease.settings.v1', JSON.stringify({
      preferredQuality: '720',
      preferredSubtitleLanguage: 'nl'
    }));
    assert.deepEqual(loadSettings(), {
      preferredQuality: '720',
      preferredSubtitleLanguage: 'nl',
      catalogProviderOrder: DEFAULT_SETTINGS.catalogProviderOrder
    });

    saveSettings({ catalogProviderOrder: ['kitsu', 'anilist', 'jikan'] });
    assert.deepEqual(loadSettings(), {
      preferredQuality: '720',
      preferredSubtitleLanguage: 'nl',
      catalogProviderOrder: ['kitsu', 'anilist', 'jikan']
    });
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  }
});
