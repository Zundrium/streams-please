import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogCoordinator } from '../src/lib/catalog/coordinator.ts';
import { createCatalogResultCache } from '../src/lib/catalog/result-cache.ts';
import { normalizeCatalogProviders, normalizeCatalogResponse, catalogSourceLabel } from '../src/lib/catalog/providers.ts';
import { callPreviewBackend } from '../src/lib/backend/preview.ts';
import type { BackendCall } from '../src/lib/backend.ts';
import type { CatalogProvider, CatalogProviderResponse, CatalogRequest } from '../src/lib/catalog/providers.ts';
import type { CatalogMedia } from '../src/lib/types.ts';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const providers: CatalogProvider[] = [
  { id: 'anilist', label: 'AniList', capabilities: ['search', 'season'] },
  { id: 'jikan', label: 'Jikan', capabilities: ['search', 'season'] }
];
const request: CatalogRequest = { kind: 'search', query: 'Example' };
const seasonRequest: CatalogRequest = { kind: 'season', season: 'SUMMER', year: 2026 };
const items: CatalogMedia[] = [{ id: 42, idMal: 84, title: { romaji: 'Example' }, season: 'SUMMER', seasonYear: 2026 }];
const response = (provider = 'anilist', season = false): CatalogProviderResponse => ({
  provider, items, warnings: [], ...(season ? { season: 'SUMMER', year: 2026 } : {})
});
const initialTime = Date.UTC(2026, 6, 1);

function backend(
  handler: (provider: string, request: CatalogRequest) => unknown,
  registry = providers
): BackendCall {
  return async <T>(name: string, args?: Record<string, unknown>): Promise<T> => {
    if (name === 'catalog_providers') return registry as T;
    assert.equal(name, 'catalog_request');
    return await handler(String(args?.provider), args?.request as CatalogRequest) as T;
  };
}

test('coordinator shares requests and uses healthy primary including a genuine empty result', async () => {
  const calls: string[] = [];
  const client = createCatalogCoordinator(backend((provider) => {
    calls.push(provider);
    return { ...response(provider), items: [] };
  }));
  const first = client.load(request);
  assert.equal(first, client.load({ kind: 'search', query: ' example ' }));
  assert.equal((await first).data.items.length, 0);
  assert.equal((await client.load(request)).provenance.cache, 'fresh');
  assert.deepEqual(calls, ['anilist']);
});

test('saved primary results precede alternative providers and retain their original age after restart', async () => {
  const storage = new MemoryStorage();
  let now = initialTime;
  const options = { storage, now: () => now };
  const online = createCatalogCoordinator(backend(() => response()), options);
  await online.load(request);
  const stored = storage.getItem('streamsplease.catalog-results.v1');
  now += 6 * 60_000;
  const calls: string[] = [];
  const offline = createCatalogCoordinator(backend((provider) => {
    calls.push(provider);
    throw new Error('HTTP 403');
  }), options);
  const result = await offline.load(request);
  assert.equal(result.provenance.cache, 'stale');
  assert.equal(result.provenance.fetchedAt, initialTime);
  assert.match(result.cacheWarning ?? '', /Showing saved catalog data/);
  assert.equal(storage.getItem('streamsplease.catalog-results.v1'), stored);
  assert.deepEqual(calls, ['anilist']);
});

test('alternative results retain canonical identities, warnings and provenance in persistent cache', async () => {
  const storage = new MemoryStorage();
  const options = { storage, now: () => initialTime };
  const client = createCatalogCoordinator(backend((provider) => {
    if (provider === 'anilist') throw new Error('HTTP 403');
    return { ...response(provider), warnings: ['2 unmapped items omitted.'] };
  }), options);
  const result = await client.load(request);
  assert.equal(result.data.items[0].id, 42);
  assert.equal(result.data.items[0].idMal, 84);
  assert.equal(result.provenance.provider, 'jikan');
  assert.match(result.cacheWarning ?? '', /2 unmapped items/);
  assert.match(result.cacheWarning ?? '', /alternative catalog/);
  const restarted = createCatalogCoordinator(backend(() => { throw new Error('offline'); }), options);
  const cached = await restarted.load(request);
  assert.equal(cached.provenance.provider, 'jikan');
  assert.equal(cached.provenance.cache, 'fresh');
  assert.match(cached.cacheWarning ?? '', /2 unmapped items/);
});

test('new registered providers work without coordinator changes; unsupported capabilities are skipped', async () => {
  const registry: CatalogProvider[] = [
    { id: 'search-only', label: 'Search only', capabilities: ['search'] },
    { id: 'future-provider', label: 'Future provider', capabilities: ['season'] }
  ];
  const calls: string[] = [];
  const client = createCatalogCoordinator(backend((provider) => {
    calls.push(provider);
    return response(provider, true);
  }, registry));
  assert.equal((await client.load(seasonRequest)).provenance.provider, 'future-provider');
  assert.deepEqual(calls, ['future-provider']);
  const unsupported = createCatalogCoordinator(backend(() => { throw new Error('must not call'); }, registry.slice(0, 1)));
  await assert.rejects(unsupported.load(seasonRequest), /No catalog provider supports season/);
});

test('cooldowns apply across queries and primary recovery is not masked by cached fallback', async () => {
  let now = initialTime;
  let primaryOffline = true;
  const calls: string[] = [];
  const client = createCatalogCoordinator(backend((provider) => {
    calls.push(provider);
    if (provider === 'anilist' && primaryOffline) throw new Error('offline');
    return response(provider);
  }), { now: () => now });
  await client.load(request);
  await client.load({ kind: 'search', query: 'other' });
  assert.deepEqual(calls, ['anilist', 'jikan', 'jikan']);
  primaryOffline = false;
  now += 60_001;
  assert.equal((await client.load(request)).provenance.provider, 'anilist');
  assert.equal(calls.at(-1), 'anilist');
});

test('malformed provider results and wrong season data fail over, never become cached empty success', async () => {
  const client = createCatalogCoordinator(backend((provider) =>
    provider === 'anilist' ? { ...response(provider, true), year: 2025 } : response(provider, true)));
  assert.equal((await client.load(seasonRequest)).provenance.provider, 'jikan');
  const invalid = createCatalogCoordinator(backend(() => ({ provider: 'jikan', items: [{}], warnings: [] })));
  await assert.rejects(invalid.load(request), /Invalid catalog response/);
  assert.equal(normalizeCatalogResponse(response('jikan'), 'anilist', request), undefined);
});

test('invalid input is rejected before fetching the registry or contacting providers', async () => {
  const client = createCatalogCoordinator(async () => { throw new Error('must not be called'); });
  await assert.rejects(client.load({ kind: 'search', query: '\u0000unsafe' }), /Invalid catalog request/);
  await assert.rejects(client.load({ kind: 'season', season: 'SUMMER', year: 10 }), /Invalid catalog request/);
  assert.equal(normalizeCatalogProviders([...providers, providers[0]]), undefined);
});

test('cache bounds stale search age, rejects tampering and separates preview state', async () => {
  const storage = new MemoryStorage();
  let now = initialTime;
  const options = { storage, now: () => now };
  const native = createCatalogCoordinator(backend(() => response()), options);
  await native.load(request);
  now += 31 * 24 * 60 * 60_000;
  const expired = createCatalogCoordinator(backend(() => { throw new Error('offline'); }), options);
  await assert.rejects(expired.load(request), /offline/);
  const preview = createCatalogResultCache({ ...options, scope: 'preview' });
  assert.equal(preview.load('anilist', request, 90 * 24 * 60 * 60_000), undefined);
  storage.setItem('streamsplease.catalog-results.v1', JSON.stringify([
    { savedAt: now + 1, request, data: response() },
    { savedAt: now, request: { kind: 'search', query: {} }, data: response() }
  ]));
  const tampered = createCatalogResultCache(options);
  assert.equal(tampered.load('anilist', request, 1), undefined);
});

test('cache keeps working with unwritable storage and bounds retained queries', async () => {
  const cache = createCatalogResultCache({ storage: { getItem: () => null, setItem: () => { throw new Error('full'); } } });
  assert.doesNotThrow(() => cache.save(request, response()));
  assert.equal(cache.load('anilist', request, 60_000)?.data.items[0].id, 42);
  const storage = new MemoryStorage();
  let now = initialTime;
  const bounded = createCatalogResultCache({ storage, now: () => ++now });
  for (let i = 0; i < 60; i++) bounded.save({ kind: 'search', query: `title ${i}` }, response());
  assert.equal(JSON.parse(storage.getItem('streamsplease.catalog-results.v1')!).length, 48);
});

test('legacy saved seasons remain usable without being re-dated', async () => {
  const storage = new MemoryStorage();
  storage.setItem('streamsplease.season-cache.v1', JSON.stringify({ entries: {
    'SUMMER:2026': { savedAt: initialTime, data: { season: 'SUMMER', year: 2026, shows: items } }
  } }));
  const client = createCatalogCoordinator(backend(() => { throw new Error('offline'); }), {
    storage, now: () => initialTime + 60 * 60_000
  });
  const result = await client.load(seasonRequest);
  assert.equal(result.provenance.fetchedAt, initialTime);
  assert.equal(result.provenance.cache, 'stale');
});

test('preview adapters expose the same contract and canonical fixture identities', async () => {
  assert.deepEqual(await callPreviewBackend('catalog_providers'), providers);
  const primary = await callPreviewBackend('catalog_request', { provider: 'anilist', request: { kind: 'search', query: 'Black' } });
  const alternative = await callPreviewBackend('catalog_request', { provider: 'jikan', request: { kind: 'search', query: 'Black' } });
  const normalizedPrimary = normalizeCatalogResponse(primary, 'anilist', request);
  const normalizedAlternative = normalizeCatalogResponse(alternative, 'jikan', request);
  assert.ok(normalizedPrimary?.items.length);
  assert.deepEqual(normalizedPrimary?.items, normalizedAlternative?.items);
  assert.equal(catalogSourceLabel({ provider: 'jikan', label: 'Jikan', fetchedAt: initialTime, cache: 'stale' }, initialTime + 2 * 24 * 60 * 60_000), 'Jikan · saved 2d ago');
});
