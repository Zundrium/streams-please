import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogClient } from '../src/lib/catalog/client.ts';
import type { BackendCall } from '../src/lib/backend.ts';
import type { AniListSeasonResponse, SubsPleaseIndexResponse } from '../src/lib/types.ts';

class MemoryStorage {
  readonly values = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes += 1;
    this.values.set(key, value);
  }
}

const indexResponse: SubsPleaseIndexResponse = { shows: [{ title: 'Preview', page: 'preview' }] };
const seasonResponse: AniListSeasonResponse = {
  season: 'SUMMER',
  year: 2026,
  shows: [{ id: 1, title: { romaji: 'Preview' }, season: 'SUMMER', seasonYear: 2026 }]
};

test('catalog client shares inflight searches and evicts rejected requests', async () => {
  let calls = 0;
  let fail = false;
  const client = createCatalogClient(async <T>(name: string): Promise<T> => {
    assert.equal(name, 'anilist_search');
    calls += 1;
    if (fail) throw new Error('unavailable');
    return [] as T;
  }, { cacheScope: 'preview' });

  assert.equal(client.loadSearch(' Preview '), client.loadSearch('preview'));
  await client.loadSearch('preview');
  assert.equal(calls, 1);

  fail = true;
  await assert.rejects(client.loadSearch('different'));
  fail = false;
  await client.loadSearch('different');
  assert.equal(calls, 3);
});

test('catalog client persists a shared network response only once', async () => {
  const storage = new MemoryStorage();
  const client = createCatalogClient(async <T>(): Promise<T> => indexResponse as T, {
    cacheScope: 'preview',
    storage,
    now: () => Date.UTC(2026, 6, 1)
  });

  await Promise.all([client.loadIndex(), client.loadIndex()]);
  assert.equal(storage.writes, 1);
});

test('catalog client reloads expired data and returns an actionable stale warning without re-aging it', async () => {
  const storage = new MemoryStorage();
  const now = Date.UTC(2026, 6, 1);
  storage.values.set(
    'streamsplease.provider-index.v1.preview',
    JSON.stringify({ savedAt: now - 2 * 24 * 60 * 60 * 1000, data: indexResponse })
  );
  let calls = 0;
  const reloadClient = createCatalogClient(async <T>(): Promise<T> => {
    calls += 1;
    return indexResponse as T;
  }, { cacheScope: 'preview', storage, now: () => now });

  await reloadClient.loadIndex();
  assert.equal(calls, 1);

  const staleStorage = new MemoryStorage();
  const staleValue = JSON.stringify({ savedAt: now - 2 * 24 * 60 * 60 * 1000, data: indexResponse });
  staleStorage.values.set('streamsplease.provider-index.v1.preview', staleValue);
  const staleClient = createCatalogClient(async <T>(): Promise<T> => {
    throw new Error('service offline');
  }, { cacheScope: 'preview', storage: staleStorage, now: () => now });

  const stale = await staleClient.loadIndex();
  assert.match(stale.cacheWarning ?? '', /service offline/);
  assert.equal(staleStorage.values.get('streamsplease.provider-index.v1.preview'), staleValue);
});

test('catalog client does not use season fallback older than ninety days', async () => {
  const storage = new MemoryStorage();
  const now = Date.UTC(2026, 9, 1);
  storage.values.set(
    'streamsplease.season-cache.v1.preview',
    JSON.stringify({
      entries: {
        'SUMMER:2026': { savedAt: now - 91 * 24 * 60 * 60 * 1000, data: seasonResponse }
      }
    })
  );
  const client = createCatalogClient(async <T>(): Promise<T> => {
    throw new Error('service offline');
  }, { cacheScope: 'preview', storage, now: () => now });

  await assert.rejects(client.loadSeason('SUMMER', 2026), /service offline/);
});

test('catalog client separates provider-only and metadata show requests', async () => {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const client = createCatalogClient(async <T>(
    _name: string,
    args?: Record<string, unknown>
  ): Promise<T> => {
    calls.push(args);
    return { slug: 'preview', title: 'Preview', synopsis: '', image_url: '', episode: {}, batch: {} } as T;
  }, { cacheScope: 'preview' });

  await Promise.all([
    client.loadShow('preview', 'Europe/Amsterdam', 7, false),
    client.loadShow('preview', 'Europe/Amsterdam', 7, true)
  ]);

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.includeMetadata, false);
  assert.equal(calls[1]?.includeMetadata, true);
});

test('catalog client limits concurrent catalog calls and releases synchronous failures', async () => {
  let active = 0;
  let highest = 0;
  const call: BackendCall = <T>(name: string): Promise<T> => {
    if (name === 'anilist_search') throw new Error('synchronous failure');
    active += 1;
    highest = Math.max(highest, active);
    return new Promise<T>((resolve) => {
      setTimeout(() => {
        active -= 1;
        resolve({ tz: 'UTC', schedule: {} } as T);
      }, 5);
    });
  };
  const client = createCatalogClient(call, { cacheScope: 'preview', maxConcurrentRequests: 1 });

  const rejected = client.loadSearch('preview');
  const scheduled = client.loadSchedule('UTC');
  await assert.rejects(rejected, /synchronous failure/);
  await scheduled;
  assert.equal(highest, 1);
});
