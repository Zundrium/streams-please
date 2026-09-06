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

const providers = [{ id: 'anilist', label: 'AniList', capabilities: ['search', 'season'] }];
const indexResponse: SubsPleaseIndexResponse = { shows: [{ title: 'Preview', page: 'preview' }] };
const seasonResponse: AniListSeasonResponse = {
  season: 'SUMMER',
  year: 2026,
  shows: [{ id: 1, title: { romaji: 'Preview' }, season: 'SUMMER', seasonYear: 2026 }]
};

test('catalog client shares inflight searches and evicts rejected requests', async () => {
  let calls = 0;
  let fail = false;
  let now = Date.UTC(2026, 6, 1);
  const client = createCatalogClient(async <T>(name: string): Promise<T> => {
    if (name === 'catalog_providers') return providers as T;
    assert.equal(name, 'catalog_request');
    calls += 1;
    if (fail) throw new Error('unavailable');
    return { provider: 'anilist', items: [], warnings: [] } as T;
  }, { cacheScope: 'preview', now: () => now });

  assert.equal(client.loadSearch(' Preview '), client.loadSearch('preview'));
  await client.loadSearch('preview');
  assert.equal(calls, 1);

  fail = true;
  await assert.rejects(client.loadSearch('different'));
  fail = false;
  now += 60_001;
  await client.loadSearch('different');
  assert.equal(calls, 3);
});

test('catalog client reads the current provider order for each new catalog request', async () => {
  const registry = [
    { id: 'anilist', label: 'AniList', capabilities: ['search'] },
    { id: 'jikan', label: 'Jikan', capabilities: ['search'] },
    { id: 'kitsu', label: 'Kitsu', capabilities: ['search'] }
  ];
  let order = ['anilist', 'jikan', 'kitsu'];
  const calls: string[] = [];
  const client = createCatalogClient(async <T>(name: string, args?: Record<string, unknown>): Promise<T> => {
    if (name === 'catalog_providers') return registry as T;
    assert.equal(name, 'catalog_request');
    const provider = String(args?.provider);
    calls.push(provider);
    return { provider, items: [], warnings: [] } as T;
  }, { cacheScope: 'preview', providerOrder: () => order });

  await client.loadSearch('first');
  order = ['kitsu', 'jikan', 'anilist'];
  await client.loadSearch('second');
  assert.deepEqual(calls, ['anilist', 'kitsu']);
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

test('catalog client normalizes recommendation seeds for cache keys and requests', async () => {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const client = createCatalogClient(async <T>(name: string, args?: Record<string, unknown>): Promise<T> => {
    if (name === 'catalog_providers') {
      return [{ id: 'anilist', label: 'AniList', capabilities: ['recommendations'] }] as T;
    }
    calls.push(args);
    return {
      provider: 'anilist',
      items: [{ id: 7, title: { romaji: 'Recommendation' }, season: 'SUMMER', seasonYear: 2026 }],
      warnings: []
    } as T;
  }, { cacheScope: 'preview' });

  const first = client.loadRecommendations([7, 3, 7]);
  assert.equal(first, client.loadRecommendations([3, 7]));
  const response = await first;
  assert.equal(response.results[0]?.season, 'SUMMER');
  assert.deepEqual(calls[0]?.request, { kind: 'recommendations', ids: [3, 7] });
  assert.equal('myAnimeListClientId' in (calls[0] ?? {}), false);
});

test('catalog client rejects invalid recommendation seeds without contacting providers', async () => {
  let calls = 0;
  const client = createCatalogClient(async <T>(): Promise<T> => {
    calls += 1;
    return [] as T;
  }, { cacheScope: 'preview' });

  for (const ids of [[], [0], [1.5], Array.from({ length: 11 }, (_, index) => index + 1)]) {
    await assert.rejects(client.loadRecommendations(ids), /Invalid recommendation seeds/);
  }
  assert.equal(calls, 0);
});

test('catalog client skips unconfigured official MyAnimeList and sends its ID only to official requests', async () => {
  let myAnimeListClientId: string | undefined;
  const calls: Array<Record<string, unknown> | undefined> = [];
  const client = createCatalogClient(async <T>(name: string, args?: Record<string, unknown>): Promise<T> => {
    if (name === 'catalog_providers') {
      return [
        { id: 'myanimelist', label: 'MyAnimeList', capabilities: ['search'] },
        { id: 'jikan', label: 'MyAnimeList (Jikan)', capabilities: ['search'] }
      ] as T;
    }
    calls.push(args);
    const provider = String(args?.provider);
    return { provider, items: [], warnings: [] } as T;
  }, {
    cacheScope: 'preview',
    providerOrder: () => ['myanimelist', 'jikan'],
    myAnimeListClientId: () => myAnimeListClientId
  });

  await client.loadSearch('without id');
  assert.equal(calls[0]?.provider, 'jikan');
  assert.equal('myAnimeListClientId' in (calls[0] ?? {}), false);

  myAnimeListClientId = 'Client_ID-42';
  await client.loadSearch('with id');
  assert.equal(calls[1]?.provider, 'myanimelist');
  assert.equal(calls[1]?.myAnimeListClientId, 'Client_ID-42');
});

test('catalog client limits concurrent catalog calls and releases synchronous failures', async () => {
  let active = 0;
  let highest = 0;
  const call: BackendCall = <T>(name: string): Promise<T> => {
    if (name === 'catalog_providers') return Promise.resolve(providers as T);
    if (name === 'catalog_request') throw new Error('synchronous failure');
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
