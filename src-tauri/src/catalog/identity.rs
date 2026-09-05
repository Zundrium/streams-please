use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const FRIBB_IDENTITY_URL: &str = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-offline-database-reduced.json";
const SOURCE_CACHE_FILE: &str = "identity-fribb-v1.json";
const LEARNED_CACHE_FILE: &str = "identity-learned-v1.json";
const CACHE_VERSION: u32 = 1;
const SOURCE_CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_SOURCE_RESPONSE_BYTES: usize = 20 * 1024 * 1024;
const MAX_SOURCE_CACHE_BYTES: usize = 20 * 1024 * 1024;
const MAX_LEARNED_CACHE_BYTES: usize = 2 * 1024 * 1024;
const MAX_SOURCE_ENTRIES: usize = 100_000;
const MAX_LEARNED_ENTRIES: usize = 10_000;
const MAX_PROVIDER_IDS_PER_ENTRY: usize = 8;
const MAX_PROVIDER_NAME_LENGTH: usize = 32;
const MAX_CLOCK_SKEW_SECONDS: u64 = 5 * 60;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(super) struct ProviderId {
    pub(super) provider: String,
    pub(super) id: i64,
}

impl ProviderId {
    pub(super) fn mal(id: i64) -> Self {
        Self {
            provider: "mal".into(),
            id,
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct IdentityPair {
    anilist_id: i64,
    provider_id: ProviderId,
}

#[derive(Default)]
struct ResolverState {
    cache_dir: Option<PathBuf>,
    source: Option<StoredSource>,
    learned: BTreeSet<IdentityPair>,
    files_loaded: bool,
    source_retry_at: Option<Instant>,
    source_warnings: Vec<String>,
    load_warnings: Vec<String>,
}

pub(super) struct IdentityResolver {
    http: reqwest::Client,
    state: Mutex<ResolverState>,
}

pub(super) struct IdentityResolution {
    pub(super) anilist_by_provider_id: HashMap<ProviderId, i64>,
    pub(super) warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSource {
    version: u32,
    fetched_at: u64,
    entries: Vec<StoredIdentityEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredLearned {
    version: u32,
    entries: Vec<StoredIdentityEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredIdentityEntry {
    anilist_id: i64,
    provider_ids: BTreeMap<String, i64>,
}

#[derive(Deserialize)]
struct FribbIdentityEntry {
    anilist_id: Option<i64>,
    mal_id: Option<i64>,
}

struct IdentityIndex {
    by_provider_id: HashMap<ProviderId, i64>,
    conflicts: usize,
}

impl IdentityResolver {
    pub(super) fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            state: Mutex::new(ResolverState::default()),
        }
    }

    pub(super) async fn resolve_ids(
        &self,
        provider_ids: &HashSet<ProviderId>,
        cache_dir: &Path,
    ) -> Result<IdentityResolution, String> {
        if provider_ids.len() > 200
            || provider_ids
                .iter()
                .any(|value| !valid_provider_name(&value.provider) || !valid_identity_id(value.id))
        {
            return Err("Invalid provider identity lookup.".into());
        }

        let mut state = self.state.lock().await;
        self.load_files(&mut state, cache_dir).await?;
        let mut warnings = state.load_warnings.clone();
        self.refresh_source_if_needed(&mut state, cache_dir, &mut warnings)
            .await;

        let mut pairs = state
            .source
            .as_ref()
            .map(|source| pairs_from_entries(&source.entries))
            .transpose()?
            .unwrap_or_default();
        pairs.extend(state.learned.iter().cloned());
        let index = build_index(pairs)?;
        if index.conflicts > 0 {
            warnings.push(format!(
                "The identity database contained {} conflicting mapping pair(s); those mappings were excluded.",
                index.conflicts
            ));
        }

        let anilist_by_provider_id = provider_ids
            .iter()
            .filter_map(|provider_id| {
                index
                    .by_provider_id
                    .get(provider_id)
                    .copied()
                    .map(|anilist_id| (provider_id.clone(), anilist_id))
            })
            .collect();
        Ok(IdentityResolution {
            anilist_by_provider_id,
            warnings,
        })
    }

    pub(super) async fn learn_anilist_mappings(
        &self,
        mappings: &[(i64, i64)],
        cache_dir: &Path,
    ) -> Result<(), String> {
        if mappings.is_empty() {
            return Ok(());
        }
        if mappings.len() > 200
            || mappings.iter().any(|(anilist_id, mal_id)| {
                !valid_identity_id(*anilist_id) || !valid_identity_id(*mal_id)
            })
        {
            return Err("AniList returned invalid identity mappings.".into());
        }

        let mut state = self.state.lock().await;
        self.load_files(&mut state, cache_dir).await?;
        let additions = mappings
            .iter()
            .map(|(anilist_id, mal_id)| IdentityPair {
                anilist_id: *anilist_id,
                provider_id: ProviderId::mal(*mal_id),
            })
            .collect::<BTreeSet<_>>();
        if additions.difference(&state.learned).count()
            > MAX_LEARNED_ENTRIES.saturating_sub(state.learned.len())
        {
            return Err("The learned identity cache reached its safety limit.".into());
        }
        state.learned.extend(additions);

        let stored = StoredLearned {
            version: CACHE_VERSION,
            entries: entries_from_pairs(state.learned.iter().cloned())?,
        };
        let bytes = serde_json::to_vec(&stored).map_err(|error| {
            format!("The learned identity cache could not be prepared: {error}")
        })?;
        if bytes.len() > MAX_LEARNED_CACHE_BYTES {
            return Err("The learned identity cache is too large.".into());
        }
        write_cache_file(cache_dir.join(LEARNED_CACHE_FILE), bytes).await
    }

    async fn load_files(&self, state: &mut ResolverState, cache_dir: &Path) -> Result<(), String> {
        if let Some(loaded_dir) = &state.cache_dir {
            if loaded_dir != cache_dir {
                return Err("The catalog identity cache directory changed unexpectedly.".into());
            }
        }
        if state.files_loaded {
            return Ok(());
        }
        state.cache_dir = Some(cache_dir.to_owned());

        match read_cache_file(cache_dir.join(SOURCE_CACHE_FILE), MAX_SOURCE_CACHE_BYTES).await {
            Ok(Some(bytes)) => match parse_stored_source(&bytes) {
                Ok(source) => state.source = Some(source),
                Err(error) => state.load_warnings.push(format!(
                    "The saved identity database was invalid and was ignored: {error}"
                )),
            },
            Ok(None) => {}
            Err(error) => state.load_warnings.push(format!(
                "The saved identity database could not be read: {error}"
            )),
        }

        match read_cache_file(cache_dir.join(LEARNED_CACHE_FILE), MAX_LEARNED_CACHE_BYTES).await {
            Ok(Some(bytes)) => match parse_stored_learned(&bytes) {
                Ok(pairs) => state.learned = pairs.into_iter().collect(),
                Err(error) => state.load_warnings.push(format!(
                    "The learned identity mappings were invalid and were ignored: {error}"
                )),
            },
            Ok(None) => {}
            Err(error) => state.load_warnings.push(format!(
                "The learned identity mappings could not be read: {error}"
            )),
        }

        state.files_loaded = true;
        Ok(())
    }

    async fn refresh_source_if_needed(
        &self,
        state: &mut ResolverState,
        cache_dir: &Path,
        warnings: &mut Vec<String>,
    ) {
        let now = unix_timestamp();
        if state.source.as_ref().is_some_and(|source| {
            now.saturating_sub(source.fetched_at) <= SOURCE_CACHE_TTL.as_secs()
        }) || state
            .source_retry_at
            .is_some_and(|retry| retry > Instant::now())
        {
            warnings.extend(state.source_warnings.clone());
            return;
        }
        state.source_retry_at = Some(Instant::now() + Duration::from_secs(5 * 60));
        let mut refresh_warnings = Vec::new();

        match self.fetch_source().await {
            Ok(entries) => {
                let source = StoredSource {
                    version: CACHE_VERSION,
                    fetched_at: now,
                    entries,
                };
                match serde_json::to_vec(&source) {
                    Ok(bytes) if bytes.len() <= MAX_SOURCE_CACHE_BYTES => {
                        if let Err(error) =
                            write_cache_file(cache_dir.join(SOURCE_CACHE_FILE), bytes).await
                        {
                            refresh_warnings.push(format!(
                                "The refreshed identity database could not be saved: {error}"
                            ));
                        }
                        state.source = Some(source);
                    }
                    Ok(_) => refresh_warnings.push(
                        "The refreshed identity database exceeded its cache size limit.".into(),
                    ),
                    Err(error) => refresh_warnings.push(format!(
                        "The refreshed identity database could not be cached: {error}"
                    )),
                }
            }
            Err(error) if state.source.is_some() => refresh_warnings.push(format!(
                "The identity database could not be refreshed ({error}); using the validated saved database."
            )),
            Err(error) => refresh_warnings.push(format!(
                "The identity database is unavailable ({error}); only independently learned mappings can be used."
            )),
        }
        state.source_warnings = refresh_warnings;
        warnings.extend(state.source_warnings.clone());
    }

    async fn fetch_source(&self) -> Result<Vec<StoredIdentityEntry>, String> {
        let response = self
            .http
            .get(FRIBB_IDENTITY_URL)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|error| format!("Fribb is unreachable: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("Fribb returned HTTP {status}"));
        }
        let bytes = bounded_response_bytes(response, MAX_SOURCE_RESPONSE_BYTES).await?;
        let pairs = parse_fribb_source(&bytes)?;
        entries_from_pairs(pairs)
    }
}

fn valid_identity_id(id: i64) -> bool {
    (1..=i64::from(i32::MAX)).contains(&id)
}

fn valid_provider_name(provider: &str) -> bool {
    !provider.is_empty()
        && provider.len() <= MAX_PROVIDER_NAME_LENGTH
        && provider
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn validate_entries(entries: &[StoredIdentityEntry], max_entries: usize) -> Result<(), String> {
    if entries.is_empty() || entries.len() > max_entries {
        return Err("The identity cache has an invalid entry count.".into());
    }
    for entry in entries {
        if !valid_identity_id(entry.anilist_id)
            || entry.provider_ids.is_empty()
            || entry.provider_ids.len() > MAX_PROVIDER_IDS_PER_ENTRY
            || entry
                .provider_ids
                .iter()
                .any(|(provider, id)| !valid_provider_name(provider) || !valid_identity_id(*id))
        {
            return Err("The identity cache contains an invalid mapping.".into());
        }
    }
    Ok(())
}

fn parse_stored_source(bytes: &[u8]) -> Result<StoredSource, String> {
    let source: StoredSource = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid identity cache JSON: {error}"))?;
    if source.version != CACHE_VERSION {
        return Err("unsupported identity cache version".into());
    }
    let now = unix_timestamp();
    if source.fetched_at == 0 || source.fetched_at > now.saturating_add(MAX_CLOCK_SKEW_SECONDS) {
        return Err("invalid identity cache timestamp".into());
    }
    validate_entries(&source.entries, MAX_SOURCE_ENTRIES)?;
    Ok(source)
}

fn parse_stored_learned(bytes: &[u8]) -> Result<Vec<IdentityPair>, String> {
    let learned: StoredLearned = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid learned identity JSON: {error}"))?;
    if learned.version != CACHE_VERSION {
        return Err("unsupported learned identity cache version".into());
    }
    validate_entries(&learned.entries, MAX_LEARNED_ENTRIES)?;
    pairs_from_entries(&learned.entries)
}

fn parse_fribb_source(bytes: &[u8]) -> Result<Vec<IdentityPair>, String> {
    let entries: Vec<FribbIdentityEntry> = serde_json::from_slice(bytes)
        .map_err(|error| format!("Fribb returned invalid identity JSON: {error}"))?;
    if entries.is_empty() || entries.len() > MAX_SOURCE_ENTRIES {
        return Err("Fribb returned an invalid number of identity entries.".into());
    }

    let mut pairs = Vec::new();
    for entry in entries {
        match (entry.anilist_id, entry.mal_id) {
            (Some(anilist_id), Some(mal_id))
                if valid_identity_id(anilist_id) && valid_identity_id(mal_id) =>
            {
                pairs.push(IdentityPair {
                    anilist_id,
                    provider_id: ProviderId::mal(mal_id),
                });
            }
            (Some(_), Some(_)) => {
                return Err("Fribb returned an out-of-range identity mapping.".into())
            }
            _ => {}
        }
    }
    if pairs.is_empty() {
        return Err("Fribb did not return any usable identity mappings.".into());
    }
    Ok(pairs)
}

fn pairs_from_entries(entries: &[StoredIdentityEntry]) -> Result<Vec<IdentityPair>, String> {
    let mut pairs = Vec::new();
    for entry in entries {
        for (provider, id) in &entry.provider_ids {
            if !valid_identity_id(entry.anilist_id)
                || !valid_provider_name(provider)
                || !valid_identity_id(*id)
            {
                return Err("The identity cache contains an invalid mapping.".into());
            }
            pairs.push(IdentityPair {
                anilist_id: entry.anilist_id,
                provider_id: ProviderId {
                    provider: provider.clone(),
                    id: *id,
                },
            });
        }
    }
    Ok(pairs)
}

fn entries_from_pairs(
    pairs: impl IntoIterator<Item = IdentityPair>,
) -> Result<Vec<StoredIdentityEntry>, String> {
    let mut entries = Vec::new();
    for pair in pairs.into_iter().collect::<BTreeSet<_>>() {
        if !valid_identity_id(pair.anilist_id)
            || !valid_provider_name(&pair.provider_id.provider)
            || !valid_identity_id(pair.provider_id.id)
        {
            return Err("The identity mapping contains an invalid ID.".into());
        }
        entries.push(StoredIdentityEntry {
            anilist_id: pair.anilist_id,
            provider_ids: BTreeMap::from([(pair.provider_id.provider, pair.provider_id.id)]),
        });
    }
    Ok(entries)
}

fn build_index(pairs: Vec<IdentityPair>) -> Result<IdentityIndex, String> {
    if pairs.len() > MAX_SOURCE_ENTRIES + MAX_LEARNED_ENTRIES {
        return Err("The identity mapping exceeds its entry limit.".into());
    }
    let unique = pairs.into_iter().collect::<HashSet<_>>();
    let mut forward = HashMap::<(i64, String), HashSet<i64>>::new();
    let mut reverse = HashMap::<ProviderId, HashSet<i64>>::new();
    for pair in &unique {
        forward
            .entry((pair.anilist_id, pair.provider_id.provider.clone()))
            .or_default()
            .insert(pair.provider_id.id);
        reverse
            .entry(pair.provider_id.clone())
            .or_default()
            .insert(pair.anilist_id);
    }

    let mut by_provider_id = HashMap::new();
    let mut conflicts = 0;
    for pair in unique {
        let forward_unique = forward
            .get(&(pair.anilist_id, pair.provider_id.provider.clone()))
            .is_some_and(|ids| ids.len() == 1);
        let reverse_unique = reverse
            .get(&pair.provider_id)
            .is_some_and(|ids| ids.len() == 1);
        if forward_unique && reverse_unique {
            by_provider_id.insert(pair.provider_id, pair.anilist_id);
        } else {
            conflicts += 1;
        }
    }
    Ok(IdentityIndex {
        by_provider_id,
        conflicts,
    })
}

async fn bounded_response_bytes(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err("The identity database response is too large.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("The identity database response could not be read: {error}"))?
    {
        append_bounded(&mut bytes, &chunk, max_bytes)?;
    }
    Ok(bytes)
}

fn append_bounded(target: &mut Vec<u8>, chunk: &[u8], max_bytes: usize) -> Result<(), String> {
    if chunk.len() > max_bytes.saturating_sub(target.len()) {
        return Err("The identity database response is too large.".into());
    }
    target.extend_from_slice(chunk);
    Ok(())
}

async fn read_cache_file(path: PathBuf, max_bytes: usize) -> Result<Option<Vec<u8>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if metadata.len() > max_bytes as u64 {
            return Err("cache file exceeds its size limit".into());
        }
        let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        file.take(max_bytes as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() > max_bytes {
            return Err("cache file exceeds its size limit".into());
        }
        Ok(Some(bytes))
    })
    .await
    .map_err(|error| format!("cache read task failed: {error}"))?
}

async fn write_cache_file(path: PathBuf, bytes: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = path
            .parent()
            .ok_or_else(|| "The identity cache path is invalid.".to_string())?;
        std::fs::create_dir_all(directory).map_err(|error| {
            format!("The identity cache directory could not be created: {error}")
        })?;
        let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|error| {
            format!("The identity cache temporary file could not be created: {error}")
        })?;
        file.write_all(&bytes)
            .map_err(|error| format!("The identity cache could not be written: {error}"))?;
        file.as_file()
            .sync_all()
            .map_err(|error| format!("The identity cache could not be finalized: {error}"))?;
        file.persist(path)
            .map_err(|error| format!("The identity cache could not be saved: {}", error.error))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("cache write task failed: {error}"))?
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::{
        append_bounded, build_index, parse_fribb_source, IdentityPair, ProviderId,
        MAX_SOURCE_RESPONSE_BYTES,
    };

    fn pair(anilist_id: i64, mal_id: i64) -> IdentityPair {
        IdentityPair {
            anilist_id,
            provider_id: ProviderId::mal(mal_id),
        }
    }

    #[test]
    fn excludes_conflicts_in_both_identity_directions() {
        let index = build_index(vec![
            pair(1, 10),
            pair(1, 11),
            pair(2, 20),
            pair(3, 20),
            pair(4, 40),
            pair(4, 40),
        ])
        .unwrap();
        assert_eq!(index.conflicts, 4);
        assert_eq!(index.by_provider_id.get(&ProviderId::mal(40)), Some(&4));
        assert!(!index.by_provider_id.contains_key(&ProviderId::mal(10)));
        assert!(!index.by_provider_id.contains_key(&ProviderId::mal(11)));
        assert!(!index.by_provider_id.contains_key(&ProviderId::mal(20)));
    }

    #[test]
    fn parses_only_explicit_bounded_fribb_ids() {
        let mappings = parse_fribb_source(
            br#"[{"anilist_id":1,"mal_id":10,"title":"ignored"},{"anilist_id":2,"mal_id":null}]"#,
        )
        .unwrap();
        assert_eq!(mappings, vec![pair(1, 10)]);
        assert!(parse_fribb_source(br#"[{"anilist_id":0,"mal_id":10}]"#).is_err());
        assert!(parse_fribb_source(br#"[]"#).is_err());
    }

    #[tokio::test]
    async fn resolves_saved_mappings_across_restarts_without_anilist() {
        let directory = tempfile::tempdir().unwrap();
        let source = super::StoredSource {
            version: super::CACHE_VERSION,
            fetched_at: super::unix_timestamp(),
            entries: super::entries_from_pairs([pair(1, 10)]).unwrap(),
        };
        super::write_cache_file(
            directory.path().join(super::SOURCE_CACHE_FILE),
            serde_json::to_vec(&source).unwrap(),
        )
        .await
        .unwrap();
        let first = super::IdentityResolver::new(reqwest::Client::new());
        first
            .learn_anilist_mappings(&[(2, 20)], directory.path())
            .await
            .unwrap();
        let restarted = super::IdentityResolver::new(reqwest::Client::new());
        let requested = [
            ProviderId::mal(10),
            ProviderId::mal(20),
            ProviderId::mal(999),
        ]
        .into_iter()
        .collect();
        let result = restarted
            .resolve_ids(&requested, directory.path())
            .await
            .unwrap();
        assert_eq!(
            result.anilist_by_provider_id.get(&ProviderId::mal(10)),
            Some(&1)
        );
        assert_eq!(
            result.anilist_by_provider_id.get(&ProviderId::mal(20)),
            Some(&2)
        );
        assert!(!result
            .anilist_by_provider_id
            .contains_key(&ProviderId::mal(999)));
        assert!(result.warnings.is_empty());
    }

    #[tokio::test]
    async fn stale_mapping_warnings_survive_a_refresh_cooldown() {
        let directory = tempfile::tempdir().unwrap();
        let source = super::StoredSource {
            version: super::CACHE_VERSION,
            fetched_at: super::unix_timestamp() - super::SOURCE_CACHE_TTL.as_secs() - 1,
            entries: super::entries_from_pairs([pair(1, 10)]).unwrap(),
        };
        super::write_cache_file(
            directory.path().join(super::SOURCE_CACHE_FILE),
            serde_json::to_vec(&source).unwrap(),
        )
        .await
        .unwrap();
        let resolver = super::IdentityResolver::new(reqwest::Client::new());
        {
            let mut state = resolver.state.lock().await;
            state.source_retry_at =
                Some(std::time::Instant::now() + std::time::Duration::from_secs(30));
            state.source_warnings = vec!["Using saved identity mappings while offline.".into()];
        }
        let requested = [ProviderId::mal(10)].into_iter().collect();
        for _ in 0..2 {
            let result = resolver
                .resolve_ids(&requested, directory.path())
                .await
                .unwrap();
            assert_eq!(
                result.anilist_by_provider_id.get(&ProviderId::mal(10)),
                Some(&1)
            );
            assert_eq!(
                result.warnings,
                ["Using saved identity mappings while offline."]
            );
        }
    }

    #[test]
    fn rejects_invalid_persistent_mapping_versions_timestamps_and_ids() {
        for value in [
            serde_json::json!({"version": 2, "fetchedAt": 1, "entries": [{"anilistId": 1, "providerIds": {"mal": 10}}]}),
            serde_json::json!({"version": 1, "fetchedAt": super::unix_timestamp() + 10000, "entries": [{"anilistId": 1, "providerIds": {"mal": 10}}]}),
            serde_json::json!({"version": 1, "fetchedAt": 1, "entries": [{"anilistId": 1, "providerIds": {"mal": 0}}]}),
        ] {
            assert!(super::parse_stored_source(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }

    #[test]
    fn independent_provider_namespaces_do_not_conflict() {
        let index = build_index(vec![
            pair(1, 10),
            IdentityPair {
                anilist_id: 2,
                provider_id: ProviderId {
                    provider: "kitsu".into(),
                    id: 10,
                },
            },
        ])
        .unwrap();
        assert_eq!(index.conflicts, 0);
        assert_eq!(index.by_provider_id.len(), 2);
    }

    #[test]
    fn bounds_identity_response_assembly() {
        let mut bytes = vec![0; 4];
        append_bounded(&mut bytes, &[1, 2], 6).unwrap();
        assert!(append_bounded(&mut bytes, &[3], 6).is_err());
        assert_eq!(MAX_SOURCE_RESPONSE_BYTES, 20 * 1024 * 1024);
    }
}
