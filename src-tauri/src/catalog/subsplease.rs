use std::collections::HashSet;

use regex::Regex;
use serde_json::Value;
use tauri::State;

use super::{
    anilist::{has_series_prequel, validate_anilist_id},
    CatalogState,
};

const SUBSPLEASE_ORIGIN: &str = "https://subsplease.org";

#[derive(Debug, PartialEq)]
enum MetadataRequest<'a> {
    Id(i64),
    Title(&'a str),
}

pub(crate) fn validate_subsplease_slug(slug: &str) -> Result<(), String> {
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

fn subsplease_show_slug_from_link(href: &str) -> Option<String> {
    let href = href.trim();
    let path = if href.starts_with('/') {
        href.split(['?', '#']).next()?.to_owned()
    } else {
        let url = reqwest::Url::parse(href).ok()?;
        if url.scheme() != "https"
            || !url
                .host_str()
                .is_some_and(|host| host.eq_ignore_ascii_case("subsplease.org"))
            || url.port_or_known_default() != Some(443)
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return None;
        }
        url.path().to_owned()
    };
    let path = path.strip_suffix('/').unwrap_or(&path);
    let slug = path.strip_prefix("/shows/")?;
    validate_subsplease_slug(slug).ok()?;
    Some(slug.to_owned())
}

fn parse_subsplease_index(html: &str) -> Vec<Value> {
    let Ok(pattern) = Regex::new(r#"(?s)<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)</a>"#) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut shows = pattern
        .captures_iter(html)
        .filter_map(|captures| {
            let slug = subsplease_show_slug_from_link(captures.get(1)?.as_str())?;
            if !seen.insert(slug.clone()) {
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
            .and_then(Value::as_str)
            .unwrap_or_default();
        let right = right
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default();
        left.to_ascii_lowercase().cmp(&right.to_ascii_lowercase())
    });
    shows
}

fn metadata_request(
    include_metadata: bool,
    anilist_id: Option<i64>,
    title: &str,
) -> Option<MetadataRequest<'_>> {
    if !include_metadata {
        None
    } else {
        Some(match anilist_id {
            Some(id) => MetadataRequest::Id(id),
            None => MetadataRequest::Title(title),
        })
    }
}

async fn show_metadata(
    state: &CatalogState,
    request: Option<MetadataRequest<'_>>,
) -> Option<Value> {
    match request {
        Some(MetadataRequest::Id(id)) => state.anilist.metadata_by_id(id).await.ok().flatten(),
        Some(MetadataRequest::Title(title)) => {
            state.anilist.metadata_by_title(title).await.ok().flatten()
        }
        None => None,
    }
}

fn valid_release(release: &Value) -> bool {
    let Some(release) = release.as_object() else {
        return false;
    };
    if !["time", "release_date", "show", "episode"]
        .into_iter()
        .all(|field| release.get(field).and_then(Value::as_str).is_some())
    {
        return false;
    }
    let Some(downloads) = release.get("downloads").and_then(Value::as_array) else {
        return false;
    };
    !downloads.is_empty()
        && downloads.iter().all(|download| {
            let Some(download) = download.as_object() else {
                return false;
            };
            ["res", "torrent", "magnet"]
                .into_iter()
                .all(|field| download.get(field).and_then(Value::as_str).is_some())
                && download.get("xdcc").is_none_or(|value| value.is_string())
        })
}

fn normalize_releases(object: &mut serde_json::Map<String, Value>) -> Result<(), String> {
    for kind in ["episode", "batch"] {
        let releases = object
            .get_mut(kind)
            .ok_or_else(|| format!("SubsPlease did not return {kind} releases."))?;
        if releases.as_array().is_some_and(Vec::is_empty) {
            *releases = Value::Object(serde_json::Map::new());
        }
        let entries = releases
            .as_object()
            .ok_or_else(|| format!("SubsPlease returned invalid {kind} releases."))?;
        if !entries.values().all(valid_release) {
            return Err(format!("SubsPlease returned malformed {kind} releases."));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn subsplease_schedule(
    state: State<'_, CatalogState>,
    timezone: String,
) -> Result<Value, String> {
    validate_timezone(&timezone)?;
    let body = subsplease_text(
        state
            .http
            .get(format!("{SUBSPLEASE_ORIGIN}/api/"))
            .query(&[("f", "schedule"), ("tz", timezone.as_str())]),
    )
    .await?;
    let data: Value = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid schedule response: {error}"))?;
    if !data.get("schedule").is_some_and(Value::is_object) {
        return Err("SubsPlease did not return a weekly schedule.".into());
    }
    Ok(data)
}

#[tauri::command]
pub async fn subsplease_index(state: State<'_, CatalogState>) -> Result<Value, String> {
    let page = subsplease_text(state.http.get(format!("{SUBSPLEASE_ORIGIN}/shows/"))).await?;
    let shows = parse_subsplease_index(&page);
    if shows.is_empty() {
        return Err("SubsPlease did not return its show index.".into());
    }
    Ok(serde_json::json!({ "shows": shows }))
}

#[tauri::command]
pub async fn subsplease_show(
    state: State<'_, CatalogState>,
    slug: String,
    timezone: String,
    anilist_id: Option<i64>,
    include_metadata: Option<bool>,
) -> Result<Value, String> {
    validate_subsplease_slug(&slug)?;
    validate_timezone(&timezone)?;
    if let Some(id) = anilist_id {
        validate_anilist_id(id)?;
    }

    let page =
        subsplease_text(state.http.get(format!("{SUBSPLEASE_ORIGIN}/shows/{slug}/"))).await?;
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
    let releases_request =
        subsplease_text(state.http.get(format!("{SUBSPLEASE_ORIGIN}/api/")).query(&[
            ("f", "show"),
            ("tz", timezone.as_str()),
            ("sid", sid.as_str()),
        ]));
    let metadata_request = show_metadata(
        &state,
        metadata_request(include_metadata.unwrap_or(true), anilist_id, title.as_str()),
    );
    let (releases, metadata) = tokio::join!(releases_request, metadata_request);
    let releases = releases?;
    let mut data: Value = serde_json::from_str(&releases)
        .map_err(|error| format!("Invalid show response: {error}"))?;
    let object = data
        .as_object_mut()
        .ok_or_else(|| "SubsPlease did not return show details.".to_string())?;
    normalize_releases(object)?;
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
        .find_map(|path| metadata.pointer(path).and_then(Value::as_str))
        {
            object.insert("title".into(), canonical_title.into());
        }
        if let Some(description) = metadata.get("description").and_then(Value::as_str) {
            let clean_description = strip_html(description);
            if !clean_description.is_empty() {
                object.insert("synopsis".into(), clean_description.into());
            }
        }
        if let Some(cover) = metadata
            .pointer("/coverImage/extraLarge")
            .or_else(|| metadata.pointer("/coverImage/large"))
            .and_then(Value::as_str)
        {
            object.insert("image_url".into(), cover.into());
        }
        for (source, target) in [
            ("id", "metadata_id"),
            ("trailer", "trailer"),
            ("bannerImage", "banner_image_url"),
            ("genres", "genres"),
            ("season", "season"),
            ("seasonYear", "year"),
            ("startDate", "start_date"),
            ("endDate", "end_date"),
            ("format", "format"),
            ("status", "status"),
            ("episodes", "episode_count"),
            ("duration", "duration"),
            ("averageScore", "average_score"),
            ("popularity", "popularity"),
            ("source", "source"),
            ("countryOfOrigin", "country_of_origin"),
            ("tags", "tags"),
            ("studios", "studios"),
            ("nextAiringEpisode", "next_airing_episode"),
            ("streamingEpisodes", "streaming_episodes"),
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

#[cfg(test)]
mod tests {
    use super::{
        first_capture, metadata_request, normalize_releases, parse_subsplease_index, strip_html,
        validate_subsplease_slug, validate_timezone, MetadataRequest,
    };

    #[test]
    fn validates_subsplease_inputs() {
        assert!(validate_subsplease_slug("one-piece").is_ok());
        assert!(validate_subsplease_slug("../one-piece").is_err());
        assert!(validate_timezone("Europe/Amsterdam").is_ok());
        assert!(validate_timezone("Europe/Amsterdam?x=1").is_err());
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
            <a href="https://subsplease.org/shows/86-eighty-six/">86 - Eighty Six</a>
            <a href="/shows/mushoku-tensei-s3">Duplicate</a>
            <a href="https://example.com/shows/not-allowed">External</a>
            <a href="/shows/Not-Valid">Invalid</a>
        "#;
        let entries = parse_subsplease_index(html);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|entry| {
            entry.get("page").and_then(serde_json::Value::as_str) == Some("mushoku-tensei-s3")
        }));
        assert!(entries.iter().any(|entry| {
            entry.get("page").and_then(serde_json::Value::as_str) == Some("86-eighty-six")
        }));
    }

    #[test]
    fn normalizes_empty_provider_release_arrays_and_rejects_malformed_releases() {
        let mut empty = serde_json::json!({ "episode": [], "batch": {} });
        normalize_releases(empty.as_object_mut().unwrap()).unwrap();
        assert!(empty["episode"].is_object());
        assert!(empty["batch"].is_object());

        let mut malformed = serde_json::json!({
            "episode": { "bad": { "downloads": [] } },
            "batch": []
        });
        assert!(normalize_releases(malformed.as_object_mut().unwrap()).is_err());
    }

    #[test]
    fn known_anilist_ids_never_fall_back_to_title_matching() {
        assert_eq!(
            metadata_request(true, Some(42), "Different title"),
            Some(MetadataRequest::Id(42))
        );
        assert_eq!(
            metadata_request(true, None, "Title"),
            Some(MetadataRequest::Title("Title"))
        );
        assert_eq!(metadata_request(false, Some(42), "Title"), None);
    }
}
