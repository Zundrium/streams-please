use std::{collections::HashSet, path::PathBuf};

use librqbit::{
    api::{Api, TorrentIdOrHash},
    http_api::{HttpApi, HttpApiOptions},
    AddTorrent, AddTorrentOptions, Session,
};
use regex::Regex;
use serde::Serialize;
use tauri::{Manager, State};
use tokio::net::TcpListener;

const SUBSPLEASE_ORIGIN: &str = "https://subsplease.org";

struct TorrentState {
    api: Api,
    stream_port: u16,
    download_dir: PathBuf,
    subsplease_client: reqwest::Client,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    engine: &'static str,
    engine_version: &'static str,
    stream_port: u16,
    download_dir: String,
    mpv_available: bool,
    mpv_version: Option<String>,
    trailer_available: bool,
    trailer_runtime_version: Option<String>,
}

fn validate_magnet(magnet: &str) -> Result<(), String> {
    let trimmed = magnet.trim();
    if trimmed.len() > 32_768 {
        return Err("The magnet link is unexpectedly long.".into());
    }
    if !trimmed.starts_with("magnet:?") || !trimmed.contains("xt=urn:btih:") {
        return Err("Enter a valid BitTorrent magnet link with an info hash.".into());
    }
    Ok(())
}

fn validate_subsplease_slug(slug: &str) -> Result<(), String> {
    if slug.is_empty()
        || slug.len() > 160
        || !slug
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("Invalid SubsPlease show.".into());
    }
    Ok(())
}

fn validate_timezone(timezone: &str) -> Result<(), String> {
    if timezone.is_empty()
        || timezone.len() > 80
        || !timezone.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'-' | b'+' | b'.')
        })
    {
        return Err("Invalid time zone.".into());
    }
    Ok(())
}

fn validate_anilist_search(query: &str) -> Result<(), String> {
    let trimmed = query.trim();
    if trimmed.len() < 2 || trimmed.len() > 160 || trimmed.chars().any(char::is_control) {
        return Err("Enter at least two characters to search AniList.".into());
    }
    Ok(())
}

fn validate_anilist_season(season: &str, year: i32) -> Result<&'static str, String> {
    if !(1940..=2200).contains(&year) {
        return Err("Invalid AniList season year.".into());
    }
    match season.trim().to_ascii_uppercase().as_str() {
        "WINTER" => Ok("WINTER"),
        "SPRING" => Ok("SPRING"),
        "SUMMER" => Ok("SUMMER"),
        "FALL" => Ok("FALL"),
        _ => Err("Invalid AniList season.".into()),
    }
}

async fn subsplease_text(request: reqwest::RequestBuilder) -> Result<String, String> {
    request
        .send()
        .await
        .map_err(|error| format!("SubsPlease is unreachable: {error}"))?
        .error_for_status()
        .map_err(|error| format!("SubsPlease returned an error: {error}"))?
        .text()
        .await
        .map_err(|error| format!("The SubsPlease response could not be read: {error}"))
}

fn normalize_anilist_title(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        if character.is_alphanumeric() {
            if pending_space && !normalized.is_empty() {
                normalized.push(' ');
            }
            for lowercase in character.to_lowercase() {
                normalized.push(lowercase);
            }
            pending_space = false;
        } else {
            pending_space = true;
        }
    }
    normalized
        .split_whitespace()
        .map(|token| {
            token
                .strip_prefix('s')
                .filter(|season| {
                    !season.is_empty() && season.chars().all(|character| character.is_ascii_digit())
                })
                .unwrap_or(token)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn anilist_search_queries(title: &str) -> [String; 3] {
    let exact = title.trim().to_owned();
    let normalized = normalize_anilist_title(title);
    let boundary = title.char_indices().find_map(|(index, character)| {
        if index >= 4 && matches!(character, '.' | ':' | '!' | '?' | '–' | '—') {
            Some(index)
        } else {
            None
        }
    });
    let mut short = boundary
        .map(|index| normalize_anilist_title(&title[..index]))
        .unwrap_or_default();
    if short.split_whitespace().count() < 2 {
        short = normalized
            .split_whitespace()
            .take(4)
            .collect::<Vec<_>>()
            .join(" ");
    }
    if short.is_empty() {
        short = normalized.clone();
    }
    [exact, normalized, short]
}

fn anilist_title_similarity(source: &str, candidate: &str) -> f64 {
    let source = normalize_anilist_title(source);
    let candidate = normalize_anilist_title(candidate);
    if source.is_empty() || candidate.is_empty() {
        return 0.0;
    }

    let source_compact = source.replace(' ', "");
    let candidate_compact = candidate.replace(' ', "");
    if source_compact == candidate_compact {
        return 1.0;
    }

    let source_tokens = source.split_whitespace().collect::<HashSet<_>>();
    let candidate_tokens = candidate.split_whitespace().collect::<HashSet<_>>();
    let shared = source_tokens.intersection(&candidate_tokens).count() as f64;
    let token_score = (2.0 * shared) / (source_tokens.len() + candidate_tokens.len()) as f64;
    let containment_score = if source_compact.contains(&candidate_compact)
        || candidate_compact.contains(&source_compact)
    {
        let coverage = source_compact.len().min(candidate_compact.len()) as f64
            / source_compact.len().max(candidate_compact.len()) as f64;
        0.72 + (0.2 * coverage)
    } else {
        0.0
    };
    token_score.max(containment_score)
}

fn anilist_candidate_score(source: &str, candidate: &serde_json::Value) -> f64 {
    let mut titles = Vec::new();
    for path in ["/title/romaji", "/title/english", "/title/native"] {
        if let Some(title) = candidate.pointer(path).and_then(serde_json::Value::as_str) {
            titles.push(title);
        }
    }
    if let Some(synonyms) = candidate
        .get("synonyms")
        .and_then(serde_json::Value::as_array)
    {
        titles.extend(synonyms.iter().filter_map(serde_json::Value::as_str));
    }
    titles
        .into_iter()
        .map(|title| anilist_title_similarity(source, title))
        .fold(0.0, f64::max)
}

fn has_series_prequel(metadata: &serde_json::Value) -> bool {
    metadata
        .pointer("/relations/edges")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|edges| {
            edges.iter().any(|edge| {
                edge.get("relationType").and_then(serde_json::Value::as_str) == Some("PREQUEL")
                    && edge
                        .pointer("/node/type")
                        .and_then(serde_json::Value::as_str)
                        == Some("ANIME")
                    && matches!(
                        edge.pointer("/node/format")
                            .and_then(serde_json::Value::as_str),
                        Some("TV" | "TV_SHORT" | "ONA")
                    )
            })
        })
}

async fn anilist_metadata(client: &reqwest::Client, title: &str) -> Option<serde_json::Value> {
    let [exact, normalized, short] = anilist_search_queries(title);
    let payload = serde_json::json!({
        "query": r#"
            query ($exact: String!, $normalized: String!, $short: String!) {
                exact: Page(page: 1, perPage: 6) {
                  media(search: $exact, type: ANIME) {
                    ...Metadata
                  }
                }
                normalized: Page(page: 1, perPage: 6) {
                  media(search: $normalized, type: ANIME) {
                    ...Metadata
                  }
                }
                short: Page(page: 1, perPage: 6) {
                  media(search: $short, type: ANIME) {
                    ...Metadata
                  }
                }
            }
            fragment Metadata on Media {
                    id
                    idMal
                    title { romaji english native userPreferred }
                    synonyms
                    description(asHtml: false)
                    trailer { id site thumbnail }
                    coverImage { extraLarge large }
                    bannerImage
                    genres
                    seasonYear
                    format
                    status
                    episodes
                    siteUrl
                    relations {
                        edges {
                            relationType
                            node {
                                id
                                type
                                format
                                status
                                season
                                seasonYear
                                title { romaji english native userPreferred }
                                synonyms
                                coverImage { extraLarge large color }
                                siteUrl
                            }
                        }
                    }
            }
        "#,
        "variables": { "exact": exact, "normalized": normalized, "short": short }
    });
    let response = client
        .post("https://graphql.anilist.co")
        .header("Accept", "application/json")
        .json(&payload)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let payload = response.json::<serde_json::Value>().await.ok()?;
    let mut seen = HashSet::new();
    let mut best: Option<(f64, serde_json::Value)> = None;
    for key in ["exact", "normalized", "short"] {
        let Some(candidates) = payload
            .pointer(&format!("/data/{key}/media"))
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        for candidate in candidates {
            let id = candidate.get("id").and_then(serde_json::Value::as_i64);
            if id.is_some_and(|id| !seen.insert(id)) {
                continue;
            }
            let score = anilist_candidate_score(title, candidate);
            if best
                .as_ref()
                .is_none_or(|(best_score, _)| score > *best_score)
            {
                best = Some((score, candidate.clone()));
            }
        }
    }
    best.filter(|(score, _)| *score >= 0.62)
        .map(|(_, metadata)| metadata)
}

async fn anilist_metadata_by_id(client: &reqwest::Client, id: i64) -> Option<serde_json::Value> {
    if id <= 0 {
        return None;
    }
    let payload = serde_json::json!({
        "query": r#"
            query ($id: Int!) {
                Media(id: $id, type: ANIME) {
                    id
                    idMal
                    title { romaji english native userPreferred }
                    synonyms
                    description(asHtml: false)
                    trailer { id site thumbnail }
                    coverImage { extraLarge large color }
                    bannerImage
                    genres
                    season
                    seasonYear
                    startDate { year month day }
                    endDate { year month day }
                    format
                    status
                    episodes
                    duration
                    siteUrl
                    nextAiringEpisode { episode airingAt timeUntilAiring }
                    relations {
                        edges {
                            relationType
                            node {
                                id
                                type
                                format
                                status
                                season
                                seasonYear
                                title { romaji english native userPreferred }
                                synonyms
                                coverImage { extraLarge large color }
                                siteUrl
                            }
                        }
                    }
                }
            }
        "#,
        "variables": { "id": id }
    });
    let response = client
        .post("https://graphql.anilist.co")
        .header("Accept", "application/json")
        .json(&payload)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    response
        .json::<serde_json::Value>()
        .await
        .ok()?
        .pointer("/data/Media")
        .cloned()
}

fn first_capture(pattern: &str, html: &str) -> Option<String> {
    Regex::new(pattern)
        .ok()?
        .captures(html)?
        .get(1)
        .map(|value| value.as_str().trim().to_owned())
}

fn strip_html(value: &str) -> String {
    Regex::new(r"<[^>]+>")
        .map(|pattern| pattern.replace_all(value, " ").into_owned())
        .unwrap_or_else(|_| value.to_owned())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_subsplease_index(html: &str) -> Vec<serde_json::Value> {
    let Ok(pattern) = Regex::new(r#"(?s)<a[^>]*href=["']/shows/([^"'/?#]+)/?["'][^>]*>(.*?)</a>"#)
    else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut shows = pattern
        .captures_iter(html)
        .filter_map(|captures| {
            let slug = captures.get(1)?.as_str().trim();
            if !seen.insert(slug.to_owned()) {
                return None;
            }
            let title = strip_html(captures.get(2)?.as_str());
            if title.is_empty() {
                return None;
            }
            Some(serde_json::json!({ "title": title, "page": slug }))
        })
        .collect::<Vec<_>>();
    shows.sort_by(|left, right| {
        let left = left
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let right = right
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        left.to_ascii_lowercase().cmp(&right.to_ascii_lowercase())
    });
    shows
}

#[tauri::command]
async fn subsplease_schedule(
    state: State<'_, TorrentState>,
    timezone: String,
) -> Result<serde_json::Value, String> {
    validate_timezone(&timezone)?;
    let body = subsplease_text(
        state
            .subsplease_client
            .get(format!("{SUBSPLEASE_ORIGIN}/api/"))
            .query(&[("f", "schedule"), ("tz", timezone.as_str())]),
    )
    .await?;
    let data: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid schedule response: {error}"))?;
    if !data
        .get("schedule")
        .is_some_and(serde_json::Value::is_object)
    {
        return Err("SubsPlease did not return a weekly schedule.".into());
    }
    Ok(data)
}

#[tauri::command]
async fn subsplease_index(state: State<'_, TorrentState>) -> Result<serde_json::Value, String> {
    let page = subsplease_text(
        state
            .subsplease_client
            .get(format!("{SUBSPLEASE_ORIGIN}/shows/")),
    )
    .await?;
    let shows = parse_subsplease_index(&page);
    if shows.is_empty() {
        return Err("SubsPlease did not return its show index.".into());
    }
    Ok(serde_json::json!({ "shows": shows }))
}

#[tauri::command]
async fn anilist_season(
    state: State<'_, TorrentState>,
    season: String,
    year: i32,
) -> Result<serde_json::Value, String> {
    let season = validate_anilist_season(&season, year)?;
    let query = r#"
        query ($season: MediaSeason!, $year: Int!) {
            page1: Page(page: 1, perPage: 50) { media(type: ANIME, season: $season, seasonYear: $year, format_in: [TV, TV_SHORT, ONA], isAdult: false, sort: [POPULARITY_DESC, START_DATE]) { ...SeasonCard } }
            page2: Page(page: 2, perPage: 50) { media(type: ANIME, season: $season, seasonYear: $year, format_in: [TV, TV_SHORT, ONA], isAdult: false, sort: [POPULARITY_DESC, START_DATE]) { ...SeasonCard } }
            page3: Page(page: 3, perPage: 50) { media(type: ANIME, season: $season, seasonYear: $year, format_in: [TV, TV_SHORT, ONA], isAdult: false, sort: [POPULARITY_DESC, START_DATE]) { ...SeasonCard } }
        }
        fragment SeasonCard on Media {
            id
            title { romaji english native userPreferred }
            synonyms
            coverImage { extraLarge large color }
            season
            seasonYear
            startDate { year month day }
            endDate { year month day }
            format
            status
            episodes
            nextAiringEpisode { episode airingAt timeUntilAiring }
        }
    "#;
    let payload = serde_json::json!({
        "query": query,
        "variables": { "season": season, "year": year }
    });
    let response = state
        .subsplease_client
        .post("https://graphql.anilist.co")
        .header("Accept", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("AniList is unreachable: {error}"))?
        .error_for_status()
        .map_err(|error| format!("AniList returned an error: {error}"))?;
    let response = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("The AniList response could not be read: {error}"))?;
    if let Some(error) = response
        .get("errors")
        .and_then(serde_json::Value::as_array)
        .and_then(|errors| errors.first())
        .and_then(|error| error.get("message"))
        .and_then(serde_json::Value::as_str)
    {
        return Err(format!("AniList returned an error: {error}"));
    }
    let mut shows = Vec::new();
    for page in ["page1", "page2", "page3"] {
        if let Some(page_shows) = response
            .pointer(&format!("/data/{page}/media"))
            .and_then(serde_json::Value::as_array)
        {
            shows.extend(page_shows.iter().cloned());
        }
    }
    Ok(serde_json::json!({ "season": season, "year": year, "shows": shows }))
}

#[tauri::command]
async fn anilist_search(
    state: State<'_, TorrentState>,
    query: String,
) -> Result<serde_json::Value, String> {
    validate_anilist_search(&query)?;
    let payload = serde_json::json!({
        "query": r#"
            query ($search: String!) {
                Page(page: 1, perPage: 10) {
                    media(search: $search, type: ANIME) {
                        id
                        title { romaji english native }
                        synonyms
                    }
                }
            }
        "#,
        "variables": { "search": query.trim() }
    });
    let response = state
        .subsplease_client
        .post("https://graphql.anilist.co")
        .header("Accept", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("AniList is unreachable: {error}"))?
        .error_for_status()
        .map_err(|error| format!("AniList returned an error: {error}"))?;
    let response = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("The AniList response could not be read: {error}"))?;
    Ok(response
        .pointer("/data/Page/media")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([])))
}

#[tauri::command]
async fn subsplease_show(
    state: State<'_, TorrentState>,
    slug: String,
    timezone: String,
    anilist_id: Option<i64>,
) -> Result<serde_json::Value, String> {
    validate_subsplease_slug(&slug)?;
    validate_timezone(&timezone)?;

    let page = subsplease_text(
        state
            .subsplease_client
            .get(format!("{SUBSPLEASE_ORIGIN}/shows/{slug}/")),
    )
    .await?;
    let sid = first_capture(
        r#"(?s)id=[\"']show-release-table[\"'][^>]*sid=[\"'](\d+)[\"']"#,
        &page,
    )
    .ok_or_else(|| "The show ID is missing from SubsPlease.".to_string())?;
    let title = first_capture(
        r#"(?s)<h1[^>]*class=[\"']entry-title[\"'][^>]*>(.*?)</h1>"#,
        &page,
    )
    .map(|value| strip_html(&value))
    .unwrap_or_else(|| slug.replace('-', " "));
    let synopsis = first_capture(
        r#"(?s)<div[^>]*class=[\"']series-syn[\"'][^>]*>.*?<p>(.*?)</p>"#,
        &page,
    )
    .map(|value| strip_html(&value))
    .unwrap_or_default();
    let image_url = first_capture(
        r#"<img[^>]*class=[\"'][^\"']*img-responsive img-center[^\"']*[\"'][^>]*src=[\"']([^\"']+)[\"']"#,
        &page,
    )
    .unwrap_or_default();
    let mut metadata = match anilist_id {
        Some(id) => anilist_metadata_by_id(&state.subsplease_client, id).await,
        None => None,
    };
    if metadata.is_none() {
        metadata = anilist_metadata(&state.subsplease_client, &title).await;
    }

    let releases = subsplease_text(
        state
            .subsplease_client
            .get(format!("{SUBSPLEASE_ORIGIN}/api/"))
            .query(&[
                ("f", "show"),
                ("tz", timezone.as_str()),
                ("sid", sid.as_str()),
            ]),
    )
    .await?;
    let mut data: serde_json::Value = serde_json::from_str(&releases)
        .map_err(|error| format!("Invalid show response: {error}"))?;
    let object = data
        .as_object_mut()
        .ok_or_else(|| "SubsPlease did not return show details.".to_string())?;
    object.insert("title".into(), title.into());
    object.insert("synopsis".into(), synopsis.into());
    object.insert("image_url".into(), image_url.into());
    object.insert("slug".into(), slug.into());
    if let Ok(subsplease_id) = sid.parse::<i64>() {
        object.insert("subsplease_id".into(), subsplease_id.into());
    }
    if let Some(metadata) = metadata {
        if let Some(canonical_title) = [
            "/title/english",
            "/title/userPreferred",
            "/title/romaji",
            "/title/native",
        ]
        .into_iter()
        .find_map(|path| metadata.pointer(path).and_then(serde_json::Value::as_str))
        {
            object.insert("title".into(), canonical_title.into());
        }
        if let Some(description) = metadata
            .get("description")
            .and_then(serde_json::Value::as_str)
        {
            let clean_description = strip_html(description);
            if !clean_description.is_empty() {
                object.insert("synopsis".into(), clean_description.into());
            }
        }
        if let Some(cover) = metadata
            .pointer("/coverImage/extraLarge")
            .or_else(|| metadata.pointer("/coverImage/large"))
            .and_then(serde_json::Value::as_str)
        {
            object.insert("image_url".into(), cover.into());
        }
        for (source, target) in [
            ("id", "metadata_id"),
            ("trailer", "trailer"),
            ("bannerImage", "banner_image_url"),
            ("genres", "genres"),
            ("seasonYear", "year"),
            ("format", "format"),
            ("status", "status"),
            ("episodes", "episode_count"),
            ("siteUrl", "metadata_url"),
            ("relations", "relations"),
        ] {
            if let Some(value) = metadata.get(source).filter(|value| !value.is_null()) {
                object.insert(target.into(), value.clone());
            }
        }
        object.insert(
            "has_series_prequel".into(),
            has_series_prequel(&metadata).into(),
        );
        object.insert("metadata_source".into(), "AniList".into());
    }
    Ok(data)
}

fn runtime_search_dirs(app: Option<&tauri::AppHandle>) -> Vec<PathBuf> {
    let mut search_dirs = Vec::new();

    if let Some(app) = app {
        if let Ok(resource_dir) = app.path().resource_dir() {
            search_dirs.push(resource_dir.join("lib"));
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(executable_dir) = executable.parent() {
            search_dirs.push(executable_dir.join("lib"));
        }
    }
    if cfg!(debug_assertions) {
        search_dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("lib"));
    }

    search_dirs
}

fn libmpv_available(app: &tauri::AppHandle) -> bool {
    runtime_search_dirs(Some(app)).into_iter().any(|directory| {
        #[cfg(target_os = "windows")]
        return directory.join("libmpv-wrapper.dll").is_file()
            && directory.join("libmpv-2.dll").is_file();

        #[cfg(target_os = "macos")]
        return directory.join("libmpv-wrapper.dylib").is_file();

        #[cfg(target_os = "linux")]
        return directory.join("libmpv-wrapper.so").is_file();

        #[allow(unreachable_code)]
        false
    })
}

fn trailer_runtime_dir(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
    runtime_search_dirs(app).into_iter().find(|directory| {
        #[cfg(target_os = "windows")]
        return directory.join("yt-dlp.exe").is_file() && directory.join("deno.exe").is_file();

        #[cfg(not(target_os = "windows"))]
        return directory.join("yt-dlp").is_file() && directory.join("deno").is_file();
    })
}

fn configure_bundled_media_tools() {
    let Some(directory) = trailer_runtime_dir(None) else {
        return;
    };
    let mut paths = vec![directory];
    if let Some(current_path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&current_path));
    }
    if let Ok(path) = std::env::join_paths(paths) {
        std::env::set_var("PATH", path);
    }
}

#[tauri::command]
fn runtime_info(app: tauri::AppHandle, state: State<'_, TorrentState>) -> RuntimeInfo {
    let mpv_available = libmpv_available(&app);
    let mpv_version = mpv_available.then(|| "libmpv (in-process)".to_string());
    let trailer_available = trailer_runtime_dir(Some(&app)).is_some();

    RuntimeInfo {
        engine: "librqbit",
        engine_version: librqbit::version(),
        stream_port: state.stream_port,
        download_dir: state.download_dir.to_string_lossy().into_owned(),
        mpv_available,
        mpv_version,
        trailer_available,
        trailer_runtime_version: trailer_available
            .then(|| "yt-dlp 2026.07.04 + Deno 2.9.3".to_string()),
    }
}

#[tauri::command]
async fn add_magnet(
    state: State<'_, TorrentState>,
    magnet: String,
) -> Result<serde_json::Value, String> {
    validate_magnet(&magnet)?;
    let api = state.api.clone();
    let options = AddTorrentOptions {
        // Avoid downloading artwork, archives, checksums, and other unrelated files.
        only_files_regex: Some(
            r"(?i)\.(mkv|mk3d|mp4|m4v|mov|webm|avi|ts|m2ts|srt|vtt|ass|ssa)$".into(),
        ),
        overwrite: true,
        ..Default::default()
    };

    let response = api
        .api_add_torrent(AddTorrent::from_url(magnet.trim()), Some(options))
        .await
        .map_err(|error| format!("The torrent could not be started: {error}"))?;

    serde_json::to_value(response).map_err(|error| error.to_string())
}

#[tauri::command]
fn torrent_details(state: State<'_, TorrentState>, id: usize) -> Result<serde_json::Value, String> {
    let response = state
        .api
        .api_torrent_details(TorrentIdOrHash::Id(id))
        .map_err(|error| error.to_string())?;
    serde_json::to_value(response).map_err(|error| error.to_string())
}

fn parse_have_pieces(debug_bitfield: &str) -> Vec<bool> {
    let Some(start) = debug_bitfield.rfind('[') else {
        return Vec::new();
    };
    let Some(end) = debug_bitfield.rfind(']') else {
        return Vec::new();
    };
    if end <= start {
        return Vec::new();
    }

    debug_bitfield[start + 1..end]
        .split(',')
        .filter_map(|value| match value.trim() {
            "0" => Some(false),
            "1" => Some(true),
            _ => None,
        })
        .collect()
}

#[tauri::command]
fn torrent_status(state: State<'_, TorrentState>, id: usize) -> Result<serde_json::Value, String> {
    let response = state
        .api
        .api_stats_v1(TorrentIdOrHash::Id(id))
        .map_err(|error| error.to_string())?;
    let mut value = serde_json::to_value(response).map_err(|error| error.to_string())?;

    if let Ok(debug_bitfield) = state.api.api_dump_haves(TorrentIdOrHash::Id(id)) {
        let pieces = parse_have_pieces(&debug_bitfield);
        if !pieces.is_empty() {
            value
                .as_object_mut()
                .ok_or_else(|| "Torrent stats did not serialize to an object.".to_string())?
                .insert(
                    "pieces".to_string(),
                    serde_json::to_value(pieces).map_err(|error| error.to_string())?,
                );
        }
    }

    Ok(value)
}

#[tauri::command]
async fn stream_url(
    state: State<'_, TorrentState>,
    id: usize,
    file_id: usize,
) -> Result<String, String> {
    let stream = state
        .api
        .api_stream(TorrentIdOrHash::Id(id), file_id)
        .map_err(|error| format!("The video file cannot be streamed: {error}"))?;
    if stream.len() == 0 {
        return Err("The selected video file is empty.".into());
    }

    Ok(format!(
        "http://127.0.0.1:{}/torrents/{id}/stream/{file_id}",
        state.stream_port
    ))
}

#[tauri::command]
async fn pause_torrent(state: State<'_, TorrentState>, id: usize) -> Result<(), String> {
    let api = state.api.clone();
    api.api_torrent_action_pause(TorrentIdOrHash::Id(id))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn resume_torrent(state: State<'_, TorrentState>, id: usize) -> Result<(), String> {
    let api = state.api.clone();
    api.api_torrent_action_start(TorrentIdOrHash::Id(id))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn forget_torrent(state: State<'_, TorrentState>, id: usize) -> Result<(), String> {
    let api = state.api.clone();
    api.api_torrent_action_forget(TorrentIdOrHash::Id(id))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn create_torrent_state(app: &tauri::AppHandle) -> Result<TorrentState, String> {
    let download_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("media");
    std::fs::create_dir_all(&download_dir).map_err(|error| error.to_string())?;

    tauri::async_runtime::block_on(async {
        let session = Session::new(download_dir.clone())
            .await
            .map_err(|error| error.to_string())?;
        let api = Api::new(session, None, None);
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| error.to_string())?;
        let stream_port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();

        let server = HttpApi::new(
            api.clone(),
            Some(HttpApiOptions {
                read_only: true,
                basic_auth: None,
            }),
        );
        tauri::async_runtime::spawn(async move {
            if let Err(error) = server.make_http_api_and_run(listener, None).await {
                eprintln!("local torrent stream server stopped: {error:#}");
            }
        });

        Ok(TorrentState {
            api,
            stream_port,
            download_dir,
            subsplease_client: reqwest::Client::builder()
                .user_agent("StreamsPlease/0.1 (+local desktop client)")
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .map_err(|error| error.to_string())?,
        })
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_bundled_media_tools();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_libmpv::init())
        .setup(|app| {
            let state = create_torrent_state(app.handle())
                .map_err(|error| format!("initializing torrent engine: {error}"))?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            add_magnet,
            torrent_details,
            torrent_status,
            stream_url,
            pause_torrent,
            resume_torrent,
            forget_torrent,
            subsplease_schedule,
            subsplease_index,
            subsplease_show,
            anilist_season,
            anilist_search,
        ])
        .run(tauri::generate_context!())
        .expect("error while running StreamsPlease");
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::trailer_runtime_dir;
    use super::{
        anilist_search_queries, anilist_title_similarity, first_capture, has_series_prequel,
        normalize_anilist_title, parse_have_pieces, parse_subsplease_index, strip_html,
        validate_anilist_search, validate_anilist_season, validate_magnet,
        validate_subsplease_slug, validate_timezone,
    };

    #[cfg(target_os = "windows")]
    #[test]
    fn bundled_trailer_runtime_is_present_for_desktop_development() {
        assert!(trailer_runtime_dir(None).is_some());
    }

    #[test]
    fn accepts_v1_magnet_links() {
        assert!(validate_magnet("magnet:?xt=urn:btih:0123456789abcdef").is_ok());
    }

    #[test]
    fn rejects_non_magnet_input() {
        assert!(validate_magnet("https://example.com/video.mkv").is_err());
    }

    #[test]
    fn parses_librqbit_have_piece_debug_output() {
        let debug =
            "BitSlice<u8, bitvec::order::Msb0> { addr: 0x1, head: 000, bits: 5 } [1, 0, 1, 1, 0]";
        assert_eq!(
            parse_have_pieces(debug),
            vec![true, false, true, true, false]
        );
        assert!(parse_have_pieces("not a bitfield").is_empty());
    }

    #[test]
    fn validates_subsplease_inputs() {
        assert!(validate_subsplease_slug("one-piece").is_ok());
        assert!(validate_subsplease_slug("../one-piece").is_err());
        assert!(validate_timezone("Europe/Amsterdam").is_ok());
        assert!(validate_timezone("Europe/Amsterdam?x=1").is_err());
    }

    #[test]
    fn validates_anilist_search_input() {
        assert!(validate_anilist_search("Young Ladies").is_ok());
        assert!(validate_anilist_search("x").is_err());
        assert!(validate_anilist_search("title\nquery").is_err());
    }

    #[test]
    fn validates_anilist_season_input() {
        assert_eq!(validate_anilist_season("summer", 2026), Ok("SUMMER"));
        assert!(validate_anilist_season("monsoon", 2026).is_err());
        assert!(validate_anilist_season("spring", 1200).is_err());
    }

    #[test]
    fn removes_markup_from_synopsis() {
        assert_eq!(strip_html("A <b>short</b>  synopsis."), "A short synopsis.");
    }

    #[test]
    fn finds_show_id_in_subsplease_table() {
        let html = r#"<table id="show-release-table" cellpadding="0" sid="476"></table>"#;
        assert_eq!(
            first_capture(
                r#"(?s)id=[\"']show-release-table[\"'][^>]*sid=[\"'](\d+)[\"']"#,
                html,
            )
            .as_deref(),
            Some("476")
        );
    }

    #[test]
    fn parses_unique_subsplease_archive_entries() {
        let html = r#"
            <a href="/shows/mushoku-tensei-s3">Mushoku Tensei S3</a>
            <a href="/shows/86-eighty-six">86 - Eighty Six</a>
            <a href="/shows/mushoku-tensei-s3">Duplicate</a>
        "#;
        let entries = parse_subsplease_index(html);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|entry| {
            entry.get("page").and_then(serde_json::Value::as_str) == Some("mushoku-tensei-s3")
        }));
    }

    #[test]
    fn normalizes_anilist_title_punctuation_and_spacing() {
        assert_eq!(
            normalize_anilist_title("Tai-Ari deshita.: Ojou-sama wa Kakutou Game nante Shinai"),
            "tai ari deshita ojou sama wa kakutou game nante shinai"
        );
    }

    #[test]
    fn normalizes_anilist_season_abbreviations() {
        assert_eq!(
            normalize_anilist_title("Quanzhi Fashi S7"),
            "quanzhi fashi 7"
        );
        assert_eq!(
            anilist_title_similarity("Quanzhi Fashi S7", "Quanzhi Fashi 7"),
            1.0
        );
    }

    #[test]
    fn identifies_series_prequels_but_ignores_movie_prequels() {
        let sequel = serde_json::json!({
            "relations": { "edges": [{
                "relationType": "PREQUEL",
                "node": { "type": "ANIME", "format": "TV" }
            }] }
        });
        let movie_prequel = serde_json::json!({
            "relations": { "edges": [{
                "relationType": "PREQUEL",
                "node": { "type": "ANIME", "format": "MOVIE" }
            }] }
        });
        assert!(has_series_prequel(&sequel));
        assert!(!has_series_prequel(&movie_prequel));
    }

    #[test]
    fn creates_a_short_anilist_fallback_query() {
        let queries =
            anilist_search_queries("Tai-Ari deshita. Ojousama wa Kakutou Game nante Shinai");
        assert_eq!(queries[2], "tai ari deshita");
    }

    #[test]
    fn matches_romanization_spacing_variants() {
        let score = anilist_title_similarity(
            "Tai-Ari deshita. Ojousama wa Kakutou Game nante Shinai",
            "Tai-Ari deshita.: Ojou-sama wa Kakutou Game nante Shinai",
        );
        assert_eq!(score, 1.0);
    }
}
