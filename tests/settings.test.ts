import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeCatalogProviderOrder,
  normalizeMyAnimeListClientId,
  normalizeRoomDisplayName,
  saveSettings
} from '../src/lib/settings.ts';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

test('catalog provider order normalizes legacy and malformed settings without losing existing preferences', () => {
  assert.deepEqual(normalizeCatalogProviderOrder(undefined), ['anilist', 'myanimelist', 'jikan', 'kitsu']);
  assert.deepEqual(
    normalizeCatalogProviderOrder(['kitsu', 'kitsu', 'unknown', 'anilist']),
    ['kitsu', 'anilist', 'myanimelist', 'jikan']
  );

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

    saveSettings({ catalogProviderOrder: ['kitsu', 'anilist', 'myanimelist', 'jikan'] });
    assert.deepEqual(loadSettings(), {
      preferredQuality: '720',
      preferredSubtitleLanguage: 'nl',
      catalogProviderOrder: ['kitsu', 'anilist', 'myanimelist', 'jikan']
    });
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  }
});

test('the room display name is cleaned on save and dropped when empty or malformed', () => {
  assert.equal(normalizeRoomDisplayName('  Sem\u0007   V  '), 'Sem V');
  assert.equal(normalizeRoomDisplayName('x'.repeat(40)), 'x'.repeat(24));
  for (const value of ['', '   ', 7, null, undefined]) assert.equal(normalizeRoomDisplayName(value), undefined);

  const storage = new MemoryStorage();
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  try {
    storage.setItem('streamsplease.settings.v1', JSON.stringify({ roomDisplayName: ['Sem'] }));
    assert.equal(loadSettings().roomDisplayName, undefined);
    saveSettings({ roomDisplayName: '  Sem  ' });
    assert.equal(loadSettings().roomDisplayName, 'Sem');
    saveSettings({ roomDisplayName: '' });
    assert.equal('roomDisplayName' in loadSettings(), false);
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  }
});

test('MyAnimeList client IDs retain only the supported public identifier format', () => {
  assert.equal(normalizeMyAnimeListClientId('  Client_ID-42  '), 'Client_ID-42');
  for (const value of ['', 'short', 'contains space', 'é1234567', 'a'.repeat(129)]) {
    assert.equal(normalizeMyAnimeListClientId(value), undefined);
  }

  const storage = new MemoryStorage();
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  try {
    storage.setItem('streamsplease.settings.v1', JSON.stringify({ myAnimeListClientId: ' invalid id ' }));
    assert.equal(loadSettings().myAnimeListClientId, undefined);
    saveSettings({ myAnimeListClientId: '  Client_ID-42  ' });
    assert.equal(loadSettings().myAnimeListClientId, 'Client_ID-42');
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  }
});
