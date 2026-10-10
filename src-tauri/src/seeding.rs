use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use librqbit::{
    api::{Api, TorrentIdOrHash},
    ManagedTorrent, TorrentStatsState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use tokio::sync::Mutex;

use crate::torrent::TorrentState;

pub const DEFAULT_TARGET_RATIO: f64 = 1.5;
pub const CACHE_LIMIT_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const MIN_TARGET_RATIO: f64 = 0.5;
const MAX_TARGET_RATIO: f64 = 10.0;
const LEDGER_FILE_NAME: &str = "seeding.json";
const SESSION_FILE_NAME: &str = "session.json";
const RECONCILE_INTERVAL: Duration = Duration::from_secs(5);
const LEDGER_SAVE_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LedgerEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    added_at: u64,
    last_active_at: u64,
    uploaded_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Ledger {
    target_ratio: f64,
    episodes: HashMap<String, LedgerEntry>,
}

impl Default for Ledger {
    fn default() -> Self {
        Self {
            target_ratio: DEFAULT_TARGET_RATIO,
            episodes: HashMap::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SeedAction {
    Keep,
    Resume,
    Pause,
    Remove,
}

#[derive(Clone, Copy, Debug)]
struct PolicyInput {
    active: bool,
    state: TorrentStatsState,
    paused: bool,
    finished: bool,
    ratio: f64,
}

#[derive(Clone, Debug)]
struct CacheItem {
    info_hash: String,
    size_bytes: u64,
    last_active_at: u64,
    active: bool,
}

struct TorrentSnapshot {
    id: usize,
    info_hash: String,
    name: Option<String>,
    state: TorrentStatsState,
    paused: bool,
    finished: bool,
    size_bytes: u64,
    downloaded_bytes: u64,
    session_uploaded_bytes: u64,
    upload_speed_mbps: f64,
    peers: usize,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedingEpisode {
    info_hash: String,
    name: String,
    status: &'static str,
    size_bytes: u64,
    downloaded_bytes: u64,
    uploaded_bytes: u64,
    ratio: f64,
    upload_speed_mbps: f64,
    peers: usize,
    added_at: u64,
    last_active_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedingOverview {
    target_ratio: f64,
    default_target_ratio: f64,
    cache_limit_bytes: u64,
    cache_used_bytes: u64,
    total_uploaded_bytes: u64,
    upload_speed_mbps: f64,
    episodes: Vec<SeedingEpisode>,
}

struct Inner {
    ledger: Ledger,
    active: HashSet<String>,
    seen_uploaded: HashMap<String, u64>,
    dirty: bool,
    last_saved: Instant,
}

pub struct SeedingManager {
    api: Api,
    download_dir: PathBuf,
    ledger_path: PathBuf,
    inner: Mutex<Inner>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

pub fn normalize_info_hash(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (trimmed.len() == 40 && trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| trimmed.to_ascii_lowercase())
}

fn validate_target_ratio(ratio: f64) -> Result<f64, String> {
    if !ratio.is_finite() || !(MIN_TARGET_RATIO..=MAX_TARGET_RATIO).contains(&ratio) {
        return Err(format!(
            "Choose a seeding ratio between {MIN_TARGET_RATIO} and {MAX_TARGET_RATIO}."
        ));
    }
    Ok((ratio * 100.0).round() / 100.0)
}

fn share_ratio(uploaded_bytes: u64, size_bytes: u64) -> f64 {
    if size_bytes == 0 {
        return 0.0;
    }
    uploaded_bytes as f64 / size_bytes as f64
}

fn accumulate_upload(total: u64, last_seen: Option<u64>, current: u64) -> u64 {
    let delta = match last_seen {
        Some(previous) if current >= previous => current - previous,
        _ => current,
    };
    total.saturating_add(delta)
}

fn decide(input: PolicyInput, target_ratio: f64) -> SeedAction {
    if input.active {
        return SeedAction::Keep;
    }
    match input.state {
        TorrentStatsState::Initializing | TorrentStatsState::Error => SeedAction::Keep,
        TorrentStatsState::Live | TorrentStatsState::Paused if input.finished => {
            if input.ratio >= target_ratio {
                SeedAction::Remove
            } else if input.paused {
                SeedAction::Resume
            } else {
                SeedAction::Keep
            }
        }
        _ if input.paused => SeedAction::Keep,
        _ => SeedAction::Pause,
    }
}

fn plan_evictions(items: &[CacheItem], limit: u64) -> Vec<String> {
    let mut used = items
        .iter()
        .fold(0u64, |total, item| total.saturating_add(item.size_bytes));
    if used <= limit {
        return Vec::new();
    }
    let mut candidates: Vec<&CacheItem> = items.iter().filter(|item| !item.active).collect();
    candidates.sort_by_key(|item| item.last_active_at);
    let mut evicted = Vec::new();
    for item in candidates {
        if used <= limit {
            break;
        }
        used = used.saturating_sub(item.size_bytes);
        evicted.push(item.info_hash.clone());
    }
    evicted
}

fn status_label(snapshot: &TorrentSnapshot, active: bool) -> &'static str {
    if active {
        return "streaming";
    }
    match snapshot.state {
        TorrentStatsState::Error => "error",
        TorrentStatsState::Initializing => "checking",
        _ if snapshot.finished => "seeding",
        _ if snapshot.paused => "partial",
        _ => "downloading",
    }
}

fn parse_ledger(source: &str) -> Ledger {
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(source) else {
        return Ledger::default();
    };
    let target_ratio = root
        .get("targetRatio")
        .and_then(Value::as_f64)
        .and_then(|ratio| validate_target_ratio(ratio).ok())
        .unwrap_or(DEFAULT_TARGET_RATIO);
    let episodes = root
        .get("episodes")
        .and_then(Value::as_object)
        .map(|episodes| {
            episodes
                .iter()
                .filter_map(|(hash, value)| {
                    let hash = normalize_info_hash(hash)?;
                    let entry = value.as_object()?;
                    let number = |key: &str| entry.get(key).and_then(Value::as_u64).unwrap_or(0);
                    let name = entry
                        .get("name")
                        .and_then(Value::as_str)
                        .map(|name| name.chars().take(512).collect::<String>())
                        .filter(|name| !name.trim().is_empty());
                    Some((
                        hash,
                        LedgerEntry {
                            name,
                            added_at: number("addedAt"),
                            last_active_at: number("lastActiveAt"),
                            uploaded_bytes: number("uploadedBytes"),
                        },
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    Ledger {
        target_ratio,
        episodes,
    }
}

fn sanitize_session_database(
    source: &str,
    session_dir: &Path,
    download_dir: &Path,
) -> Option<String> {
    let mut root = match serde_json::from_str::<Value>(source) {
        Ok(Value::Object(root)) => root,
        _ => return None,
    };
    let torrents = root.get_mut("torrents")?.as_object_mut()?;
    torrents.retain(|_, torrent| {
        let Some(hash) = torrent
            .get("info_hash")
            .and_then(Value::as_str)
            .and_then(normalize_info_hash)
        else {
            return false;
        };
        let expected_folder = download_dir.join(&hash);
        let folder_matches = torrent
            .get("output_folder")
            .and_then(Value::as_str)
            .is_some_and(|folder| Path::new(folder) == expected_folder);
        folder_matches && session_dir.join(format!("{hash}.torrent")).is_file()
    });
    serde_json::to_string(&Value::Object(root)).ok()
}

pub fn prepare_session_directory(session_dir: &Path, download_dir: &Path) {
    let database = session_dir.join(SESSION_FILE_NAME);
    let Ok(source) = std::fs::read_to_string(&database) else {
        return;
    };
    let result = match sanitize_session_database(&source, session_dir, download_dir) {
        Some(sanitized) if sanitized != source => std::fs::write(&database, sanitized),
        Some(_) => Ok(()),
        None => std::fs::remove_file(&database),
    };
    if let Err(error) = result {
        eprintln!("could not prepare the torrent session database: {error}");
    }
}

pub fn purge_orphaned_media(download_dir: &Path, keep: &HashSet<String>) {
    let Ok(entries) = std::fs::read_dir(download_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let known = name
            .to_str()
            .and_then(normalize_info_hash)
            .is_some_and(|hash| keep.contains(&hash));
        if known {
            continue;
        }
        let path = entry.path();
        let result = match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(&path),
            Ok(_) => std::fs::remove_file(&path),
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            eprintln!("could not remove cached media {path:?}: {error}");
        }
    }
}

fn snapshot(id: usize, handle: &ManagedTorrent) -> TorrentSnapshot {
    let stats = handle.stats();
    let live = stats.live.as_ref();
    TorrentSnapshot {
        id,
        info_hash: handle.info_hash().as_string(),
        name: handle.name(),
        state: stats.state,
        paused: handle.is_paused(),
        finished: stats.finished,
        size_bytes: stats.total_bytes,
        downloaded_bytes: stats.progress_bytes,
        session_uploaded_bytes: stats.uploaded_bytes,
        upload_speed_mbps: live.map(|live| live.upload_speed.mbps).unwrap_or(0.0),
        peers: live.map(|live| live.snapshot.peer_stats.live).unwrap_or(0),
        error: stats.error,
    }
}

impl SeedingManager {
    pub fn new(api: Api, download_dir: PathBuf, ledger_dir: &Path) -> Arc<Self> {
        let ledger_path = ledger_dir.join(LEDGER_FILE_NAME);
        let ledger = std::fs::read_to_string(&ledger_path)
            .map(|source| parse_ledger(&source))
            .unwrap_or_default();
        Arc::new(Self {
            api,
            download_dir,
            ledger_path,
            inner: Mutex::new(Inner {
                ledger,
                active: HashSet::new(),
                seen_uploaded: HashMap::new(),
                dirty: true,
                last_saved: Instant::now(),
            }),
        })
    }

    pub fn spawn_reconciler(self: &Arc<Self>) {
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                manager.reconcile().await;
                tokio::time::sleep(RECONCILE_INTERVAL).await;
            }
        });
    }

    fn snapshots(&self) -> Vec<TorrentSnapshot> {
        let handles = self.api.session().with_torrents(|torrents| {
            torrents
                .map(|(id, handle)| (id, Arc::clone(handle)))
                .collect::<Vec<_>>()
        });
        handles
            .iter()
            .map(|(id, handle)| snapshot(*id, handle))
            .collect()
    }

    fn info_hash_for_id(&self, id: usize) -> Option<String> {
        self.api
            .mgr_handle(TorrentIdOrHash::Id(id))
            .ok()
            .map(|handle| handle.info_hash().as_string())
    }

    pub async fn begin_stream(&self, info_hash: &str) {
        let mut inner = self.inner.lock().await;
        inner.active.insert(info_hash.to_string());
        let now = now_millis();
        let entry = inner
            .ledger
            .episodes
            .entry(info_hash.to_string())
            .or_insert_with(|| LedgerEntry {
                added_at: now,
                ..Default::default()
            });
        entry.last_active_at = now;
        inner.dirty = true;
    }

    pub async fn stream_started(&self, info_hash: &str, name: Option<String>) {
        let mut inner = self.inner.lock().await;
        if let (Some(entry), Some(name)) = (inner.ledger.episodes.get_mut(info_hash), name) {
            entry.name = Some(name.chars().take(512).collect());
            inner.dirty = true;
        }
    }

    pub async fn stream_failed(&self, info_hash: &str) {
        let mut inner = self.inner.lock().await;
        inner.active.remove(info_hash);
        inner.dirty = true;
    }

    pub async fn release(&self, id: usize) -> Result<(), String> {
        let info_hash = self
            .info_hash_for_id(id)
            .ok_or_else(|| "This episode is no longer in the torrent session.".to_string())?;
        {
            let mut inner = self.inner.lock().await;
            inner.active.remove(&info_hash);
            if let Some(entry) = inner.ledger.episodes.get_mut(&info_hash) {
                entry.last_active_at = now_millis();
            }
            inner.dirty = true;
        }
        self.reconcile().await;
        Ok(())
    }

    pub async fn remove(&self, info_hash: &str) -> Result<(), String> {
        let info_hash = normalize_info_hash(info_hash)
            .ok_or_else(|| "The episode identifier is not a valid info hash.".to_string())?;
        let mut inner = self.inner.lock().await;
        if inner.active.contains(&info_hash) {
            return Err("This episode is playing. Stop playback before removing it.".into());
        }
        self.delete_locked(&mut inner, &info_hash).await?;
        self.save_locked(&mut inner, true).await;
        Ok(())
    }

    pub async fn set_target_ratio(&self, ratio: f64) -> Result<SeedingOverview, String> {
        let ratio = validate_target_ratio(ratio)?;
        {
            let mut inner = self.inner.lock().await;
            inner.ledger.target_ratio = ratio;
            inner.dirty = true;
            self.save_locked(&mut inner, true).await;
        }
        self.reconcile().await;
        Ok(self.overview().await)
    }

    pub async fn overview(&self) -> SeedingOverview {
        let mut inner = self.inner.lock().await;
        let snapshots = self.snapshots();
        self.record_uploads(&mut inner, &snapshots);
        let mut episodes: Vec<SeedingEpisode> = snapshots
            .iter()
            .map(|snapshot| {
                let entry = inner
                    .ledger
                    .episodes
                    .get(&snapshot.info_hash)
                    .cloned()
                    .unwrap_or_default();
                let active = inner.active.contains(&snapshot.info_hash);
                SeedingEpisode {
                    info_hash: snapshot.info_hash.clone(),
                    name: entry
                        .name
                        .or_else(|| snapshot.name.clone())
                        .unwrap_or_else(|| snapshot.info_hash[..12].to_string()),
                    status: status_label(snapshot, active),
                    size_bytes: snapshot.size_bytes,
                    downloaded_bytes: snapshot.downloaded_bytes,
                    uploaded_bytes: entry.uploaded_bytes,
                    ratio: share_ratio(entry.uploaded_bytes, snapshot.size_bytes),
                    upload_speed_mbps: snapshot.upload_speed_mbps,
                    peers: snapshot.peers,
                    added_at: entry.added_at,
                    last_active_at: entry.last_active_at,
                    error: snapshot.error.clone(),
                }
            })
            .collect();
        episodes.sort_by(|left, right| {
            (right.status == "streaming")
                .cmp(&(left.status == "streaming"))
                .then(right.last_active_at.cmp(&left.last_active_at))
        });
        SeedingOverview {
            target_ratio: inner.ledger.target_ratio,
            default_target_ratio: DEFAULT_TARGET_RATIO,
            cache_limit_bytes: CACHE_LIMIT_BYTES,
            cache_used_bytes: episodes.iter().fold(0u64, |total, episode| {
                total.saturating_add(episode.size_bytes)
            }),
            total_uploaded_bytes: episodes.iter().fold(0u64, |total, episode| {
                total.saturating_add(episode.uploaded_bytes)
            }),
            upload_speed_mbps: episodes
                .iter()
                .map(|episode| episode.upload_speed_mbps)
                .sum(),
            episodes,
        }
    }

    pub async fn reconcile(&self) {
        let mut inner = self.inner.lock().await;
        let snapshots = self.snapshots();
        self.record_uploads(&mut inner, &snapshots);

        let managed: HashSet<String> = snapshots
            .iter()
            .map(|snapshot| snapshot.info_hash.clone())
            .collect();
        let Inner { ledger, active, .. } = &mut *inner;
        let before = ledger.episodes.len();
        ledger
            .episodes
            .retain(|hash, _| managed.contains(hash) || active.contains(hash));
        if ledger.episodes.len() != before {
            inner.dirty = true;
        }

        let target_ratio = inner.ledger.target_ratio;
        let mut removals = Vec::new();
        for snapshot in &snapshots {
            let uploaded = inner
                .ledger
                .episodes
                .get(&snapshot.info_hash)
                .map(|entry| entry.uploaded_bytes)
                .unwrap_or(0);
            let action = decide(
                PolicyInput {
                    active: inner.active.contains(&snapshot.info_hash),
                    state: snapshot.state,
                    paused: snapshot.paused,
                    finished: snapshot.finished,
                    ratio: share_ratio(uploaded, snapshot.size_bytes),
                },
                target_ratio,
            );
            let result = match action {
                SeedAction::Keep => Ok(()),
                SeedAction::Resume => self
                    .api
                    .api_torrent_action_start(TorrentIdOrHash::Id(snapshot.id))
                    .await
                    .map(|_| ()),
                SeedAction::Pause => self
                    .api
                    .api_torrent_action_pause(TorrentIdOrHash::Id(snapshot.id))
                    .await
                    .map(|_| ()),
                SeedAction::Remove => {
                    removals.push(snapshot.info_hash.clone());
                    Ok(())
                }
            };
            if let Err(error) = result {
                eprintln!(
                    "seeding policy could not update torrent {}: {error}",
                    snapshot.info_hash
                );
            }
        }

        let cache_items: Vec<CacheItem> = snapshots
            .iter()
            .filter(|snapshot| !removals.contains(&snapshot.info_hash))
            .map(|snapshot| CacheItem {
                info_hash: snapshot.info_hash.clone(),
                size_bytes: snapshot.size_bytes,
                last_active_at: inner
                    .ledger
                    .episodes
                    .get(&snapshot.info_hash)
                    .map(|entry| entry.last_active_at)
                    .unwrap_or(0),
                active: inner.active.contains(&snapshot.info_hash),
            })
            .collect();
        removals.extend(plan_evictions(&cache_items, CACHE_LIMIT_BYTES));

        for info_hash in removals {
            if let Err(error) = self.delete_locked(&mut inner, &info_hash).await {
                eprintln!("could not remove cached episode {info_hash}: {error}");
            }
        }
        self.save_locked(&mut inner, false).await;
    }

    fn record_uploads(&self, inner: &mut Inner, snapshots: &[TorrentSnapshot]) {
        let now = now_millis();
        for snapshot in snapshots {
            let previous = inner.seen_uploaded.get(&snapshot.info_hash).copied();
            inner
                .seen_uploaded
                .insert(snapshot.info_hash.clone(), snapshot.session_uploaded_bytes);
            let entry = inner
                .ledger
                .episodes
                .entry(snapshot.info_hash.clone())
                .or_insert_with(|| LedgerEntry {
                    added_at: now,
                    last_active_at: now,
                    ..Default::default()
                });
            if entry.name.is_none() {
                entry.name = snapshot.name.clone();
            }
            let total = accumulate_upload(
                entry.uploaded_bytes,
                previous,
                snapshot.session_uploaded_bytes,
            );
            if total != entry.uploaded_bytes {
                entry.uploaded_bytes = total;
                inner.dirty = true;
            }
        }
    }

    async fn delete_locked(&self, inner: &mut Inner, info_hash: &str) -> Result<(), String> {
        let id20 = TorrentIdOrHash::parse(info_hash)
            .map_err(|error| format!("The episode identifier is invalid: {error}"))?;
        if self.api.mgr_handle(id20).is_ok() {
            self.api
                .api_torrent_action_delete(id20)
                .await
                .map_err(|error| format!("The cached episode could not be removed: {error}"))?;
        }
        let folder = self.download_dir.join(info_hash);
        tauri::async_runtime::spawn_blocking(move || match std::fs::remove_dir_all(&folder) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("The cached episode files could not be removed: {error}"))?;
        inner.ledger.episodes.remove(info_hash);
        inner.seen_uploaded.remove(info_hash);
        inner.dirty = true;
        Ok(())
    }

    async fn save_locked(&self, inner: &mut Inner, force: bool) {
        if !inner.dirty || (!force && inner.last_saved.elapsed() < LEDGER_SAVE_INTERVAL) {
            return;
        }
        let Ok(contents) = serde_json::to_string(&inner.ledger) else {
            return;
        };
        let path = self.ledger_path.clone();
        let written = tauri::async_runtime::spawn_blocking(move || {
            let temporary = path.with_extension("json.tmp");
            std::fs::write(&temporary, contents)?;
            std::fs::rename(&temporary, &path)
        })
        .await;
        match written {
            Ok(Ok(())) => {
                inner.dirty = false;
                inner.last_saved = Instant::now();
            }
            Ok(Err(error)) => eprintln!("could not save the seeding ledger: {error}"),
            Err(error) => eprintln!("could not save the seeding ledger: {error}"),
        }
    }
}

#[tauri::command]
pub async fn seeding_overview(state: State<'_, TorrentState>) -> Result<SeedingOverview, String> {
    Ok(state.seeding().overview().await)
}

#[tauri::command]
pub async fn set_seeding_target_ratio(
    state: State<'_, TorrentState>,
    ratio: f64,
) -> Result<SeedingOverview, String> {
    state.seeding().set_target_ratio(ratio).await
}

#[tauri::command]
pub async fn remove_torrent(
    state: State<'_, TorrentState>,
    info_hash: String,
) -> Result<(), String> {
    state.seeding().remove(&info_hash).await
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use librqbit::TorrentStatsState;

    use super::{
        accumulate_upload, decide, normalize_info_hash, parse_ledger, plan_evictions,
        sanitize_session_database, share_ratio, validate_target_ratio, CacheItem, PolicyInput,
        SeedAction, DEFAULT_TARGET_RATIO,
    };

    const HASH: &str = "08ada5a7a6183aae1e09d831df6748d566095a10";

    fn input(state: TorrentStatsState, paused: bool, finished: bool, ratio: f64) -> PolicyInput {
        PolicyInput {
            active: false,
            state,
            paused,
            finished,
            ratio,
        }
    }

    fn item(hash: &str, size_bytes: u64, last_active_at: u64, active: bool) -> CacheItem {
        CacheItem {
            info_hash: hash.into(),
            size_bytes,
            last_active_at,
            active,
        }
    }

    #[test]
    fn normalizes_hex_info_hashes() {
        assert_eq!(
            normalize_info_hash(&HASH.to_uppercase()).as_deref(),
            Some(HASH)
        );
        assert!(normalize_info_hash("../media").is_none());
        assert!(normalize_info_hash(&HASH[..39]).is_none());
    }

    #[test]
    fn validates_target_ratios() {
        assert_eq!(validate_target_ratio(1.5), Ok(1.5));
        assert!(validate_target_ratio(0.1).is_err());
        assert!(validate_target_ratio(f64::NAN).is_err());
        assert!(validate_target_ratio(11.0).is_err());
    }

    #[test]
    fn share_ratio_uses_episode_size() {
        assert_eq!(share_ratio(150, 100), 1.5);
        assert_eq!(share_ratio(150, 0), 0.0);
    }

    #[test]
    fn accumulates_uploads_across_counter_resets() {
        assert_eq!(accumulate_upload(100, None, 40), 140);
        assert_eq!(accumulate_upload(140, Some(40), 90), 190);
        assert_eq!(accumulate_upload(190, Some(90), 10), 200);
        assert_eq!(accumulate_upload(200, Some(10), 10), 200);
    }

    #[test]
    fn seeding_policy_keeps_active_streams() {
        let mut active = input(TorrentStatsState::Live, false, true, 5.0);
        active.active = true;
        assert_eq!(decide(active, 1.5), SeedAction::Keep);
    }

    #[test]
    fn seeding_policy_removes_finished_episodes_at_target() {
        let seeding = input(TorrentStatsState::Live, false, true, 1.5);
        assert_eq!(decide(seeding, 1.5), SeedAction::Remove);
        let below = input(TorrentStatsState::Live, false, true, 1.49);
        assert_eq!(decide(below, 1.5), SeedAction::Keep);
        let paused = input(TorrentStatsState::Paused, true, true, 0.2);
        assert_eq!(decide(paused, 1.5), SeedAction::Resume);
    }

    #[test]
    fn seeding_policy_pauses_partial_downloads() {
        let partial = input(TorrentStatsState::Live, false, false, 0.0);
        assert_eq!(decide(partial, 1.5), SeedAction::Pause);
        let cached = input(TorrentStatsState::Paused, true, false, 0.0);
        assert_eq!(decide(cached, 1.5), SeedAction::Keep);
        let checking = input(TorrentStatsState::Initializing, false, false, 0.0);
        assert_eq!(decide(checking, 1.5), SeedAction::Keep);
    }

    #[test]
    fn evicts_least_recently_used_inactive_episodes() {
        let items = [
            item("a", 6, 30, true),
            item("b", 4, 10, false),
            item("c", 4, 20, false),
            item("d", 1, 5, false),
        ];
        assert!(plan_evictions(&items, 15).is_empty());
        assert_eq!(plan_evictions(&items, 10), vec!["d", "b"]);
        assert_eq!(plan_evictions(&items, 1), vec!["d", "b", "c"]);
    }

    #[test]
    fn parses_ledgers_defensively() {
        let ledger = parse_ledger(&format!(
            r#"{{"targetRatio":42,"episodes":{{"{}":{{"name":"Ep","addedAt":1,"lastActiveAt":2,"uploadedBytes":3}},"bad":{{}}}}}}"#,
            HASH.to_uppercase()
        ));
        assert_eq!(ledger.target_ratio, DEFAULT_TARGET_RATIO);
        assert_eq!(ledger.episodes.len(), 1);
        let entry = &ledger.episodes[HASH];
        assert_eq!(entry.name.as_deref(), Some("Ep"));
        assert_eq!(entry.uploaded_bytes, 3);
        assert_eq!(parse_ledger("not json").episodes.len(), 0);
    }

    #[test]
    fn sanitizes_session_database_entries() {
        let directory = tempfile::tempdir().unwrap();
        let session_dir = directory.path().join("session");
        let download_dir = directory.path().join("media");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join(format!("{HASH}.torrent")), b"d").unwrap();
        let folder = download_dir.join(HASH);
        let source = serde_json::json!({
            "torrents": {
                "0": { "info_hash": HASH, "output_folder": folder, "is_paused": false },
                "1": { "info_hash": HASH, "output_folder": "C:/elsewhere", "is_paused": false },
                "2": { "info_hash": "ffffffffffffffffffffffffffffffffffffffff", "output_folder": download_dir.join("ffffffffffffffffffffffffffffffffffffffff"), "is_paused": false }
            }
        })
        .to_string();
        let sanitized = sanitize_session_database(&source, &session_dir, &download_dir).unwrap();
        let value: serde_json::Value = serde_json::from_str(&sanitized).unwrap();
        let torrents = value["torrents"].as_object().unwrap();
        assert_eq!(torrents.len(), 1);
        assert!(torrents.contains_key("0"));
        assert!(sanitize_session_database("[]", &session_dir, Path::new("media")).is_none());
    }
}
