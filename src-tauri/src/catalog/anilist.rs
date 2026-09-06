use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use reqwest::StatusCode;
use serde_json::Value;
use tauri::State;
use tokio::sync::Semaphore;

use super::{
    identity::IdentityResolver, validate_recommendation_ids, AdapterFuture, CatalogAdapter,
    CatalogCapability, CatalogMedia, CatalogProvider, CatalogRequest, CatalogResponse,
    CatalogState,
};

const ANILIST_ENDPOINT: &str = "https://graphql.anilist.co";
const ANILIST_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const ANILIST_CACHE_LIMIT: usize = 128;
const ANILIST_REQUEST_INTERVAL: Duration = Duration::from_millis(2_100);
const ANILIST_MAX_CONCURRENT_REQUESTS: usize = 2;
const ANILIST_DEFAULT_COOLDOWN_SECONDS: u64 = 30;
const ANILIST_MAX_COOLDOWN_SECONDS: u64 = 5 * 60;
const ANILIST_BLOCKED_COOLDOWN: Duration = Duration::from_secs(5 * 60);
const MAX_SEASON_PAGES: usize = 3;
const ANILIST_RECOMMENDATIONS_PER_SEED: usize = 10;
const ANILIST_RECOMMENDATION_LIMIT: usize = 50;
const CAPABILITIES: &[CatalogCapability] = &[
    CatalogCapability::Search,
    CatalogCapability::Season,
    CatalogCapability::Recommendations,
];
const METADATA_FRAGMENT: &str = r#"
    fragment Metadata on Media {
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
        averageScore
        popularity
        source(version: 3)
        countryOfOrigin
        tags { id name rank isGeneralSpoiler isMediaSpoiler }
        studios(isMain: true) {
            nodes { id name isAnimationStudio siteUrl }
        }
        nextAiringEpisode { episode airingAt timeUntilAiring }
        streamingEpisodes { title thumbnail site }
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
"#;
const RECOMMENDATION_FRAGMENT: &str = r#"
    fragment RecommendationCard on Media {
        id
        idMal
        isAdult
        title { romaji english native userPreferred }
        synonyms
        coverImage { extraLarge large color }
        season
        seasonYear
        format
        status
        episodes
        averageScore
        popularity
        siteUrl
    }
"#;

struct CacheEntry {
    expires_at: Instant,
    value: Value,
}

struct RequestControl {
    cache: HashMap<String, CacheEntry>,
    blocked_until: Option<Instant>,
    cooldown_until: Option<Instant>,
    next_request_at: Instant,
}

pub(super) struct AniListClient {
    http: reqwest::Client,
    in_flight: Semaphore,
    control: Mutex<RequestControl>,
}

pub(super) struct AniListAdapter {
    client: Arc<AniListClient>,
    identity: Arc<IdentityResolver>,
}

impl AniListClient {
    pub(super) fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            in_flight: Semaphore::new(ANILIST_MAX_CONCURRENT_REQUESTS),
            control: Mutex::new(RequestControl {
                cache: HashMap::new(),
                blocked_until: None,
                cooldown_until: None,
                next_request_at: Instant::now(),
            }),
        }
    }

    async fn request(&self, query: &str, variables: Value) -> Result<Value, String> {
        let body = serde_json::json!({ "query": query, "variables": variables });
        let cache_key = serde_json::to_string(&body)
            .map_err(|error| format!("The AniList request could not be prepared: {error}"))?;
        if let Some(value) = self.cached(&cache_key)? {
            return Ok(value);
        }

        let _permit = self
            .in_flight
            .acquire()
            .await
            .map_err(|_| "The AniList request queue is unavailable.".to_string())?;
        if let Some(value) = self.cached(&cache_key)? {
            return Ok(value);
        }

        let wait = self.reserve_request()?;
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        self.check_request_availability()?;

        let response = self
            .http
            .post(ANILIST_ENDPOINT)
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("AniList is unreachable: {error}"))?;
        let status = response.status();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        if status == StatusCode::TOO_MANY_REQUESTS {
            self.begin_cooldown(retry_after.as_deref())?;
            return Err(anilist_rate_limit_message(retry_after.as_deref()));
        }
        if status == StatusCode::FORBIDDEN {
            let response_body = response.text().await.unwrap_or_default();
            self.begin_blocked_cooldown()?;
            return Err(anilist_blocked_message(&response_body));
        }
        let response_body = response
            .text()
            .await
            .map_err(|error| format!("The AniList response could not be read: {error}"))?;
        let value = parse_anilist_response(status, retry_after.as_deref(), &response_body)?;
        self.cache(cache_key, value.clone())?;
        Ok(value)
    }

    fn cached(&self, key: &str) -> Result<Option<Value>, String> {
        let now = Instant::now();
        let mut control = self
            .control
            .lock()
            .map_err(|_| "The AniList request state is unavailable.".to_string())?;
        control.cache.retain(|_, entry| entry.expires_at > now);
        Ok(control.cache.get(key).map(|entry| entry.value.clone()))
    }

    fn cache(&self, key: String, value: Value) -> Result<(), String> {
        let now = Instant::now();
        let mut control = self
            .control
            .lock()
            .map_err(|_| "The AniList request state is unavailable.".to_string())?;
        control.cache.retain(|_, entry| entry.expires_at > now);
        if !control.cache.contains_key(&key) && control.cache.len() >= ANILIST_CACHE_LIMIT {
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
                expires_at: now + ANILIST_CACHE_TTL,
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
            .map_err(|_| "The AniList request state is unavailable.".to_string())?;
        ensure_request_available(&mut control, now)?;
        let request_at = control.next_request_at.max(now);
        control.next_request_at = request_at + ANILIST_REQUEST_INTERVAL;
        Ok(request_at.saturating_duration_since(now))
    }

    fn check_request_availability(&self) -> Result<(), String> {
        let mut control = self
            .control
            .lock()
            .map_err(|_| "The AniList request state is unavailable.".to_string())?;
        ensure_request_available(&mut control, Instant::now())
    }

    fn begin_blocked_cooldown(&self) -> Result<(), String> {
        let mut control = self
            .control
            .lock()
            .map_err(|_| "The AniList request state is unavailable.".to_string())?;
        control.blocked_until = Some(Instant::now() + ANILIST_BLOCKED_COOLDOWN);
        Ok(())
    }

    fn begin_cooldown(&self, retry_after: Option<&str>) -> Result<(), String> {
        let seconds =
            bounded_retry_after_seconds(retry_after).unwrap_or(ANILIST_DEFAULT_COOLDOWN_SECONDS);
        let mut control = self
            .control
            .lock()
            .map_err(|_| "The AniList request state is unavailable.".to_string())?;
        control.cooldown_until = Some(Instant::now() + Duration::from_secs(seconds));
        Ok(())
    }

    pub(super) async fn metadata_by_title(&self, title: &str) -> Result<Option<Value>, String> {
        validate_anilist_search(title)?;
        let (query, variables) = metadata_by_title_request(title);
        let response = self.request(&query, variables).await?;
        best_metadata_match(title, &response)
    }

    pub(super) async fn metadata_by_id(&self, id: i64) -> Result<Option<Value>, String> {
        validate_anilist_id(id)?;
        let (query, variables) = metadata_by_id_request(id);
        media_from_response(&self.request(&query, variables).await?)
    }

    async fn season(&self, season: &str, year: i32) -> Result<Vec<Value>, String> {
        let (query, variables) = season_request(season, year);
        let response = self.request(query, variables).await?;
        season_shows(&response)
    }

    async fn search(&self, query: &str) -> Result<Vec<Value>, String> {
        validate_anilist_search(query)?;
        let (request, variables) = search_request(query);
        let response = self.request(request, variables).await?;
        Ok(media_array(&response, "/data/Page/media", "search results")?.clone())
    }

    async fn recommendations(&self, ids: &[i64]) -> Result<AniListRecommendations, String> {
        validate_recommendation_ids(ids)?;
        let (query, variables) = recommendations_request(ids);
        let response = self.request(&query, variables).await?;
        recommendation_shows(&response, ids)
    }
}

struct AniListRecommendations {
    values: Vec<Value>,
    matched_seed_count: usize,
    omitted_count: usize,
}

struct RecommendationAggregate {
    media: Value,
    seed_ids: HashSet<i64>,
    rating: i64,
}

fn metadata_by_title_request(title: &str) -> (String, Value) {
    let [exact, normalized, short] = anilist_search_queries(title);
    let query = [
        r#"
            query CatalogMetadataByTitle($exact: String!, $normalized: String!, $short: String!) {
                exact: Page(page: 1, perPage: 6) {
                    media(search: $exact, type: ANIME) { ...Metadata }
                }
                normalized: Page(page: 1, perPage: 6) {
                    media(search: $normalized, type: ANIME) { ...Metadata }
                }
                short: Page(page: 1, perPage: 6) {
                    media(search: $short, type: ANIME) { ...Metadata }
                }
            }
        "#,
        METADATA_FRAGMENT,
    ]
    .concat();
    (
        query,
        serde_json::json!({
            "exact": exact,
            "normalized": normalized,
            "short": short
        }),
    )
}

fn metadata_by_id_request(id: i64) -> (String, Value) {
    (
        [
            r#"
                query CatalogMetadataById($id: Int!) {
                    Media(id: $id, type: ANIME) { ...Metadata }
                }
            "#,
            METADATA_FRAGMENT,
        ]
        .concat(),
        serde_json::json!({ "id": id }),
    )
}

fn season_request(season: &str, year: i32) -> (&'static str, Value) {
    (
        r#"
            query CatalogSeason($season: MediaSeason!, $year: Int!) {
                page1: Page(page: 1, perPage: 50) { media(type: ANIME, season: $season, seasonYear: $year, format_in: [TV, TV_SHORT, ONA], isAdult: false, sort: [POPULARITY_DESC, START_DATE]) { ...SeasonCard } }
                page2: Page(page: 2, perPage: 50) { media(type: ANIME, season: $season, seasonYear: $year, format_in: [TV, TV_SHORT, ONA], isAdult: false, sort: [POPULARITY_DESC, START_DATE]) { ...SeasonCard } }
                page3: Page(page: 3, perPage: 50) { media(type: ANIME, season: $season, seasonYear: $year, format_in: [TV, TV_SHORT, ONA], isAdult: false, sort: [POPULARITY_DESC, START_DATE]) { ...SeasonCard } }
            }
            fragment SeasonCard on Media {
                id
                idMal
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
                relations {
                    edges {
                        relationType
                        node { id type format title { romaji english native userPreferred } }
                    }
                }
            }
        "#,
        serde_json::json!({ "season": season, "year": year }),
    )
}

fn search_request(query: &str) -> (&'static str, Value) {
    (
        r#"
            query CatalogSearch($search: String!) {
                Page(page: 1, perPage: 10) {
                    media(search: $search, type: ANIME, isAdult: false) {
                        id
                        idMal
                        title { romaji english native userPreferred }
                        synonyms
                        coverImage { extraLarge large color }
                        season
                        seasonYear
                        format
                        status
                        episodes
                    }
                }
            }
        "#,
        serde_json::json!({ "search": query.trim() }),
    )
}

fn recommendations_request(ids: &[i64]) -> (String, Value) {
    (
        [
            r#"
                query CatalogRecommendations($ids: [Int!]!) {
                    Page(page: 1, perPage: 20) {
                        media(id_in: $ids, type: ANIME) {
                            id
                            recommendations(page: 1, perPage: 10, sort: [RATING_DESC, ID]) {
                                nodes {
                                    rating
                                    mediaRecommendation { ...RecommendationCard }
                                }
                            }
                        }
                    }
                }
            "#,
            RECOMMENDATION_FRAGMENT,
        ]
        .concat(),
        serde_json::json!({ "ids": ids }),
    )
}

fn recommendation_shows(
    response: &Value,
    requested_ids: &[i64],
) -> Result<AniListRecommendations, String> {
    let requested = requested_ids.iter().copied().collect::<HashSet<_>>();
    let sources = media_array(response, "/data/Page/media", "recommendation seed results")?;
    let mut seen_sources = HashSet::new();
    let mut seen_pairs = HashSet::new();
    let mut recommendations = HashMap::<i64, RecommendationAggregate>::new();

    for source in sources {
        let source_id = source
            .get("id")
            .and_then(Value::as_i64)
            .filter(|id| requested.contains(id))
            .ok_or_else(|| "AniList returned an invalid recommendation seed.".to_string())?;
        if !seen_sources.insert(source_id) {
            return Err("AniList returned a duplicate recommendation seed.".into());
        }
        let nodes = source
            .pointer("/recommendations/nodes")
            .and_then(Value::as_array)
            .ok_or_else(|| "AniList returned invalid recommendations.".to_string())?;
        if nodes.len() > ANILIST_RECOMMENDATIONS_PER_SEED {
            return Err("AniList returned more recommendations than requested.".into());
        }
        for node in nodes {
            let rating = match node.get("rating") {
                None | Some(Value::Null) => 0,
                Some(value) => value.as_i64().ok_or_else(|| {
                    "AniList returned an invalid recommendation rating.".to_string()
                })?,
            };
            let Some(media) = node.get("mediaRecommendation") else {
                return Err("AniList returned an invalid recommendation item.".into());
            };
            if media.is_null() {
                continue;
            }
            let media = media
                .as_object()
                .ok_or_else(|| "AniList returned an invalid recommendation item.".to_string())?;
            let id = media
                .get("id")
                .and_then(Value::as_i64)
                .filter(|id| super::valid_catalog_id(*id))
                .ok_or_else(|| "AniList returned an invalid recommendation item.".to_string())?;
            let is_adult = match media.get("isAdult") {
                None | Some(Value::Null) => true,
                Some(Value::Bool(is_adult)) => *is_adult,
                Some(_) => return Err("AniList returned an invalid recommendation item.".into()),
            };
            if is_adult || requested.contains(&id) || !seen_pairs.insert((source_id, id)) {
                continue;
            }
            let aggregate = recommendations
                .entry(id)
                .or_insert_with(|| RecommendationAggregate {
                    media: Value::Object(media.clone()),
                    seed_ids: HashSet::new(),
                    rating: 0,
                });
            aggregate.seed_ids.insert(source_id);
            aggregate.rating = aggregate.rating.saturating_add(rating.max(0));
        }
    }

    let mut recommendations = recommendations.into_values().collect::<Vec<_>>();
    recommendations.sort_by(|left, right| {
        right
            .seed_ids
            .len()
            .cmp(&left.seed_ids.len())
            .then_with(|| right.rating.cmp(&left.rating))
            .then_with(|| {
                right
                    .media
                    .get("popularity")
                    .and_then(Value::as_i64)
                    .unwrap_or_default()
                    .cmp(
                        &left
                            .media
                            .get("popularity")
                            .and_then(Value::as_i64)
                            .unwrap_or_default(),
                    )
            })
            .then_with(|| {
                left.media["id"]
                    .as_i64()
                    .unwrap_or_default()
                    .cmp(&right.media["id"].as_i64().unwrap_or_default())
            })
    });
    let omitted_count = recommendations
        .len()
        .saturating_sub(ANILIST_RECOMMENDATION_LIMIT);
    recommendations.truncate(ANILIST_RECOMMENDATION_LIMIT);
    Ok(AniListRecommendations {
        values: recommendations
            .into_iter()
            .map(|recommendation| recommendation.media)
            .collect(),
        matched_seed_count: seen_sources.len(),
        omitted_count,
    })
}

impl AniListAdapter {
    pub(super) fn new(client: Arc<AniListClient>, identity: Arc<IdentityResolver>) -> Self {
        Self { client, identity }
    }

    async fn normalize_and_learn(
        &self,
        values: Vec<Value>,
        cache_dir: &std::path::Path,
    ) -> Result<(Vec<CatalogMedia>, Vec<String>), String> {
        let items = values
            .into_iter()
            .map(CatalogMedia::from_anilist)
            .collect::<Result<Vec<_>, _>>()?;
        let mappings = items
            .iter()
            .filter_map(|item| item.id_mal.map(|mal_id| (item.id, mal_id)))
            .collect::<Vec<_>>();
        let mut warnings = Vec::new();
        if let Err(error) = self
            .identity
            .learn_anilist_mappings(&mappings, cache_dir)
            .await
        {
            warnings.push(format!(
                "AniList identity mappings could not be saved: {error}"
            ));
        }
        Ok((items, warnings))
    }
}

impl CatalogAdapter for AniListAdapter {
    fn descriptor(&self) -> CatalogProvider {
        CatalogProvider::new("anilist", "AniList", CAPABILITIES)
    }

    fn request<'a>(&'a self, request: CatalogRequest, cache_dir: PathBuf) -> AdapterFuture<'a> {
        Box::pin(async move {
            let (items, warnings) = match &request {
                CatalogRequest::Search { query } => {
                    let values = self.client.search(query).await?;
                    self.normalize_and_learn(values, &cache_dir).await?
                }
                CatalogRequest::Season { season, year } => {
                    let values = self.client.season(season.as_str(), *year).await?;
                    self.normalize_and_learn(values, &cache_dir).await?
                }
                CatalogRequest::Recommendations { ids } => {
                    let result = self.client.recommendations(ids).await?;
                    let (items, mut warnings) =
                        self.normalize_and_learn(result.values, &cache_dir).await?;
                    if result.matched_seed_count < ids.len() {
                        warnings.push(format!(
                            "AniList found {} of {} recommendation seed(s).",
                            result.matched_seed_count,
                            ids.len()
                        ));
                    }
                    if result.omitted_count > 0 {
                        warnings.push(format!(
                            "AniList recommendations were limited to {ANILIST_RECOMMENDATION_LIMIT} items; {} additional recommendation(s) were omitted.",
                            result.omitted_count
                        ));
                    }
                    (items, warnings)
                }
            };
            Ok(CatalogResponse::new("anilist", &request, items, warnings))
        })
    }
}

fn ensure_request_available(control: &mut RequestControl, now: Instant) -> Result<(), String> {
    if control.blocked_until.is_some_and(|until| until > now) {
        return Err(anilist_blocked_message(""));
    }
    control.blocked_until = None;

    let Some(cooldown_until) = control.cooldown_until else {
        return Ok(());
    };
    if cooldown_until <= now {
        control.cooldown_until = None;
        return Ok(());
    }
    let remaining = cooldown_until.saturating_duration_since(now);
    let seconds = remaining.as_secs() + u64::from(remaining.subsec_nanos() > 0);
    Err(format!(
        "AniList is rate limiting requests. Try again in {seconds} seconds."
    ))
}

fn bounded_retry_after_seconds(retry_after: Option<&str>) -> Option<u64> {
    retry_after
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| seconds.clamp(1, ANILIST_MAX_COOLDOWN_SECONDS))
}

fn anilist_rate_limit_message(retry_after: Option<&str>) -> String {
    match bounded_retry_after_seconds(retry_after) {
        Some(seconds) => {
            format!("AniList is rate limiting requests. Try again in {seconds} seconds.")
        }
        None => "AniList is rate limiting requests. Try again shortly.".into(),
    }
}

fn graphql_error_message(payload: &Value) -> Option<String> {
    let messages = payload
        .get("errors")?
        .as_array()?
        .iter()
        .filter_map(|error| error.get("message").and_then(Value::as_str))
        .map(|message| message.trim().chars().take(240).collect::<String>())
        .filter(|message| !message.is_empty())
        .take(3)
        .collect::<Vec<_>>();
    (!messages.is_empty()).then(|| messages.join("; "))
}

fn anilist_blocked_message(body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .as_ref()
        .and_then(graphql_error_message)
        .map(|message| format!(" AniList says: {message}"))
        .unwrap_or_default();
    format!(
        "AniList rejected this request (HTTP 403). HTTP 403 is distinct from HTTP 429 rate limiting and may have several causes. Use cached results if available or browse the SubsPlease Archive; this request will not retry automatically.{detail}"
    )
}

fn parse_anilist_response(
    status: StatusCode,
    retry_after: Option<&str>,
    body: &str,
) -> Result<Value, String> {
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err(anilist_rate_limit_message(retry_after));
    }

    if status == StatusCode::FORBIDDEN {
        return Err(anilist_blocked_message(body));
    }

    let payload = serde_json::from_str::<Value>(body);
    if !status.is_success() {
        return Err(format!("AniList returned an HTTP {status} error."));
    }

    let payload =
        payload.map_err(|error| format!("The AniList response could not be read: {error}"))?;
    if payload
        .get("errors")
        .is_some_and(|errors| !matches!(errors, Value::Array(items) if items.is_empty()))
    {
        return match graphql_error_message(&payload) {
            Some(error) => Err(format!("AniList returned a GraphQL error: {error}")),
            None => Err("AniList returned a GraphQL error without details.".into()),
        };
    }
    if !payload.get("data").is_some_and(Value::is_object) {
        return Err("AniList did not return valid GraphQL data.".into());
    }
    Ok(payload)
}

pub(super) fn validate_anilist_id(id: i64) -> Result<(), String> {
    if id <= 0 || id > i64::from(i32::MAX) {
        return Err("Invalid AniList ID.".into());
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

fn anilist_candidate_score(source: &str, candidate: &Value) -> f64 {
    let mut titles = Vec::new();
    for path in ["/title/romaji", "/title/english", "/title/native"] {
        if let Some(title) = candidate.pointer(path).and_then(Value::as_str) {
            titles.push(title);
        }
    }
    if let Some(synonyms) = candidate.get("synonyms").and_then(Value::as_array) {
        titles.extend(synonyms.iter().filter_map(Value::as_str));
    }
    titles
        .into_iter()
        .map(|title| anilist_title_similarity(source, title))
        .fold(0.0, f64::max)
}

const METADATA_MATCH_MIN_SCORE: f64 = 0.95;
const METADATA_MATCH_TIE_EPSILON: f64 = 0.000_001;

fn media_from_response(response: &Value) -> Result<Option<Value>, String> {
    let data = response
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| "AniList did not return valid media data.".to_string())?;
    match data.get("Media") {
        Some(Value::Null) => Ok(None),
        Some(media @ Value::Object(_)) => Ok(Some(media.clone())),
        _ => Err("AniList did not return valid media details.".into()),
    }
}

fn media_array<'a>(response: &'a Value, path: &str, label: &str) -> Result<&'a Vec<Value>, String> {
    response
        .pointer(path)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("AniList did not return valid {label}."))
}

fn best_metadata_match(title: &str, response: &Value) -> Result<Option<Value>, String> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for key in ["exact", "normalized", "short"] {
        for candidate in media_array(
            response,
            &format!("/data/{key}/media"),
            "metadata search results",
        )? {
            let Some(id) = candidate.get("id").and_then(Value::as_i64) else {
                continue;
            };
            if !seen.insert(id) {
                continue;
            }
            candidates.push((anilist_candidate_score(title, candidate), candidate.clone()));
        }
    }

    let Some((best_score, best)) = candidates
        .iter()
        .max_by(|left, right| left.0.total_cmp(&right.0))
    else {
        return Ok(None);
    };
    if *best_score < METADATA_MATCH_MIN_SCORE
        || candidates
            .iter()
            .filter(|(score, _)| (*score - *best_score).abs() < METADATA_MATCH_TIE_EPSILON)
            .count()
            != 1
    {
        return Ok(None);
    }
    Ok(Some(best.clone()))
}

pub(super) fn has_series_prequel(metadata: &Value) -> bool {
    metadata
        .pointer("/relations/edges")
        .and_then(Value::as_array)
        .is_some_and(|edges| {
            edges.iter().any(|edge| {
                edge.get("relationType").and_then(Value::as_str) == Some("PREQUEL")
                    && edge.pointer("/node/type").and_then(Value::as_str) == Some("ANIME")
                    && matches!(
                        edge.pointer("/node/format").and_then(Value::as_str),
                        Some("TV" | "TV_SHORT" | "ONA")
                    )
            })
        })
}

fn season_shows(response: &Value) -> Result<Vec<Value>, String> {
    let mut shows = Vec::new();
    for page in 1..=MAX_SEASON_PAGES {
        shows.extend(
            media_array(
                response,
                &format!("/data/page{page}/media"),
                "season results",
            )?
            .iter()
            .cloned(),
        );
    }
    Ok(shows)
}

#[tauri::command]
pub async fn anilist_season(
    state: State<'_, CatalogState>,
    season: String,
    year: i32,
) -> Result<Value, String> {
    let season = validate_anilist_season(&season, year)?;
    Ok(serde_json::json!({
        "season": season,
        "year": year,
        "shows": state.anilist.season(season, year).await?
    }))
}

#[tauri::command]
pub async fn anilist_search(
    state: State<'_, CatalogState>,
    query: String,
) -> Result<Value, String> {
    Ok(Value::Array(state.anilist.search(&query).await?))
}

#[cfg(test)]
mod tests {
    use super::{
        anilist_rate_limit_message, anilist_search_queries, anilist_title_similarity,
        best_metadata_match, has_series_prequel, media_from_response, metadata_by_id_request,
        metadata_by_title_request, normalize_anilist_title, parse_anilist_response,
        recommendation_shows, recommendations_request, search_request, season_request,
        season_shows, validate_anilist_id, validate_anilist_search, validate_anilist_season,
        ANILIST_RECOMMENDATIONS_PER_SEED,
    };
    use reqwest::StatusCode;

    #[test]
    fn validates_anilist_search_input() {
        assert!(validate_anilist_search("Young Ladies").is_ok());
        assert!(validate_anilist_search("x").is_err());
        assert!(validate_anilist_search("title\nquery").is_err());
    }

    #[test]
    fn validates_anilist_ids() {
        assert!(validate_anilist_id(1).is_ok());
        assert!(validate_anilist_id(0).is_err());
        assert!(validate_anilist_id(-1).is_err());
        assert!(validate_anilist_id(i64::from(i32::MAX) + 1).is_err());
    }

    #[test]
    fn builds_every_anilist_query_with_bounded_variables() {
        let (query, variables) = search_request("  Frieren  ");
        assert!(query.contains("query CatalogSearch"));
        assert!(query.contains("perPage: 10"));
        assert_eq!(variables, serde_json::json!({ "search": "Frieren" }));

        let (query, variables) = season_request("SUMMER", 2026);
        assert!(query.contains("query CatalogSeason"));
        assert!(query.contains("page3: Page(page: 3, perPage: 50)"));
        assert_eq!(
            variables,
            serde_json::json!({ "season": "SUMMER", "year": 2026 })
        );

        let (query, variables) = metadata_by_title_request("Example Show S2");
        assert!(query.contains("query CatalogMetadataByTitle"));
        assert!(query.contains("exact: Page(page: 1, perPage: 6)"));
        assert_eq!(variables["exact"], "Example Show S2");
        assert_eq!(variables["normalized"], "example show 2");

        let (query, variables) = metadata_by_id_request(154_587);
        assert!(query.contains("query CatalogMetadataById"));
        assert!(query.contains("Media(id: $id, type: ANIME)"));
        assert_eq!(variables, serde_json::json!({ "id": 154_587 }));

        let (query, variables) = recommendations_request(&[154_587, 11061]);
        assert!(query.contains("query CatalogRecommendations"));
        assert!(query.contains("media(id_in: $ids, type: ANIME)"));
        assert!(query.contains("perPage: 10"));
        assert!(query.contains("...RecommendationCard"));
        assert_eq!(variables, serde_json::json!({ "ids": [154_587, 11061] }));
    }

    #[test]
    fn aggregates_anilist_recommendations_across_liked_seeds() {
        let media = |id, title, adult| {
            serde_json::json!({
                "id": id,
                "idMal": id + 1000,
                "isAdult": adult,
                "title": { "romaji": title, "userPreferred": title },
                "popularity": id
            })
        };
        let response = serde_json::json!({
            "data": { "Page": { "media": [
                {
                    "id": 1,
                    "recommendations": { "nodes": [
                        { "rating": 5, "mediaRecommendation": media(10, "Shared", false) },
                        { "rating": 100, "mediaRecommendation": media(20, "Popular", false) },
                        { "rating": 500, "mediaRecommendation": media(30, "Adult", true) },
                        { "rating": 500, "mediaRecommendation": media(2, "Already liked", false) }
                    ] }
                },
                {
                    "id": 2,
                    "recommendations": { "nodes": [
                        { "rating": 1, "mediaRecommendation": media(10, "Shared", false) },
                        { "rating": null, "mediaRecommendation": media(40, "Other", false) },
                        { "rating": 500, "mediaRecommendation": {
                            "id": 50,
                            "isAdult": null,
                            "title": { "romaji": "Unknown rating" }
                        } }
                    ] }
                }
            ] } }
        });
        let recommendations = recommendation_shows(&response, &[1, 2]).unwrap();
        assert_eq!(recommendations.matched_seed_count, 2);
        assert_eq!(
            recommendations
                .values
                .iter()
                .map(|item| item["id"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            [10, 20, 40]
        );
        assert!(recommendations
            .values
            .iter()
            .all(|item| item["id"] != 2 && item["id"] != 30 && item["id"] != 50));
    }

    #[test]
    fn rejects_oversized_or_malformed_anilist_recommendation_fixtures() {
        let oversized = serde_json::json!({
            "data": { "Page": { "media": [{
                "id": 1,
                "recommendations": { "nodes": vec![serde_json::json!({
                    "rating": 1,
                    "mediaRecommendation": {
                        "id": 2,
                        "isAdult": false,
                        "title": { "romaji": "Example" }
                    }
                }); ANILIST_RECOMMENDATIONS_PER_SEED + 1] }
            }] } }
        });
        assert!(recommendation_shows(&oversized, &[1]).is_err());
        assert!(recommendation_shows(
            &serde_json::json!({
                "data": { "Page": { "media": [{
                    "id": 999,
                    "recommendations": { "nodes": [] }
                }] } }
            }),
            &[1]
        )
        .is_err());
    }

    #[test]
    fn explains_anilist_rate_limits_and_bounds_cooldown() {
        assert_eq!(
            anilist_rate_limit_message(Some("42")),
            "AniList is rate limiting requests. Try again in 42 seconds."
        );
        assert_eq!(
            anilist_rate_limit_message(None),
            "AniList is rate limiting requests. Try again shortly."
        );
        assert_eq!(
            anilist_rate_limit_message(Some("9999")),
            "AniList is rate limiting requests. Try again in 300 seconds."
        );
    }

    #[test]
    fn reports_anilist_403_as_blocked_access() {
        let error = parse_anilist_response(
            StatusCode::FORBIDDEN,
            None,
            r#"{"errors":[{"message":"API temporarily disabled"}],"data":null}"#,
        )
        .unwrap_err();
        assert!(error.contains("rejected this request (HTTP 403)"));
        assert!(error.contains("distinct from HTTP 429 rate limiting"));
        assert!(error.contains("cached results"));
        assert!(error.contains("will not retry automatically"));
        assert!(error.contains("API temporarily disabled"));
    }

    #[test]
    fn reports_anilist_429_retry_after() {
        assert_eq!(
            parse_anilist_response(StatusCode::TOO_MANY_REQUESTS, Some("17"), "").unwrap_err(),
            "AniList is rate limiting requests. Try again in 17 seconds."
        );
    }

    #[test]
    fn reports_graphql_errors_from_successful_http_responses() {
        assert_eq!(
            parse_anilist_response(
                StatusCode::OK,
                None,
                r#"{"errors":[{"message":"Invalid variable"}],"data":null}"#,
            )
            .unwrap_err(),
            "AniList returned a GraphQL error: Invalid variable"
        );
        assert_eq!(
            parse_anilist_response(StatusCode::OK, None, r#"{"errors":[{}],"data":{}}"#)
                .unwrap_err(),
            "AniList returned a GraphQL error without details."
        );
    }

    #[test]
    fn rejects_missing_anilist_data_and_media_arrays() {
        assert_eq!(
            parse_anilist_response(StatusCode::OK, None, r#"{"data":null}"#).unwrap_err(),
            "AniList did not return valid GraphQL data."
        );
        assert!(season_shows(&serde_json::json!({ "data": {} })).is_err());
    }

    #[test]
    fn treats_null_media_as_no_metadata_but_rejects_invalid_media() {
        assert_eq!(
            media_from_response(&serde_json::json!({ "data": { "Media": null } })).unwrap(),
            None
        );
        assert!(media_from_response(&serde_json::json!({ "data": {} })).is_err());
    }

    #[test]
    fn validates_anilist_season_input() {
        assert_eq!(validate_anilist_season("summer", 2026), Ok("SUMMER"));
        assert!(validate_anilist_season("monsoon", 2026).is_err());
        assert!(validate_anilist_season("spring", 1200).is_err());
    }

    #[test]
    fn bounds_season_results_to_queried_pages() {
        let response = serde_json::json!({
            "data": {
                "page1": { "media": [{ "id": 1 }] },
                "page2": { "media": [{ "id": 2 }] },
                "page3": { "media": [{ "id": 3 }] },
                "page4": { "media": [{ "id": 4 }] }
            }
        });
        let shows = season_shows(&response).unwrap();
        assert_eq!(shows.len(), 3);
        assert_eq!(shows[2]["id"], 3);
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

    #[test]
    fn matches_the_requested_season_without_assigning_ambiguous_titles() {
        let seasons = serde_json::json!({
            "data": {
                "exact": { "media": [
                    { "id": 1, "title": { "romaji": "Example Show 1" } },
                    { "id": 2, "title": { "romaji": "Example Show 2" } }
                ] },
                "normalized": { "media": [] },
                "short": { "media": [] }
            }
        });
        assert_eq!(
            best_metadata_match("Example Show S1", &seasons)
                .unwrap()
                .unwrap()["id"],
            1
        );
        assert_eq!(
            best_metadata_match("Example Show S2", &seasons)
                .unwrap()
                .unwrap()["id"],
            2
        );

        let ambiguous = serde_json::json!({
            "data": {
                "exact": { "media": [
                    { "id": 3, "title": { "romaji": "Same Name" } },
                    { "id": 4, "title": { "romaji": "Same Name" } }
                ] },
                "normalized": { "media": [] },
                "short": { "media": [] }
            }
        });
        assert_eq!(best_metadata_match("Same Name", &ambiguous).unwrap(), None);
        assert_eq!(
            best_metadata_match("Unknown Title", &seasons).unwrap(),
            None
        );
    }
}
