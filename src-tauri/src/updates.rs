use std::{sync::Mutex, time::Duration};

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const GITHUB_RELEASES_URL: &str =
    "https://api.github.com/repos/Zundrium/streams-please/releases?per_page=10";
const GITHUB_API_VERSION: &str = "2022-11-28";
const EMBEDDED_GITHUB_TOKEN: Option<&str> = option_env!("STREAMSPLEASE_GITHUB_TOKEN");

pub struct UpdateState {
    client: Client,
    pending: Mutex<Option<Update>>,
}

impl UpdateState {
    pub fn new() -> Result<Self, String> {
        let client = Client::builder()
            .user_agent("StreamsPlease updater")
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| format!("creating update client: {error}"))?;
        Ok(Self {
            client,
            pending: Mutex::new(None),
        })
    }
}

#[derive(Deserialize)]
struct GithubRelease {
    draft: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    url: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateCheckResult {
    NotConfigured,
    UpToDate,
    #[serde(rename_all = "camelCase")]
    Available {
        version: String,
        current_version: String,
        notes: Option<String>,
    },
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum UpdateDownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

fn embedded_update_token() -> Option<&'static str> {
    EMBEDDED_GITHUB_TOKEN
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

fn github_request(client: &Client, url: &str, token: &str) -> reqwest::RequestBuilder {
    client
        .get(url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
}

fn latest_manifest_url(releases: Vec<GithubRelease>) -> Option<String> {
    releases
        .into_iter()
        .filter(|release| !release.draft)
        .flat_map(|release| release.assets)
        .find(|asset| asset.name == "latest.json")
        .map(|asset| asset.url)
}

async fn fetch_manifest_url(client: &Client, token: &str) -> Result<Option<String>, String> {
    let response = github_request(client, GITHUB_RELEASES_URL, token)
        .send()
        .await
        .map_err(|error| format!("GitHub releases could not be checked: {error}"))?;
    if response.status() == StatusCode::UNAUTHORIZED || response.status() == StatusCode::FORBIDDEN {
        return Err("GitHub rejected the embedded release token.".into());
    }
    if response.status() == StatusCode::NOT_FOUND {
        return Err("The embedded token cannot access the private repository.".into());
    }
    let releases = response
        .error_for_status()
        .map_err(|error| format!("GitHub releases could not be checked: {error}"))?
        .json::<Vec<GithubRelease>>()
        .await
        .map_err(|error| format!("GitHub release information could not be read: {error}"))?;
    Ok(latest_manifest_url(releases))
}

fn lock_pending(state: &UpdateState) -> Result<std::sync::MutexGuard<'_, Option<Update>>, String> {
    state
        .pending
        .lock()
        .map_err(|_| "The update state is unavailable.".into())
}

#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateCheckResult, String> {
    let Some(token) = embedded_update_token() else {
        return Ok(UpdateCheckResult::NotConfigured);
    };
    let Some(manifest_url) = fetch_manifest_url(&state.client, token).await? else {
        *lock_pending(&state)? = None;
        return Ok(UpdateCheckResult::UpToDate);
    };
    let endpoint = manifest_url
        .parse()
        .map_err(|error| format!("GitHub returned an invalid update URL: {error}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .header("Authorization", format!("Bearer {token}"))
        .map_err(|error| error.to_string())?
        .header("Accept", "application/octet-stream")
        .map_err(|error| error.to_string())?
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .map_err(|error| error.to_string())?
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;
    let Some(update) = update else {
        *lock_pending(&state)? = None;
        return Ok(UpdateCheckResult::UpToDate);
    };
    let result = UpdateCheckResult::Available {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
    };
    *lock_pending(&state)? = Some(update);
    Ok(result)
}

#[tauri::command]
pub async fn install_update(
    state: State<'_, UpdateState>,
    on_event: Channel<UpdateDownloadEvent>,
) -> Result<(), String> {
    let update = lock_pending(&state)?
        .take()
        .ok_or_else(|| "There is no pending update.".to_string())?;
    let progress_channel = on_event.clone();
    let finished_channel = on_event.clone();
    let mut started = false;
    update
        .download_and_install(
            move |chunk_length, content_length| {
                if !started {
                    let _ = progress_channel.send(UpdateDownloadEvent::Started { content_length });
                    started = true;
                }
                let _ = progress_channel.send(UpdateDownloadEvent::Progress { chunk_length });
            },
            move || {
                let _ = finished_channel.send(UpdateDownloadEvent::Finished);
            },
        )
        .await
        .map_err(|error| format!("The update could not be installed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{latest_manifest_url, GithubAsset, GithubRelease, UpdateCheckResult};

    #[test]
    fn serializes_update_contract_as_camel_case() {
        let value = serde_json::to_value(UpdateCheckResult::Available {
            version: "0.2.0".into(),
            current_version: "0.1.0".into(),
            notes: None,
        })
        .unwrap();
        assert_eq!(value["status"], "available");
        assert_eq!(value["currentVersion"], "0.1.0");
    }

    #[test]
    fn finds_manifest_in_latest_completed_release() {
        let releases = vec![
            GithubRelease {
                draft: true,
                assets: vec![GithubAsset {
                    name: "latest.json".into(),
                    url: "https://example.com/draft".into(),
                }],
            },
            GithubRelease {
                draft: false,
                assets: vec![GithubAsset {
                    name: "latest.json".into(),
                    url: "https://example.com/release".into(),
                }],
            },
        ];
        assert_eq!(
            latest_manifest_url(releases).as_deref(),
            Some("https://example.com/release")
        );
    }
}
