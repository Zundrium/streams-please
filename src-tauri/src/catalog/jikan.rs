use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use reqwest::{StatusCode, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use super::{
    identity::{IdentityResolver, ProviderId},
    AdapterFuture, CatalogAdapter, CatalogCapability, CatalogCoverImage, CatalogMedia,
    CatalogProvider, CatalogRequest, CatalogResponse, CatalogSeason, CatalogTitle,
};

const JIKAN_API_BASE: &str = "https://api.jikan.moe/v4/";
const JIKAN_REQUEST_INTERVAL: Duration = Duration::from_millis(2_100);
const JIKAN_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const JIKAN_CACHE_LIMIT: usize = 128;
const JIKAN_MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const JIKAN_SEARCH_LIMIT: usize = 25;
const JIKAN_SEASON_PAGE_LIMIT: usize = 25;
const JIKAN_MAX_SEASON_PAGES: usize = 4;
const JIKAN_MAX_REPORTED_PAGES: u64 = 10_000;
const JIKAN_DEFAULT_RATE_COOLDOWN_SECONDS: u64 = 30;
const JIKAN_MAX_RATE_COOLDOWN_SECONDS: u64 = 5 * 60;
const JIKAN_NETWORK_COOLDOWN: Duration = Duration::from_secs(30);
const JIKAN_SERVER_COOLDOWN: Duration = Duration::from_secs(60);
const JIKAN_FORBIDDEN_COOLDOWN: Duration = Duration::from_secs(5 * 60);

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

struct JikanClient {
    http: reqwest::Client,
    in_flight: Semaphore,
    control: Mutex<RequestControl>,
}

pub(super) struct JikanAdapter {
    client: JikanClient,
    identity: Arc<IdentityResolver>,
}

#[derive(Deserialize)]
struct JikanPage {
    pagination: JikanPagination,
    data: Vec<JikanAnime>,
}

#[derive(Deserialize)]
struct JikanPagination {
    last_visible_page: u64,
    has_next_page: bool,
    current_page: u64,
}

#[derive(Deserialize)]
struct JikanAnime {
    mal_id: i64,
    title: String,
    #[serde(default)]
    title_english: Option<String>,
    #[serde(default)]
    title_japanese: Option<String>,
    #[serde(default)]
    title_synonyms: Vec<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    images: JikanImages,
    #[serde(default)]
    trailer: JikanTrailer,
    #[serde(rename = "type", default)]
    media_type: Option<String>,
    #[serde(default)]
    episodes: Option<i64>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    aired: JikanAired,
    #[serde(default)]
    score: Option<f64>,
    #[serde(default)]
    members: Option<i64>,
    #[serde(default)]
    synopsis: Option<String>,
    #[serde(default)]
    season: Option<String>,
    #[serde(default)]
    year: Option<i32>,
    #[serde(default)]
    genres: Vec<JikanGenre>,
}

#[derive(Default, Deserialize)]
struct JikanImages {
    #[serde(default)]
    jpg: JikanImageSet,
}

#[derive(Default, Deserialize)]
struct JikanImageSet {
    #[serde(default)]
    image_url: Option<String>,
    #[serde(default)]
    large_image_url: Option<String>,
}

#[derive(Default, Deserialize)]
struct JikanTrailer {
    #[serde(default)]
    youtube_id: Option<String>,
    #[serde(default)]
    images: JikanTrailerImages,
}

#[derive(Default, Deserialize)]
struct JikanTrailerImages {
    #[serde(default)]
    maximum_image_url: Option<String>,
    #[serde(default)]
    large_image_url: Option<String>,
}

#[derive(Default, Deserialize)]
struct JikanAired {
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Option<String>,
}

#[derive(Deserialize)]
struct JikanGenre {
    name: String,
}

impl JikanAdapter {
    pub(super) fn new(http: reqwest::Client, identity: Arc<IdentityResolver>) -> Self {
        Self {
            client: JikanClient::new(http),
            identity,
        }
    }

    async fn search(
        &self,
        query: &str,
        cache_dir: &std::path::Path,
    ) -> Result<(Vec<CatalogMedia>, Vec<String>), String> {
        let url = jikan_url(
            &["anime"],
            &[
                ("q", query.trim().to_owned()),
                ("sfw", "true".into()),
                ("limit", JIKAN_SEARCH_LIMIT.to_string()),
                ("page", "1".into()),
            ],
        )?;
        let payload = self.client.request(url).await?;
        let page = parse_jikan_page(payload, 1, JIKAN_SEARCH_LIMIT)?;
        let mut warnings = Vec::new();
        if page.pagination.has_next_page {
            warnings.push(format!(
                "Jikan search results were limited to {JIKAN_SEARCH_LIMIT} items."
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
        for page_number in 1..=JIKAN_MAX_SEASON_PAGES {
            let url = jikan_url(
                &[
                    "seasons",
                    &year.to_string(),
                    &season.as_str().to_ascii_lowercase(),
                ],
                &[
                    ("sfw", "true".into()),
                    ("limit", JIKAN_SEASON_PAGE_LIMIT.to_string()),
                    ("page", page_number.to_string()),
                ],
            )?;
            let payload = self.client.request(url).await?;
            let page = parse_jikan_page(payload, page_number, JIKAN_SEASON_PAGE_LIMIT)?;
            let has_next_page = page.pagination.has_next_page;
            anime.extend(page.data);
            if !has_next_page {
                break;
            }
            if page_number == JIKAN_MAX_SEASON_PAGES {
                warnings.push(format!(
                    "Jikan season results were truncated after {JIKAN_MAX_SEASON_PAGES} pages ({} items maximum).",
                    JIKAN_MAX_SEASON_PAGES * JIKAN_SEASON_PAGE_LIMIT
                ));
            }
        }
        self.map_results(anime, Some((season, year)), cache_dir, warnings)
            .await
    }

    async fn map_results(
        &self,
        anime: Vec<JikanAnime>,
        requested_season: Option<(CatalogSeason, i32)>,
        cache_dir: &std::path::Path,
        mut warnings: Vec<String>,
    ) -> Result<(Vec<CatalogMedia>, Vec<String>), String> {
        let mut filtered = 0;
        let mut valid = Vec::new();
        let mut seen = HashSet::new();
        for item in anime {
            validate_jikan_anime(&item)?;
            if requested_season
                .is_some_and(|(season, year)| !matches_requested_season(&item, season, year))
            {
                filtered += 1;
                continue;
            }
            if seen.insert(item.mal_id) {
                valid.push(item);
            }
        }
        if filtered > 0 {
            warnings.push(format!(
                "Jikan returned {filtered} item(s) outside the requested season, year, or supported TV/TV_SHORT/ONA formats; they were omitted."
            ));
        }

        if valid.is_empty() {
            return Ok((Vec::new(), warnings));
        }

        let provider_ids = valid
            .iter()
            .map(|item| ProviderId::mal(item.mal_id))
            .collect::<HashSet<_>>();
        let resolution = self.identity.resolve_ids(&provider_ids, cache_dir).await?;
        warnings.extend(resolution.warnings);

        let mut missing_mappings = 0;
        let mut items = Vec::new();
        for anime in valid {
            let Some(anilist_id) = resolution
                .anilist_by_provider_id
                .get(&ProviderId::mal(anime.mal_id))
                .copied()
            else {
                missing_mappings += 1;
                continue;
            };
            let item = normalize_jikan_anime(anime, anilist_id)?;
            item.validate("Jikan")?;
            items.push(item);
        }

        if missing_mappings > 0 {
            warnings.push(format!(
                "{missing_mappings} Jikan item(s) were omitted because no verified canonical AniList mapping was available."
            ));
        }
        if missing_mappings > 0 && items.is_empty() {
            return Err(format!(
                "Jikan returned items, but none had verified canonical AniList mappings. {}",
                warnings.join(" ")
            ));
        }
        Ok((items, warnings))
    }
}

impl CatalogAdapter for JikanAdapter {
    fn descriptor(&self) -> CatalogProvider {
        CatalogProvider::new("jikan", "Jikan", CAPABILITIES)
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
            };
            Ok(CatalogResponse::new("jikan", &request, items, warnings))
        })
    }
}

impl JikanClient {
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
            .map_err(|_| "The Jikan request queue is unavailable.".to_string())?;
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
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.begin_cooldown(JIKAN_NETWORK_COOLDOWN)?;
                return Err(format!(
                    "Jikan is unreachable: {error}. This request will not retry automatically."
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
            let cooldown = jikan_retry_after(retry_after.as_deref());
            self.begin_cooldown(cooldown)?;
            return Err(format!(
                "Jikan is rate limiting requests. Try again in {} seconds; this request will not retry automatically.",
                cooldown.as_secs()
            ));
        }
        if status == StatusCode::FORBIDDEN {
            self.begin_cooldown(JIKAN_FORBIDDEN_COOLDOWN)?;
            return Err(
                "Jikan rejected this request (HTTP 403); this request will not retry automatically."
                    .into(),
            );
        }
        if status.is_server_error() {
            self.begin_cooldown(JIKAN_SERVER_COOLDOWN)?;
            return Err(format!(
                "Jikan returned an HTTP {status} server error; this request will not retry automatically."
            ));
        }
        if !status.is_success() {
            return Err(format!("Jikan returned an HTTP {status} error."));
        }

        let value = match read_bounded_json(response).await {
            Ok(value) => value,
            Err(error) => {
                self.begin_cooldown(JIKAN_NETWORK_COOLDOWN)?;
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
            .map_err(|_| "The Jikan request state is unavailable.".to_string())?;
        control.cache.retain(|_, entry| entry.expires_at > now);
        Ok(control.cache.get(key).map(|entry| entry.value.clone()))
    }

    fn cache(&self, key: String, value: Value) -> Result<(), String> {
        let now = Instant::now();
        let mut control = self
            .control
            .lock()
            .map_err(|_| "The Jikan request state is unavailable.".to_string())?;
        control.cache.retain(|_, entry| entry.expires_at > now);
        if !control.cache.contains_key(&key) && control.cache.len() >= JIKAN_CACHE_LIMIT {
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
                expires_at: now + JIKAN_CACHE_TTL,
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
            .map_err(|_| "The Jikan request state is unavailable.".to_string())?;
        reserve_jikan_request(&mut control, now)
    }

    fn check_cooldown(&self) -> Result<(), String> {
        let mut control = self
            .control
            .lock()
            .map_err(|_| "The Jikan request state is unavailable.".to_string())?;
        ensure_jikan_available(&mut control, Instant::now())
    }

    fn begin_cooldown(&self, duration: Duration) -> Result<(), String> {
        let mut control = self
            .control
            .lock()
            .map_err(|_| "The Jikan request state is unavailable.".to_string())?;
        control.cooldown_until = Some(Instant::now() + duration);
        Ok(())
    }
}

fn reserve_jikan_request(control: &mut RequestControl, now: Instant) -> Result<Duration, String> {
    ensure_jikan_available(control, now)?;
    let request_at = control.next_request_at.max(now);
    control.next_request_at = request_at + JIKAN_REQUEST_INTERVAL;
    Ok(request_at.saturating_duration_since(now))
}

fn ensure_jikan_available(control: &mut RequestControl, now: Instant) -> Result<(), String> {
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
        "Jikan requests are cooling down. Try again in {seconds} seconds."
    ))
}

fn jikan_retry_after(retry_after: Option<&str>) -> Duration {
    let seconds = retry_after
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(JIKAN_DEFAULT_RATE_COOLDOWN_SECONDS)
        .clamp(1, JIKAN_MAX_RATE_COOLDOWN_SECONDS);
    Duration::from_secs(seconds)
}

fn jikan_url(segments: &[&str], query: &[(&str, String)]) -> Result<Url, String> {
    let mut url = Url::parse(JIKAN_API_BASE)
        .map_err(|error| format!("The Jikan endpoint is invalid: {error}"))?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| "The Jikan endpoint cannot contain path segments.".to_string())?;
        path.pop_if_empty();
        for segment in segments {
            path.push(segment);
        }
    }
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
        .is_some_and(|length| length > JIKAN_MAX_RESPONSE_BYTES as u64)
    {
        return Err("The Jikan response is too large.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("The Jikan response could not be read: {error}"))?
    {
        append_bounded(&mut bytes, &chunk, JIKAN_MAX_RESPONSE_BYTES)?;
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("Jikan returned invalid JSON: {error}"))
}

fn append_bounded(target: &mut Vec<u8>, chunk: &[u8], max_bytes: usize) -> Result<(), String> {
    if chunk.len() > max_bytes.saturating_sub(target.len()) {
        return Err("The Jikan response is too large.".into());
    }
    target.extend_from_slice(chunk);
    Ok(())
}

fn parse_jikan_page(
    value: Value,
    expected_page: usize,
    item_limit: usize,
) -> Result<JikanPage, String> {
    let data_len = value
        .get("data")
        .and_then(Value::as_array)
        .map(Vec::len)
        .ok_or_else(|| "Jikan returned an invalid data page.".to_string())?;
    if data_len > item_limit {
        return Err("Jikan returned more items than requested.".into());
    }
    let page: JikanPage = serde_json::from_value(value)
        .map_err(|error| format!("Jikan returned invalid pagination or media data: {error}"))?;
    validate_pagination(&page.pagination, expected_page, data_len)?;
    Ok(page)
}

fn validate_pagination(
    pagination: &JikanPagination,
    expected_page: usize,
    item_count: usize,
) -> Result<(), String> {
    let expected_page = expected_page as u64;
    if expected_page == 1
        && pagination.current_page == 1
        && pagination.last_visible_page == 0
        && !pagination.has_next_page
        && item_count == 0
    {
        return Ok(());
    }
    if pagination.current_page != expected_page
        || pagination.current_page == 0
        || pagination.last_visible_page < pagination.current_page
        || pagination.last_visible_page > JIKAN_MAX_REPORTED_PAGES
        || pagination.has_next_page != (pagination.current_page < pagination.last_visible_page)
        || (pagination.has_next_page && item_count == 0)
    {
        return Err("Jikan returned invalid pagination metadata.".into());
    }
    Ok(())
}

fn validate_jikan_anime(anime: &JikanAnime) -> Result<(), String> {
    if anime.mal_id <= 0
        || anime.mal_id > i64::from(i32::MAX)
        || anime.title.trim().is_empty()
        || !valid_jikan_text(&anime.title, 500)
        || anime
            .title_english
            .as_ref()
            .is_some_and(|value| !valid_jikan_text(value, 500))
        || anime
            .title_japanese
            .as_ref()
            .is_some_and(|value| !valid_jikan_text(value, 500))
        || anime.title_synonyms.len() > 100
        || anime
            .title_synonyms
            .iter()
            .any(|value| !valid_jikan_text(value, 500))
        || anime.genres.len() > 100
        || anime
            .genres
            .iter()
            .any(|genre| !valid_jikan_text(&genre.name, 100))
        || anime.synopsis.as_ref().is_some_and(|value| {
            value.len() > 100_000
                || value.chars().any(|character| {
                    character.is_control() && !matches!(character, '\n' | '\r' | '\t')
                })
        })
        || anime
            .episodes
            .is_some_and(|value| value <= 0 || value > 100_000)
        || anime.members.is_some_and(|value| value < 0)
        || anime
            .score
            .is_some_and(|value| !value.is_finite() || !(0.0..=10.0).contains(&value))
    {
        return Err("Jikan returned an invalid anime item.".into());
    }
    Ok(())
}

fn valid_jikan_text(value: &str, max_len: usize) -> bool {
    value.len() <= max_len && !value.chars().any(char::is_control)
}

fn matches_requested_season(anime: &JikanAnime, season: CatalogSeason, year: i32) -> bool {
    anime.year == Some(year)
        && anime
            .season
            .as_deref()
            .and_then(parse_jikan_season)
            .is_some_and(|actual| actual == season)
        && matches!(
            jikan_format(anime.media_type.as_deref()),
            Some("TV" | "TV_SHORT" | "ONA")
        )
}

fn parse_jikan_season(value: &str) -> Option<CatalogSeason> {
    match value.trim().to_ascii_lowercase().as_str() {
        "winter" => Some(CatalogSeason::Winter),
        "spring" => Some(CatalogSeason::Spring),
        "summer" => Some(CatalogSeason::Summer),
        "fall" => Some(CatalogSeason::Fall),
        _ => None,
    }
}

fn jikan_format(value: Option<&str>) -> Option<&'static str> {
    match value? {
        "TV" => Some("TV"),
        "TV_SHORT" | "TV Short" => Some("TV_SHORT"),
        "ONA" => Some("ONA"),
        "OVA" => Some("OVA"),
        "Movie" => Some("MOVIE"),
        "Special" | "TV Special" => Some("SPECIAL"),
        "Music" => Some("MUSIC"),
        _ => None,
    }
}

fn normalize_jikan_anime(mut anime: JikanAnime, anilist_id: i64) -> Result<CatalogMedia, String> {
    anime.title_english = anime.title_english.filter(|title| !title.trim().is_empty());
    anime.title_japanese = anime
        .title_japanese
        .filter(|title| !title.trim().is_empty());
    let (season, season_year) = match (
        anime.season.as_deref().and_then(parse_jikan_season),
        anime.year,
    ) {
        (Some(season), Some(year)) if (1940..=2200).contains(&year) => (Some(season), Some(year)),
        _ => (None, None),
    };
    let preferred = anime.title_english.as_ref().unwrap_or(&anime.title).clone();
    let cover_image = anime
        .images
        .jpg
        .large_image_url
        .or(anime.images.jpg.image_url)
        .map(|large| CatalogCoverImage {
            extra_large: None,
            large: Some(large),
            color: None,
        });
    let trailer = anime.trailer.youtube_id.map(|id| {
        let thumbnail = anime
            .trailer
            .images
            .maximum_image_url
            .or(anime.trailer.images.large_image_url);
        json!({ "id": id, "site": "youtube", "thumbnail": thumbnail })
    });
    let status = match anime.status.as_deref() {
        Some("Finished Airing") => Some("FINISHED".into()),
        Some("Currently Airing") => Some("RELEASING".into()),
        Some("Not yet aired") => Some("NOT_YET_RELEASED".into()),
        _ => None,
    };
    let average_score = anime.score.map(|score| (score * 10.0).round() as i64);
    let genres = (!anime.genres.is_empty())
        .then(|| anime.genres.into_iter().map(|genre| genre.name).collect());
    let synonyms = (!anime.title_synonyms.is_empty()).then_some(anime.title_synonyms);

    Ok(CatalogMedia {
        id: anilist_id,
        id_mal: Some(anime.mal_id),
        title: CatalogTitle {
            romaji: Some(anime.title),
            english: anime.title_english,
            native: anime.title_japanese,
            user_preferred: Some(preferred),
        },
        synonyms,
        description: anime.synopsis,
        trailer,
        cover_image,
        banner_image: None,
        genres,
        season,
        season_year,
        start_date: anime.aired.from.as_deref().and_then(jikan_date),
        end_date: anime.aired.to.as_deref().and_then(jikan_date),
        format: jikan_format(anime.media_type.as_deref()).map(str::to_owned),
        status,
        episodes: anime.episodes,
        duration: None,
        average_score,
        popularity: anime.members,
        site_url: anime.url,
        next_airing_episode: None,
        relations: None,
    })
}

fn jikan_date(value: &str) -> Option<Value> {
    let date = value.get(..10)?;
    let mut parts = date.split('-');
    let year = parts.next()?.parse::<i32>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    let day = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some()
        || !(1940..=2200).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
    {
        return None;
    }
    Some(json!({ "year": year, "month": month, "day": day }))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        time::{Duration, Instant},
    };

    use super::{
        append_bounded, jikan_retry_after, jikan_url, normalize_jikan_anime, parse_jikan_page,
        reserve_jikan_request, JikanAnime, RequestControl, JIKAN_MAX_RESPONSE_BYTES,
        JIKAN_REQUEST_INTERVAL,
    };

    #[test]
    fn builds_only_fixed_jikan_urls_with_encoded_inputs() {
        let url = jikan_url(
            &["anime"],
            &[("q", "Frieren & Fern".into()), ("sfw", "true".into())],
        )
        .unwrap();
        assert_eq!(url.origin().ascii_serialization(), "https://api.jikan.moe");
        assert_eq!(url.path(), "/v4/anime");
        assert!(url.query().unwrap().contains("q=Frieren+%26+Fern"));
    }

    #[test]
    fn validates_pagination_and_page_bounds() {
        let valid = serde_json::json!({
            "pagination": {
                "last_visible_page": 2,
                "has_next_page": true,
                "current_page": 1
            },
            "data": [{ "mal_id": 1, "title": "Valid" }]
        });
        assert!(parse_jikan_page(valid, 1, 25).is_ok());

        let wrong_page = serde_json::json!({
            "pagination": {
                "last_visible_page": 2,
                "has_next_page": true,
                "current_page": 2
            },
            "data": []
        });
        assert!(parse_jikan_page(wrong_page, 1, 25).is_err());

        let too_many = serde_json::json!({
            "pagination": {
                "last_visible_page": 1,
                "has_next_page": false,
                "current_page": 1
            },
            "data": vec![serde_json::json!({}); 26]
        });
        assert!(parse_jikan_page(too_many, 1, 25).is_err());
    }

    #[test]
    fn accepts_a_genuine_empty_page_but_rejects_empty_continuations() {
        for last_page in [0, 1] {
            let empty = serde_json::json!({
                "pagination": {"last_visible_page": last_page, "current_page": 1, "has_next_page": false},
                "data": []
            });
            assert!(parse_jikan_page(empty, 1, 25).is_ok());
        }
        let invalid = serde_json::json!({
            "pagination": {"last_visible_page": 2, "current_page": 1, "has_next_page": true},
            "data": []
        });
        assert!(parse_jikan_page(invalid, 1, 25).is_err());
    }

    #[tokio::test]
    async fn omits_unknown_ids_and_never_returns_an_unmapped_empty_catalog() {
        let directory = tempfile::tempdir().unwrap();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        std::fs::write(
            directory.path().join("identity-fribb-v1.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": 1, "fetchedAt": timestamp,
                "entries": [{"anilistId": 700, "providerIds": {"mal": 1}}]
            }))
            .unwrap(),
        )
        .unwrap();
        let client = reqwest::Client::new();
        let adapter = super::JikanAdapter::new(
            client.clone(),
            std::sync::Arc::new(super::IdentityResolver::new(client)),
        );
        let anime = |id| {
            serde_json::from_value::<JikanAnime>(serde_json::json!({
                "mal_id": id, "title": "Example", "type": "TV", "season": "summer", "year": 2026
            }))
            .unwrap()
        };
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
        assert_eq!(items[0].id_mal, Some(1));
        assert!(warnings.iter().any(|warning| warning.contains("omitted")));
        for season in [None, Some((super::CatalogSeason::Summer, 2026))] {
            assert!(adapter
                .map_results(vec![anime(999)], season, directory.path(), Vec::new())
                .await
                .is_err());
        }
    }

    #[test]
    fn validates_media_and_never_fabricates_a_season() {
        let mut anime: JikanAnime = serde_json::from_value(serde_json::json!({
            "mal_id": 42, "title": "Example", "type": "TV", "season": "summer", "year": 2026
        }))
        .unwrap();
        assert!(super::matches_requested_season(
            &anime,
            super::CatalogSeason::Summer,
            2026
        ));
        assert!(!super::matches_requested_season(
            &anime,
            super::CatalogSeason::Winter,
            2026
        ));
        anime.year = None;
        assert!(!super::matches_requested_season(
            &anime,
            super::CatalogSeason::Summer,
            2026
        ));
        assert!(normalize_jikan_anime(anime, 7).unwrap().season.is_none());
        for invalid in [
            serde_json::json!({"mal_id": 0, "title": "Example"}),
            serde_json::json!({"mal_id": 1, "title": "Example", "score": 12}),
            serde_json::json!({"mal_id": 1, "title": "Example", "episodes": -1}),
        ] {
            let anime: JikanAnime = serde_json::from_value(invalid).unwrap();
            assert!(super::validate_jikan_anime(&anime).is_err());
        }
    }

    #[test]
    fn rejects_requests_during_cooldown_and_recovers_after_expiry() {
        let now = Instant::now();
        let mut control = RequestControl {
            cache: HashMap::new(),
            cooldown_until: Some(now + Duration::from_secs(30)),
            next_request_at: now,
        };
        assert!(reserve_jikan_request(&mut control, now).is_err());
        assert!(reserve_jikan_request(&mut control, now + Duration::from_secs(31)).is_ok());
    }

    #[test]
    fn bounds_rate_limit_cooldowns_and_response_bytes() {
        assert_eq!(jikan_retry_after(Some("0")), Duration::from_secs(1));
        assert_eq!(jikan_retry_after(Some("9999")), Duration::from_secs(300));
        assert_eq!(jikan_retry_after(None), Duration::from_secs(30));

        let mut bytes = vec![0; 2];
        append_bounded(&mut bytes, &[1, 2], 4).unwrap();
        assert!(append_bounded(&mut bytes, &[3], 4).is_err());
        assert_eq!(JIKAN_MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
    }

    #[test]
    fn spaces_serialized_jikan_requests_by_at_least_two_point_one_seconds() {
        let now = Instant::now();
        let mut control = RequestControl {
            cache: HashMap::new(),
            cooldown_until: None,
            next_request_at: now,
        };
        assert_eq!(
            reserve_jikan_request(&mut control, now).unwrap(),
            Duration::ZERO
        );
        assert_eq!(
            reserve_jikan_request(&mut control, now).unwrap(),
            JIKAN_REQUEST_INTERVAL
        );
    }

    #[test]
    fn normalizes_jikan_to_anilist_shaped_canonical_cards() {
        let anime: JikanAnime = serde_json::from_value(serde_json::json!({
            "mal_id": 5114,
            "title": "Hagane no Renkinjutsushi: Fullmetal Alchemist",
            "title_english": "Fullmetal Alchemist: Brotherhood",
            "title_japanese": "鋼の錬金術師",
            "title_synonyms": ["FMA:B"],
            "url": "https://myanimelist.net/anime/5114",
            "images": { "jpg": { "large_image_url": "https://cdn.myanimelist.net/example.jpg" } },
            "trailer": { "youtube_id": "abc", "images": {} },
            "type": "TV",
            "episodes": 64,
            "status": "Finished Airing",
            "aired": { "from": "2009-04-05T00:00:00+00:00", "to": "2010-07-04T00:00:00+00:00" },
            "score": 9.1,
            "popularity": 3,
            "members": 4000,
            "synopsis": "Two brothers search for the Philosopher's Stone.",
            "season": "spring",
            "year": 2009,
            "genres": [{ "name": "Action" }]
        }))
        .unwrap();
        let media = normalize_jikan_anime(anime, 11061).unwrap();
        let value = serde_json::to_value(media).unwrap();
        assert_eq!(value["id"], 11061);
        assert_eq!(value["idMal"], 5114);
        assert_eq!(value["season"], "SPRING");
        assert_eq!(value["format"], "TV");
        assert_eq!(value["averageScore"], 91);
        assert_eq!(value["popularity"], 4000);
    }
}
