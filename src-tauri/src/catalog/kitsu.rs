use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use super::{
    identity::{IdentityResolver, ProviderId},
    AdapterFuture, CatalogAdapter, CatalogCapability, CatalogCoverImage, CatalogMedia,
    CatalogProvider, CatalogRequest, CatalogResponse, CatalogSeason, CatalogTitle,
};

const KITSU_API_BASE: &str = "https://kitsu.io/api/edge/";
const KITSU_REQUEST_INTERVAL: Duration = Duration::from_millis(1_100);
const KITSU_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const KITSU_CACHE_LIMIT: usize = 128;
const KITSU_MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const KITSU_PAGE_LIMIT: usize = 20;
const KITSU_MAX_SEASON_PAGES: usize = 4;
const KITSU_MAX_REPORTED_OFFSET: usize = 1_000_000;
const KITSU_DEFAULT_RATE_COOLDOWN_SECONDS: u64 = 30;
const KITSU_MAX_RATE_COOLDOWN_SECONDS: u64 = 5 * 60;
const KITSU_NETWORK_COOLDOWN: Duration = Duration::from_secs(30);
const KITSU_SERVER_COOLDOWN: Duration = Duration::from_secs(60);
const KITSU_FORBIDDEN_COOLDOWN: Duration = Duration::from_secs(5 * 60);

const CAPABILITIES: &[CatalogCapability] = &[CatalogCapability::Search, CatalogCapability::Season];

struct CacheEntry {
    expires_at: Instant,
    value: Value,
}

struct RequestControl {
    cache: HashMap<String, CacheEntry>,
    cooldown_until: Option<Instant>,
    next_request_at: Instant,
}

struct KitsuClient {
    http: reqwest::Client,
    in_flight: Semaphore,
    control: Mutex<RequestControl>,
}

pub(super) struct KitsuAdapter {
    client: KitsuClient,
    identity: Arc<IdentityResolver>,
}

#[derive(Deserialize)]
struct KitsuPage {
    data: Vec<KitsuAnime>,
    links: KitsuLinks,
}

#[derive(Deserialize)]
struct KitsuLinks {
    first: String,
    #[serde(default)]
    next: Option<String>,
    last: String,
}

#[derive(Deserialize, Serialize)]
struct KitsuAnime {
    id: String,
    #[serde(rename = "type")]
    resource_type: String,
    attributes: KitsuAttributes,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct KitsuAttributes {
    slug: String,
    #[serde(default)]
    synopsis: Option<String>,
    #[serde(default)]
    description: Option<String>,
    titles: BTreeMap<String, String>,
    canonical_title: String,
    #[serde(default)]
    abbreviated_titles: Vec<String>,
    #[serde(default)]
    average_rating: Option<String>,
    user_count: i64,
    #[serde(default)]
    start_date: Option<String>,
    #[serde(default)]
    end_date: Option<String>,
    subtype: String,
    status: String,
    #[serde(default)]
    poster_image: Option<KitsuImageSet>,
    #[serde(default)]
    cover_image: Option<KitsuImageSet>,
    #[serde(default)]
    episode_count: Option<i64>,
    #[serde(default)]
    episode_length: Option<i64>,
    #[serde(default)]
    youtube_video_id: Option<String>,
    nsfw: bool,
}

#[derive(Default, Deserialize, Serialize)]
struct KitsuImageSet {
    #[serde(default)]
    tiny: Option<String>,
    #[serde(default)]
    small: Option<String>,
    #[serde(default)]
    medium: Option<String>,
    #[serde(default)]
    large: Option<String>,
    #[serde(default)]
    original: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct KitsuDate {
    year: i32,
    month: u32,
    day: u32,
}

impl KitsuAdapter {
    pub(super) fn new(http: reqwest::Client, identity: Arc<IdentityResolver>) -> Self {
        Self {
            client: KitsuClient::new(http),
            identity,
        }
    }

    async fn search(
        &self,
        query: &str,
        cache_dir: &std::path::Path,
    ) -> Result<(Vec<CatalogMedia>, Vec<String>), String> {
        let url = kitsu_search_url(query)?;
        let payload = self.client.request(url.clone()).await?;
        let page = parse_kitsu_page(payload, &url, 0, KITSU_PAGE_LIMIT)?;
        let mut warnings = Vec::new();
        if page.links.next.is_some() {
            warnings.push(format!(
                "Kitsu search results were limited to {KITSU_PAGE_LIMIT} items."
            ));
        }
        self.map_results(page.data, None, cache_dir, warnings).await
    }

    async fn season(
        &self,
        season: CatalogSeason,
        year: i32,
        cache_dir: &std::path::Path,
    ) -> Result<(Vec<CatalogMedia>, Vec<String>), String> {
        let mut anime = Vec::new();
        let mut warnings = Vec::new();
        for page_number in 0..KITSU_MAX_SEASON_PAGES {
            let offset = page_number * KITSU_PAGE_LIMIT;
            let url = kitsu_season_url(season, year, offset)?;
            let page = match self
                .client
                .request(url.clone())
                .await
                .and_then(|payload| parse_kitsu_page(payload, &url, offset, KITSU_PAGE_LIMIT))
            {
                Ok(page) => page,
                Err(error) => match kitsu_season_page_failure(anime.len(), error) {
                    Ok(warning) => {
                        warnings.push(warning);
                        break;
                    }
                    Err(error) => return Err(error),
                },
            };
            let has_next_page = page.links.next.is_some();
            anime.extend(page.data);
            if !has_next_page {
                break;
            }
            if page_number + 1 == KITSU_MAX_SEASON_PAGES {
                warnings.push(format!(
                    "Kitsu season results were truncated after {KITSU_MAX_SEASON_PAGES} pages ({} items maximum).",
                    KITSU_MAX_SEASON_PAGES * KITSU_PAGE_LIMIT
                ));
            }
        }
        self.map_results(anime, Some((season, year)), cache_dir, warnings)
            .await
    }

    async fn map_results(
        &self,
        anime: Vec<KitsuAnime>,
        requested_season: Option<(CatalogSeason, i32)>,
        cache_dir: &std::path::Path,
        mut warnings: Vec<String>,
    ) -> Result<(Vec<CatalogMedia>, Vec<String>), String> {
        let mut adult = 0;
        let mut outside_season = 0;
        let mut valid = Vec::new();
        let mut seen = HashSet::new();
        for item in anime {
            validate_kitsu_anime(&item)?;
            if item.attributes.nsfw {
                adult += 1;
                continue;
            }
            if requested_season
                .is_some_and(|(season, year)| !matches_requested_season(&item, season, year))
            {
                outside_season += 1;
                continue;
            }
            let id = parse_kitsu_id(&item.id)?;
            if seen.insert(id) {
                valid.push(item);
            }
        }
        if adult > 0 {
            warnings.push(format!(
                "Kitsu returned {adult} adult item(s); they were omitted."
            ));
        }
        if outside_season > 0 {
            warnings.push(format!(
                "Kitsu returned {outside_season} item(s) outside the requested season, season year, or supported TV/ONA formats; they were omitted."
            ));
        }
        if valid.is_empty() {
            return Ok((Vec::new(), warnings));
        }

        let provider_ids = valid
            .iter()
            .map(|item| parse_kitsu_id(&item.id).map(ProviderId::kitsu))
            .collect::<Result<HashSet<_>, _>>()?;
        let resolution = self.identity.resolve_ids(&provider_ids, cache_dir).await?;
        warnings.extend(resolution.warnings);

        let mut missing_mappings = 0;
        let mut items = Vec::new();
        for anime in valid {
            let kitsu_id = parse_kitsu_id(&anime.id)?;
            let Some(anilist_id) = resolution
                .anilist_by_provider_id
                .get(&ProviderId::kitsu(kitsu_id))
                .copied()
            else {
                missing_mappings += 1;
                continue;
            };
            let item = normalize_kitsu_anime(anime, anilist_id)?;
            item.validate("Kitsu")?;
            items.push(item);
        }

        if missing_mappings > 0 {
            warnings.push(format!(
                "{missing_mappings} Kitsu item(s) were omitted because no verified canonical AniList mapping was available."
            ));
        }
        if missing_mappings > 0 && items.is_empty() {
            return Err(format!(
                "Kitsu returned items, but none had verified canonical AniList mappings. {}",
                warnings.join(" ")
            ));
        }
        Ok((items, warnings))
    }
}

impl CatalogAdapter for KitsuAdapter {
    fn descriptor(&self) -> CatalogProvider {
        CatalogProvider::new("kitsu", "Kitsu", CAPABILITIES)
    }

    fn request<'a>(
        &'a self,
        request: CatalogRequest,
        cache_dir: std::path::PathBuf,
    ) -> AdapterFuture<'a> {
        Box::pin(async move {
            let (items, warnings) = match &request {
                CatalogRequest::Search { query } => self.search(query, &cache_dir).await?,
                CatalogRequest::Season { season, year } => {
                    self.season(*season, *year, &cache_dir).await?
                }
                CatalogRequest::Recommendations { .. } => {
                    return Err("Kitsu does not support recommendations.".into())
                }
            };
            Ok(CatalogResponse::new("kitsu", &request, items, warnings))
        })
    }
}

impl KitsuClient {
    fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            in_flight: Semaphore::new(1),
            control: Mutex::new(RequestControl {
                cache: HashMap::new(),
                cooldown_until: None,
                next_request_at: Instant::now(),
            }),
        }
    }

    async fn request(&self, url: Url) -> Result<Value, String> {
        let cache_key = url.as_str().to_owned();
        if let Some(value) = self.cached(&cache_key)? {
            return Ok(value);
        }
        let _permit = self
            .in_flight
            .acquire()
            .await
            .map_err(|_| "The Kitsu request queue is unavailable.".to_string())?;
        if let Some(value) = self.cached(&cache_key)? {
            return Ok(value);
        }

        let wait = self.reserve_request()?;
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        self.check_cooldown()?;

        let response = match self
            .http
            .get(url)
            .header("Accept", "application/vnd.api+json")
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.begin_cooldown(KITSU_NETWORK_COOLDOWN)?;
                return Err(format!(
                    "Kitsu is unreachable: {error}. This request will not retry automatically."
                ));
            }
        };
        let status = response.status();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        if status == StatusCode::TOO_MANY_REQUESTS {
            let cooldown = kitsu_retry_after(retry_after.as_deref());
            self.begin_cooldown(cooldown)?;
            return Err(format!(
                "Kitsu is rate limiting requests. Try again in {} seconds; this request will not retry automatically.",
                cooldown.as_secs()
            ));
        }
        if status == StatusCode::FORBIDDEN {
            self.begin_cooldown(KITSU_FORBIDDEN_COOLDOWN)?;
            return Err(
                "Kitsu rejected this request (HTTP 403); this request will not retry automatically."
                    .into(),
            );
        }
        if status.is_server_error() {
            self.begin_cooldown(KITSU_SERVER_COOLDOWN)?;
            return Err(format!(
                "Kitsu returned an HTTP {status} server error; this request will not retry automatically."
            ));
        }
        if !status.is_success() {
            return Err(format!("Kitsu returned an HTTP {status} error."));
        }

        let value = match read_bounded_json(response).await {
            Ok(value) => value,
            Err(error) => {
                self.begin_cooldown(KITSU_NETWORK_COOLDOWN)?;
                return Err(format!(
                    "{error} This request will not retry automatically."
                ));
            }
        };
        self.cache(cache_key, value.clone())?;
        Ok(value)
    }

    fn cached(&self, key: &str) -> Result<Option<Value>, String> {
        let now = Instant::now();
        let mut control = self
            .control
            .lock()
            .map_err(|_| "The Kitsu request state is unavailable.".to_string())?;
        control.cache.retain(|_, entry| entry.expires_at > now);
        Ok(control.cache.get(key).map(|entry| entry.value.clone()))
    }

    fn cache(&self, key: String, value: Value) -> Result<(), String> {
        let now = Instant::now();
        let mut control = self
            .control
            .lock()
            .map_err(|_| "The Kitsu request state is unavailable.".to_string())?;
        control.cache.retain(|_, entry| entry.expires_at > now);
        if !control.cache.contains_key(&key) && control.cache.len() >= KITSU_CACHE_LIMIT {
            if let Some(oldest_key) = control
                .cache
                .iter()
                .min_by_key(|(_, entry)| entry.expires_at)
                .map(|(key, _)| key.clone())
            {
                control.cache.remove(&oldest_key);
            }
        }
        control.cache.insert(
            key,
            CacheEntry {
                expires_at: now + KITSU_CACHE_TTL,
                value,
            },
        );
        Ok(())
    }

    fn reserve_request(&self) -> Result<Duration, String> {
        let now = Instant::now();
        let mut control = self
            .control
            .lock()
            .map_err(|_| "The Kitsu request state is unavailable.".to_string())?;
        reserve_kitsu_request(&mut control, now)
    }

    fn check_cooldown(&self) -> Result<(), String> {
        let mut control = self
            .control
            .lock()
            .map_err(|_| "The Kitsu request state is unavailable.".to_string())?;
        ensure_kitsu_available(&mut control, Instant::now())
    }

    fn begin_cooldown(&self, duration: Duration) -> Result<(), String> {
        let mut control = self
            .control
            .lock()
            .map_err(|_| "The Kitsu request state is unavailable.".to_string())?;
        control.cooldown_until = Some(Instant::now() + duration);
        Ok(())
    }
}

fn kitsu_season_page_failure(loaded_items: usize, error: String) -> Result<String, String> {
    if loaded_items == 0 {
        Err(error)
    } else {
        Ok(format!(
            "Kitsu season results are partial because a later page was unavailable: {error}"
        ))
    }
}

fn reserve_kitsu_request(control: &mut RequestControl, now: Instant) -> Result<Duration, String> {
    ensure_kitsu_available(control, now)?;
    let request_at = control.next_request_at.max(now);
    control.next_request_at = request_at + KITSU_REQUEST_INTERVAL;
    Ok(request_at.saturating_duration_since(now))
}

fn ensure_kitsu_available(control: &mut RequestControl, now: Instant) -> Result<(), String> {
    let Some(until) = control.cooldown_until else {
        return Ok(());
    };
    if until <= now {
        control.cooldown_until = None;
        return Ok(());
    }
    let remaining = until.saturating_duration_since(now);
    let seconds = remaining.as_secs() + u64::from(remaining.subsec_nanos() > 0);
    Err(format!(
        "Kitsu requests are cooling down. Try again in {seconds} seconds."
    ))
}

fn kitsu_retry_after(retry_after: Option<&str>) -> Duration {
    let seconds = retry_after
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(KITSU_DEFAULT_RATE_COOLDOWN_SECONDS)
        .clamp(1, KITSU_MAX_RATE_COOLDOWN_SECONDS);
    Duration::from_secs(seconds)
}

fn kitsu_search_url(query: &str) -> Result<Url, String> {
    kitsu_url(&[
        ("filter[text]", query.trim().to_owned()),
        ("page[limit]", KITSU_PAGE_LIMIT.to_string()),
        ("page[offset]", "0".into()),
    ])
}

fn kitsu_season_url(season: CatalogSeason, year: i32, offset: usize) -> Result<Url, String> {
    kitsu_url(&[
        ("filter[season]", season.as_str().to_ascii_lowercase()),
        ("filter[seasonYear]", year.to_string()),
        ("filter[subtype]", "TV,ONA".into()),
        ("page[limit]", KITSU_PAGE_LIMIT.to_string()),
        ("page[offset]", offset.to_string()),
        ("sort", "-userCount".into()),
    ])
}

fn kitsu_url(query: &[(&str, String)]) -> Result<Url, String> {
    let mut url = Url::parse(KITSU_API_BASE)
        .map_err(|error| format!("The Kitsu endpoint is invalid: {error}"))?;
    url.path_segments_mut()
        .map_err(|_| "The Kitsu endpoint cannot contain path segments.".to_string())?
        .pop_if_empty()
        .push("anime");
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    Ok(url)
}

async fn read_bounded_json(mut response: reqwest::Response) -> Result<Value, String> {
    if response
        .content_length()
        .is_some_and(|length| length > KITSU_MAX_RESPONSE_BYTES as u64)
    {
        return Err("The Kitsu response is too large.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("The Kitsu response could not be read: {error}"))?
    {
        append_bounded(&mut bytes, &chunk, KITSU_MAX_RESPONSE_BYTES)?;
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("Kitsu returned invalid JSON: {error}"))
}

fn append_bounded(target: &mut Vec<u8>, chunk: &[u8], max_bytes: usize) -> Result<(), String> {
    if chunk.len() > max_bytes.saturating_sub(target.len()) {
        return Err("The Kitsu response is too large.".into());
    }
    target.extend_from_slice(chunk);
    Ok(())
}

fn parse_kitsu_page(
    value: Value,
    request_url: &Url,
    expected_offset: usize,
    item_limit: usize,
) -> Result<KitsuPage, String> {
    let data_len = value
        .get("data")
        .and_then(Value::as_array)
        .map(Vec::len)
        .ok_or_else(|| "Kitsu returned an invalid data page.".to_string())?;
    if data_len > item_limit {
        return Err("Kitsu returned more items than requested.".into());
    }
    let page: KitsuPage = serde_json::from_value(value)
        .map_err(|error| format!("Kitsu returned invalid pagination or media data: {error}"))?;
    validate_pagination(
        &page.links,
        request_url,
        expected_offset,
        item_limit,
        data_len,
    )?;
    Ok(page)
}

fn validate_pagination(
    links: &KitsuLinks,
    request_url: &Url,
    expected_offset: usize,
    item_limit: usize,
    item_count: usize,
) -> Result<(), String> {
    if pagination_offset(&links.first, request_url)? != 0 {
        return Err("Kitsu returned invalid pagination metadata.".into());
    }
    let last_offset = pagination_offset(&links.last, request_url)?;
    if last_offset > KITSU_MAX_REPORTED_OFFSET {
        return Err("Kitsu returned invalid pagination metadata.".into());
    }
    match &links.next {
        Some(next) => {
            let expected_next = expected_offset
                .checked_add(item_limit)
                .ok_or_else(|| "Kitsu returned invalid pagination metadata.".to_string())?;
            if item_count != item_limit || pagination_offset(next, request_url)? != expected_next {
                return Err("Kitsu returned invalid pagination metadata.".into());
            }
        }
        None if item_count > item_limit => {
            return Err("Kitsu returned invalid pagination metadata.".into())
        }
        None => {}
    }
    Ok(())
}

fn pagination_offset(link: &str, request_url: &Url) -> Result<usize, String> {
    if link.len() > 2_000 {
        return Err("Kitsu returned invalid pagination metadata.".into());
    }
    let link =
        Url::parse(link).map_err(|_| "Kitsu returned invalid pagination metadata.".to_string())?;
    if link.scheme() != "https"
        || link.host_str() != Some("kitsu.io")
        || link.port_or_known_default() != Some(443)
        || !link.username().is_empty()
        || link.password().is_some()
        || link.path() != "/api/edge/anime"
        || link.fragment().is_some()
    {
        return Err("Kitsu returned invalid pagination metadata.".into());
    }
    let mut expected = query_parameters(request_url)?;
    let mut actual = query_parameters(&link)?;
    let expected_limit = expected.remove("page[limit]");
    let actual_limit = actual.remove("page[limit]");
    expected.remove("page[offset]");
    let offset = actual
        .remove("page[offset]")
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| "Kitsu returned invalid pagination metadata.".to_string())?;
    if expected_limit != actual_limit || expected != actual {
        return Err("Kitsu returned invalid pagination metadata.".into());
    }
    Ok(offset)
}

fn query_parameters(url: &Url) -> Result<BTreeMap<String, String>, String> {
    let mut parameters = BTreeMap::new();
    for (key, value) in url.query_pairs() {
        if parameters
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err("Kitsu returned invalid pagination metadata.".into());
        }
    }
    Ok(parameters)
}

fn parse_kitsu_id(value: &str) -> Result<i64, String> {
    if value.is_empty()
        || value.len() > 10
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err("Kitsu returned an invalid anime ID.".into());
    }
    let id = value
        .parse::<i64>()
        .map_err(|_| "Kitsu returned an invalid anime ID.".to_string())?;
    if !(1..=i64::from(i32::MAX)).contains(&id) {
        return Err("Kitsu returned an invalid anime ID.".into());
    }
    Ok(id)
}

fn validate_kitsu_anime(anime: &KitsuAnime) -> Result<(), String> {
    let attributes = &anime.attributes;
    if anime.resource_type != "anime"
        || parse_kitsu_id(&anime.id).is_err()
        || attributes.slug.trim().is_empty()
        || !valid_kitsu_text(&attributes.slug, 500)
        || attributes.canonical_title.trim().is_empty()
        || !valid_kitsu_text(&attributes.canonical_title, 500)
        || attributes.titles.len() > 100
        || attributes
            .titles
            .iter()
            .any(|(locale, title)| !valid_kitsu_text(locale, 100) || !valid_kitsu_text(title, 500))
        || attributes.abbreviated_titles.len() > 100
        || attributes
            .abbreviated_titles
            .iter()
            .any(|title| !valid_kitsu_text(title, 500))
        || attributes
            .description
            .as_ref()
            .is_some_and(|value| !valid_kitsu_description(value))
        || attributes
            .synopsis
            .as_ref()
            .is_some_and(|value| !valid_kitsu_description(value))
        || attributes
            .average_rating
            .as_deref()
            .is_some_and(|value| kitsu_score(value).is_none())
        || attributes.user_count < 0
        || attributes.user_count > i64::from(i32::MAX)
        || attributes
            .start_date
            .as_deref()
            .is_some_and(|value| parse_kitsu_date(value).is_none())
        || attributes
            .end_date
            .as_deref()
            .is_some_and(|value| parse_kitsu_date(value).is_none())
        || kitsu_format(&attributes.subtype).is_none()
        || kitsu_status(&attributes.status).is_none()
        || attributes
            .episode_count
            .is_some_and(|value| !(0..=100_000).contains(&value))
        || attributes
            .episode_length
            .is_some_and(|value| !(0..=24 * 60).contains(&value))
        || attributes
            .youtube_video_id
            .as_deref()
            .is_some_and(|value| !value.is_empty() && !valid_youtube_id(value))
        || attributes
            .poster_image
            .as_ref()
            .is_some_and(|image| !valid_kitsu_images(image))
        || attributes
            .cover_image
            .as_ref()
            .is_some_and(|image| !valid_kitsu_images(image))
    {
        return Err("Kitsu returned an invalid anime item.".into());
    }
    Ok(())
}

fn valid_kitsu_text(value: &str, max_len: usize) -> bool {
    value.len() <= max_len && !value.chars().any(char::is_control)
}

fn valid_kitsu_description(value: &str) -> bool {
    value.len() <= 100_000
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

fn valid_youtube_id(value: &str) -> bool {
    (6..=32).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_kitsu_images(image: &KitsuImageSet) -> bool {
    [
        image.tiny.as_deref(),
        image.small.as_deref(),
        image.medium.as_deref(),
        image.large.as_deref(),
        image.original.as_deref(),
    ]
    .into_iter()
    .flatten()
    .all(valid_https_url)
}

fn valid_https_url(value: &str) -> bool {
    value.len() <= 2_000
        && Url::parse(value).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str().is_some()
                && url.port_or_known_default() == Some(443)
                && url.username().is_empty()
                && url.password().is_none()
        })
}

fn kitsu_score(value: &str) -> Option<i64> {
    if value.len() > 10 || value.chars().any(char::is_control) {
        return None;
    }
    let score = value.parse::<f64>().ok()?;
    (score.is_finite() && (0.0..=100.0).contains(&score)).then(|| score.round() as i64)
}

fn kitsu_format(value: &str) -> Option<&'static str> {
    match value {
        "TV" => Some("TV"),
        "ONA" => Some("ONA"),
        "OVA" => Some("OVA"),
        "movie" => Some("MOVIE"),
        "special" => Some("SPECIAL"),
        "music" => Some("MUSIC"),
        _ => None,
    }
}

fn kitsu_status(value: &str) -> Option<&'static str> {
    match value {
        "finished" => Some("FINISHED"),
        "current" => Some("RELEASING"),
        "upcoming" | "unreleased" | "tba" => Some("NOT_YET_RELEASED"),
        _ => None,
    }
}

fn parse_kitsu_date(value: &str) -> Option<KitsuDate> {
    if value.len() != 10
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
    {
        return None;
    }
    let year = value.get(0..4)?.parse::<i32>().ok()?;
    let month = value.get(5..7)?.parse::<u32>().ok()?;
    let day = value.get(8..10)?.parse::<u32>().ok()?;
    if !(1900..=2200).contains(&year) || !(1..=days_in_month(year, month)?).contains(&day) {
        return None;
    }
    Some(KitsuDate { year, month, day })
}

fn days_in_month(year: i32, month: u32) -> Option<u32> {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => Some(31),
        4 | 6 | 9 | 11 => Some(30),
        2 if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) => Some(29),
        2 => Some(28),
        _ => None,
    }
}

fn kitsu_season(date: KitsuDate) -> Option<(CatalogSeason, i32)> {
    let (season, year) = match date.month {
        12 => (CatalogSeason::Winter, date.year.checked_add(1)?),
        1 | 2 => (CatalogSeason::Winter, date.year),
        3..=5 => (CatalogSeason::Spring, date.year),
        6..=8 => (CatalogSeason::Summer, date.year),
        9..=11 => (CatalogSeason::Fall, date.year),
        _ => return None,
    };
    Some((season, year))
}

fn matches_requested_season(anime: &KitsuAnime, season: CatalogSeason, year: i32) -> bool {
    matches!(kitsu_format(&anime.attributes.subtype), Some("TV" | "ONA"))
        && anime
            .attributes
            .start_date
            .as_deref()
            .and_then(parse_kitsu_date)
            .and_then(kitsu_season)
            == Some((season, year))
}

fn kitsu_date_json(date: KitsuDate) -> Value {
    json!({ "year": date.year, "month": date.month, "day": date.day })
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

fn normalize_kitsu_anime(anime: KitsuAnime, anilist_id: i64) -> Result<CatalogMedia, String> {
    parse_kitsu_id(&anime.id)?;
    let mut attributes = anime.attributes;
    let start_date = attributes.start_date.as_deref().and_then(parse_kitsu_date);
    let season_context = start_date
        .and_then(kitsu_season)
        .filter(|(_, year)| (1940..=2200).contains(year));
    let romaji = nonempty(attributes.titles.remove("en_jp"));
    let english = nonempty(attributes.titles.remove("en"));
    let native = nonempty(attributes.titles.remove("ja_jp"));
    let preferred = attributes.canonical_title.clone();
    let cover_image = attributes.poster_image.take().and_then(kitsu_poster);
    let banner_image = attributes.cover_image.take().and_then(kitsu_banner);
    let trailer =
        nonempty(attributes.youtube_video_id).map(|id| json!({ "id": id, "site": "youtube" }));
    let site_url = kitsu_site_url(&attributes.slug)?;
    let synonyms =
        (!attributes.abbreviated_titles.is_empty()).then_some(attributes.abbreviated_titles);

    Ok(CatalogMedia {
        id: anilist_id,
        id_mal: None,
        title: CatalogTitle {
            romaji,
            english,
            native,
            user_preferred: Some(preferred),
        },
        synonyms,
        description: nonempty(attributes.description).or_else(|| nonempty(attributes.synopsis)),
        trailer,
        cover_image,
        banner_image,
        genres: None,
        season: season_context.map(|(season, _)| season),
        season_year: season_context.map(|(_, year)| year),
        start_date: start_date.map(kitsu_date_json),
        end_date: attributes
            .end_date
            .as_deref()
            .and_then(parse_kitsu_date)
            .map(kitsu_date_json),
        format: kitsu_format(&attributes.subtype).map(str::to_owned),
        status: kitsu_status(&attributes.status).map(str::to_owned),
        episodes: attributes.episode_count.filter(|value| *value > 0),
        duration: attributes.episode_length.filter(|value| *value > 0),
        average_score: attributes.average_rating.as_deref().and_then(kitsu_score),
        popularity: Some(attributes.user_count),
        site_url: Some(site_url),
        next_airing_episode: None,
        relations: None,
    })
}

fn kitsu_poster(image: KitsuImageSet) -> Option<CatalogCoverImage> {
    let extra_large = image.large.or(image.original);
    let large = image.medium.or(image.small).or(image.tiny);
    (extra_large.is_some() || large.is_some()).then_some(CatalogCoverImage {
        extra_large,
        large,
        color: None,
    })
}

fn kitsu_banner(image: KitsuImageSet) -> Option<String> {
    image
        .large
        .or(image.small)
        .or(image.original)
        .or(image.tiny)
}

fn kitsu_site_url(slug: &str) -> Result<String, String> {
    let mut url = Url::parse("https://kitsu.io/anime/")
        .map_err(|error| format!("The Kitsu site endpoint is invalid: {error}"))?;
    url.path_segments_mut()
        .map_err(|_| "The Kitsu site endpoint cannot contain path segments.".to_string())?
        .pop_if_empty()
        .push(slug);
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        time::{Duration, Instant},
    };

    use serde_json::Value;

    use super::{
        append_bounded, kitsu_retry_after, kitsu_search_url, kitsu_season,
        kitsu_season_page_failure, kitsu_season_url, kitsu_url, normalize_kitsu_anime,
        parse_kitsu_date, parse_kitsu_page, reserve_kitsu_request, KitsuAnime, RequestControl,
        KITSU_MAX_RESPONSE_BYTES, KITSU_REQUEST_INTERVAL,
    };

    fn anime(id: i64) -> KitsuAnime {
        serde_json::from_value(serde_json::json!({
            "id": id.to_string(),
            "type": "anime",
            "attributes": {
                "slug": "example",
                "titles": {"en": "Example", "en_jp": "Example", "ja_jp": "例"},
                "canonicalTitle": "Example",
                "userCount": 10,
                "startDate": "2024-12-15",
                "endDate": null,
                "subtype": "TV",
                "status": "current",
                "episodeCount": 12,
                "episodeLength": 24,
                "nsfw": false
            }
        }))
        .unwrap()
    }

    #[test]
    fn builds_every_kitsu_query_with_encoded_inputs() {
        let search = kitsu_search_url("  Frieren & Fern  ").unwrap();
        assert_eq!(search.origin().ascii_serialization(), "https://kitsu.io");
        assert_eq!(search.path(), "/api/edge/anime");
        assert_eq!(
            search.query().unwrap(),
            "filter%5Btext%5D=Frieren+%26+Fern&page%5Blimit%5D=20&page%5Boffset%5D=0"
        );

        let season = kitsu_season_url(super::CatalogSeason::Winter, 2026, 40).unwrap();
        assert_eq!(
            season.query().unwrap(),
            "filter%5Bseason%5D=winter&filter%5BseasonYear%5D=2026&filter%5Bsubtype%5D=TV%2CONA&page%5Blimit%5D=20&page%5Boffset%5D=40&sort=-userCount"
        );
    }

    #[test]
    fn parses_the_current_live_kitsu_json_api_shape() {
        let request = kitsu_url(&[
            ("filter[text]", "Frieren".into()),
            ("page[limit]", "1".into()),
            ("page[offset]", "0".into()),
        ])
        .unwrap();
        let next = kitsu_url(&[
            ("filter[text]", "Frieren".into()),
            ("page[limit]", "1".into()),
            ("page[offset]", "1".into()),
        ])
        .unwrap();
        let last = kitsu_url(&[
            ("filter[text]", "Frieren".into()),
            ("page[limit]", "1".into()),
            ("page[offset]", "5".into()),
        ])
        .unwrap();
        let fixture = serde_json::json!({
            "data": [{
                "id": "46474",
                "type": "anime",
                "links": { "self": "https://kitsu.io/api/edge/anime/46474" },
                "attributes": {
                    "createdAt": "2022-09-13T05:36:19.002Z",
                    "slug": "sousou-no-frieren",
                    "synopsis": "An elf mage retraces a journey.",
                    "description": "An elf mage retraces a journey.",
                    "titles": {
                        "en": "Frieren: Beyond Journey’s End",
                        "en_jp": "Sousou no Frieren",
                        "ja_jp": "葬送のフリーレン"
                    },
                    "canonicalTitle": "Sousou no Frieren",
                    "abbreviatedTitles": ["Frieren at the Funeral"],
                    "averageRating": "88.81",
                    "userCount": 21024,
                    "startDate": "2023-09-29",
                    "endDate": "2024-03-22",
                    "subtype": "TV",
                    "showType": "TV",
                    "status": "finished",
                    "posterImage": {
                        "large": "https://media.kitsu.app/anime/46474/poster_image/large.jpeg",
                        "meta": { "dimensions": { "large": { "width": 550, "height": 780 } } }
                    },
                    "coverImage": null,
                    "episodeCount": 28,
                    "episodeLength": 24,
                    "youtubeVideoId": "qgQunxD0qCk",
                    "ratingFrequencies": { "20": "1" },
                    "nsfw": false
                }
            }],
            "meta": { "count": 6 },
            "links": {
                "first": request.as_str(),
                "next": next.as_str(),
                "last": last.as_str()
            }
        });
        let page = parse_kitsu_page(fixture, &request, 0, 1).unwrap();
        assert_eq!(page.data[0].id, "46474");
        assert_eq!(page.data[0].attributes.user_count, 21024);
        assert_eq!(page.links.next.as_deref(), Some(next.as_str()));
    }

    #[test]
    fn validates_bounded_pagination_without_following_provider_links() {
        let request = kitsu_url(&[
            ("filter[text]", "Example".into()),
            ("page[limit]", "20".into()),
            ("page[offset]", "0".into()),
        ])
        .unwrap();
        let page = serde_json::json!({
            "data": [{
                "id": "1", "type": "anime",
                "attributes": {
                    "slug": "example", "titles": {}, "canonicalTitle": "Example",
                    "userCount": 0, "subtype": "TV", "status": "finished", "nsfw": false
                }
            }],
            "links": {"first": request.as_str(), "last": request.as_str()}
        });
        assert!(parse_kitsu_page(page.clone(), &request, 0, 20).is_ok());

        let mut malicious = page;
        malicious["links"]["last"] = Value::String(
            "https://example.com/api/edge/anime?page%5Blimit%5D=20&page%5Boffset%5D=0".into(),
        );
        assert!(parse_kitsu_page(malicious, &request, 0, 20).is_err());
    }

    #[test]
    fn keeps_validated_kitsu_pages_when_a_later_page_is_unavailable() {
        let warning = kitsu_season_page_failure(
            20,
            "Kitsu returned an HTTP 500 Internal Server Error server error.".into(),
        )
        .unwrap();
        assert!(warning.contains("results are partial"));
        assert!(warning.contains("HTTP 500"));
        assert_eq!(
            kitsu_season_page_failure(0, "first page failed".into()).unwrap_err(),
            "first page failed"
        );
    }

    #[test]
    fn derives_kitsu_seasons_using_the_documented_season_year() {
        assert_eq!(
            kitsu_season(parse_kitsu_date("2024-12-01").unwrap()),
            Some((super::CatalogSeason::Winter, 2025))
        );
        assert_eq!(
            kitsu_season(parse_kitsu_date("2025-03-31").unwrap()),
            Some((super::CatalogSeason::Spring, 2025))
        );
        assert_eq!(
            kitsu_season(parse_kitsu_date("2025-09-19").unwrap()),
            Some((super::CatalogSeason::Fall, 2025))
        );
        assert!(parse_kitsu_date("2025-02-29").is_none());
    }

    #[test]
    fn validates_season_membership_and_rejects_unsupported_formats() {
        let mut item = anime(42);
        assert!(super::matches_requested_season(
            &item,
            super::CatalogSeason::Winter,
            2025
        ));
        assert!(!super::matches_requested_season(
            &item,
            super::CatalogSeason::Winter,
            2024
        ));
        item.attributes.subtype = "movie".into();
        assert!(!super::matches_requested_season(
            &item,
            super::CatalogSeason::Winter,
            2025
        ));
    }

    #[test]
    fn normalizes_kitsu_to_anilist_shaped_canonical_cards() {
        let mut item = anime(42);
        item.attributes.average_rating = Some("88.8".into());
        item.attributes.youtube_video_id = Some("qgQunxD0qCk".into());
        item.attributes.poster_image = Some(
            serde_json::from_value(serde_json::json!({
                "large": "https://media.kitsu.app/anime/42/poster_image/large.jpeg"
            }))
            .unwrap(),
        );
        let media = normalize_kitsu_anime(item, 154_587).unwrap();
        let value = serde_json::to_value(media).unwrap();
        assert_eq!(value["id"], 154_587);
        assert!(value.get("idMal").is_none());
        assert_eq!(value["season"], "WINTER");
        assert_eq!(value["seasonYear"], 2025);
        assert_eq!(value["format"], "TV");
        assert_eq!(value["averageScore"], 89);
        assert_eq!(value["trailer"]["site"], "youtube");
    }

    #[test]
    fn rejects_invalid_media_ids_scores_dates_and_resource_types() {
        for invalid in [
            serde_json::json!({"id": "0", "type": "anime"}),
            serde_json::json!({"id": "1", "type": "manga"}),
        ] {
            let mut value = serde_json::to_value(anime(1)).unwrap();
            value["id"] = invalid["id"].clone();
            value["type"] = invalid["type"].clone();
            let item: KitsuAnime = serde_json::from_value(value).unwrap();
            assert!(super::validate_kitsu_anime(&item).is_err());
        }
        let mut item = anime(1);
        item.attributes.average_rating = Some("101".into());
        assert!(super::validate_kitsu_anime(&item).is_err());
        item.attributes.average_rating = None;
        item.attributes.start_date = Some("2025-13-01".into());
        assert!(super::validate_kitsu_anime(&item).is_err());
        item.attributes.start_date = Some("2025-01-01".into());
        item.attributes.youtube_video_id = Some(String::new());
        assert!(super::validate_kitsu_anime(&item).is_ok());
    }

    #[tokio::test]
    async fn uses_only_independent_verified_kitsu_identity_mappings() {
        let directory = tempfile::tempdir().unwrap();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        std::fs::write(
            directory.path().join("identity-fribb-v1.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": 1, "fetchedAt": timestamp,
                "entries": [{"anilistId": 700, "providerIds": {"kitsu": 1}}]
            }))
            .unwrap(),
        )
        .unwrap();
        let client = reqwest::Client::new();
        let adapter = super::KitsuAdapter::new(
            client.clone(),
            std::sync::Arc::new(super::IdentityResolver::new(client)),
        );
        let (items, warnings) = adapter
            .map_results(
                vec![anime(1), anime(999)],
                None,
                directory.path(),
                Vec::new(),
            )
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, 700);
        assert_eq!(items[0].id_mal, None);
        assert!(warnings.iter().any(|warning| warning.contains("omitted")));
    }

    #[test]
    fn rejects_requests_during_cooldown_and_spaces_requests() {
        let now = Instant::now();
        let mut control = RequestControl {
            cache: HashMap::new(),
            cooldown_until: None,
            next_request_at: now,
        };
        assert_eq!(
            reserve_kitsu_request(&mut control, now).unwrap(),
            Duration::ZERO
        );
        assert_eq!(
            reserve_kitsu_request(&mut control, now).unwrap(),
            KITSU_REQUEST_INTERVAL
        );
        control.cooldown_until = Some(now + Duration::from_secs(30));
        assert!(reserve_kitsu_request(&mut control, now).is_err());
    }

    #[test]
    fn bounds_rate_limit_cooldowns_and_response_bytes() {
        assert_eq!(kitsu_retry_after(Some("0")), Duration::from_secs(1));
        assert_eq!(kitsu_retry_after(Some("9999")), Duration::from_secs(300));
        assert_eq!(kitsu_retry_after(None), Duration::from_secs(30));

        let mut bytes = vec![0; 2];
        append_bounded(&mut bytes, &[1, 2], 4).unwrap();
        assert!(append_bounded(&mut bytes, &[3], 4).is_err());
        assert_eq!(KITSU_MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
    }
}
