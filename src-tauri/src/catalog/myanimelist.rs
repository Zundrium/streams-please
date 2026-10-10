use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use reqwest::{
    header::{HeaderName, HeaderValue},
    StatusCode, Url,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    days_in_month,
    http::{
        interpret_json, ProviderFailure, ProviderHttp, ProviderPolicy, ProviderResponse,
        MAX_JSON_RESPONSE_BYTES, NETWORK_COOLDOWN, REJECTED_COOLDOWN,
    },
    identity::{IdentityResolver, ProviderId},
    nonempty, push_skipped_items_warning, valid_catalog_year, valid_description, valid_text,
    AdapterFuture, CatalogAdapter, CatalogCapability, CatalogCoverImage, CatalogMedia,
    CatalogProvider, CatalogRequest, CatalogResponse, CatalogSeason, CatalogTitle,
};

pub(super) const PROVIDER_ID: &str = "myanimelist";

const MAL_API_BASE: &str = "https://api.myanimelist.net/v2/";
const MAL_CLIENT_ID_HEADER: &str = "x-mal-client-id";
const MAL_CLIENT_ID_MAX_BYTES: usize = 128;
static MAL_POLICY: ProviderPolicy = ProviderPolicy {
    label: "MyAnimeList",
    accept: "application/json",
    max_concurrent_requests: 1,
    request_interval: Duration::from_millis(1_100),
    cache_ttl: Duration::from_secs(5 * 60),
    cache_limit: 32,
    max_response_bytes: MAX_JSON_RESPONSE_BYTES,
    network_cooldown: Some(NETWORK_COOLDOWN),
    interpret: interpret_mal_response,
};
const MAL_SEARCH_LIMIT: usize = 50;
const MAL_SEASON_LIMIT: usize = 100;
const MAL_MAX_RECOMMENDATIONS_PER_SEED: usize = 500;
const MAL_RECOMMENDATION_MAPPING_LIMIT: usize = 200;
const MAL_RECOMMENDATION_DETAIL_LIMIT: usize = 50;
const MAL_FIELDS: &str = "id,title,main_picture,alternative_titles,start_date,end_date,synopsis,mean,num_list_users,nsfw,media_type,status,genres,num_episodes,start_season,average_episode_duration";

const CAPABILITIES: &[CatalogCapability] = &[
    CatalogCapability::Search,
    CatalogCapability::Season,
    CatalogCapability::Recommendations,
];

struct MyAnimeListClient {
    api_base: Url,
    http: ProviderHttp,
}

pub(super) struct MyAnimeListAdapter {
    client: MyAnimeListClient,
    identity: Arc<IdentityResolver>,
}

#[derive(Deserialize)]
struct MalPage {
    data: Vec<MalEdge>,
    paging: MalPaging,
    #[serde(default)]
    season: Option<MalStartSeason>,
}

#[derive(Deserialize)]
struct MalEdge {
    node: MalAnime,
}

#[derive(Clone, Deserialize)]
struct MalAnime {
    id: i64,
    title: String,
    #[serde(default)]
    main_picture: Option<MalPicture>,
    #[serde(default)]
    alternative_titles: Option<MalAlternativeTitles>,
    #[serde(default)]
    start_date: Option<String>,
    #[serde(default)]
    end_date: Option<String>,
    #[serde(default)]
    synopsis: Option<String>,
    #[serde(default)]
    mean: Option<f64>,
    #[serde(default)]
    num_list_users: Option<i64>,
    #[serde(default)]
    nsfw: Option<String>,
    #[serde(default)]
    media_type: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    genres: Vec<MalGenre>,
    #[serde(default)]
    num_episodes: Option<i64>,
    #[serde(default)]
    start_season: Option<MalStartSeason>,
    #[serde(default)]
    average_episode_duration: Option<i64>,
    #[serde(default)]
    recommendations: Vec<MalRecommendation>,
}

#[derive(Clone, Deserialize)]
struct MalPicture {
    #[serde(default)]
    medium: Option<String>,
    #[serde(default)]
    large: Option<String>,
}

#[derive(Clone, Default, Deserialize)]
struct MalAlternativeTitles {
    #[serde(default)]
    synonyms: Vec<String>,
    #[serde(default)]
    en: Option<String>,
    #[serde(default)]
    ja: Option<String>,
}

#[derive(Clone, Deserialize)]
struct MalGenre {
    id: i64,
    name: String,
}

#[derive(Clone, Deserialize)]
struct MalStartSeason {
    year: i32,
    season: String,
}

#[derive(Clone, Deserialize)]
struct MalRecommendation {
    node: MalAnime,
    num_recommendations: i64,
}

#[derive(Deserialize)]
struct MalPaging {
    #[serde(default)]
    previous: Option<String>,
    #[serde(default)]
    next: Option<String>,
}

struct MalRecommendationAggregate {
    mal_id: i64,
    seed_ids: HashSet<i64>,
    recommendations: i64,
}

pub(super) fn descriptor() -> CatalogProvider {
    CatalogProvider::new(PROVIDER_ID, "MyAnimeList", CAPABILITIES)
}

pub(super) fn validate_client_id(value: Option<&str>) -> Result<String, String> {
    let Some(value) = value else {
        return Err(
            "MyAnimeList requires a Client ID. Add one in Settings or choose another catalog provider."
                .into(),
        );
    };
    let value = value.trim();
    if value.is_empty() {
        return Err(
            "MyAnimeList requires a Client ID. Add one in Settings or choose another catalog provider."
                .into(),
        );
    }
    if value.len() > MAL_CLIENT_ID_MAX_BYTES
        || !value.is_ascii()
        || !value.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err(
            "The MyAnimeList Client ID is invalid. Use the printable Client ID from MyAnimeList without spaces."
                .into(),
        );
    }
    HeaderValue::from_str(value).map_err(|_| {
        "The MyAnimeList Client ID cannot be used as an HTTP header. Check it in Settings."
            .to_string()
    })?;
    Ok(value.to_owned())
}

impl MyAnimeListAdapter {
    pub(super) fn new(
        http: reqwest::Client,
        identity: Arc<IdentityResolver>,
        client_id: &str,
    ) -> Result<Self, String> {
        Self::with_api_base(http, identity, client_id, MAL_API_BASE)
    }

    fn with_api_base(
        http: reqwest::Client,
        identity: Arc<IdentityResolver>,
        client_id: &str,
        api_base: &str,
    ) -> Result<Self, String> {
        let client_id = validate_client_id(Some(client_id))?;
        let client_id = HeaderValue::from_str(&client_id).map_err(|_| {
            "The MyAnimeList Client ID cannot be used as an HTTP header. Check it in Settings."
                .to_string()
        })?;
        let api_base = Url::parse(api_base)
            .map_err(|error| format!("The MyAnimeList endpoint is invalid: {error}"))?;
        Ok(Self {
            client: MyAnimeListClient::new(http, api_base, client_id),
            identity,
        })
    }

    async fn search(
        &self,
        query: &str,
        cache_dir: &std::path::Path,
    ) -> Result<(Vec<CatalogMedia>, Vec<String>), String> {
        let url = mal_search_url(&self.client.api_base, query)?;
        let payload = self.client.http.get_json(url).await?;
        let page = parse_mal_page(payload, MAL_SEARCH_LIMIT)?;
        let mut warnings = Vec::new();
        if page.paging.next.is_some() {
            warnings.push(format!(
                "MyAnimeList search results were limited to {MAL_SEARCH_LIMIT} items."
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
        let url = mal_season_url(&self.client.api_base, season, year)?;
        let payload = self.client.http.get_json(url).await?;
        let page = parse_mal_page(payload, MAL_SEASON_LIMIT)?;
        if !page
            .season
            .as_ref()
            .is_some_and(|actual| mal_start_season(actual) == Some((season, year)))
        {
            return Err("MyAnimeList returned season metadata for a different season.".into());
        }
        let mut warnings = Vec::new();
        if page.paging.next.is_some() {
            warnings.push(format!(
                "MyAnimeList season results were limited to {MAL_SEASON_LIMIT} items."
            ));
        }
        self.map_results(page.data, Some((season, year)), cache_dir, warnings)
            .await
    }

    async fn recommendations(
        &self,
        ids: &[i64],
        cache_dir: &std::path::Path,
    ) -> Result<(Vec<CatalogMedia>, Vec<String>), String> {
        let requested_ids = ids.iter().copied().collect::<HashSet<_>>();
        let seed_resolution = self
            .identity
            .resolve_anilist_ids(&requested_ids, "mal", cache_dir)
            .await?;
        let mut warnings = seed_resolution.warnings;
        let missing_seeds = ids.len() - seed_resolution.provider_id_by_anilist_id.len();
        if missing_seeds > 0 {
            warnings.push(format!(
                "{missing_seeds} recommendation seed(s) were omitted because no verified MyAnimeList mapping was available."
            ));
        }
        if seed_resolution.provider_id_by_anilist_id.is_empty() {
            return Err(format!(
                "MyAnimeList could not recommend anime because none of the AniList seeds had verified MyAnimeList mappings. {}",
                warnings.join(" ")
            ));
        }

        let seed_mal_ids = seed_resolution
            .provider_id_by_anilist_id
            .values()
            .copied()
            .collect::<HashSet<_>>();
        let mut recommendations_by_seed = Vec::new();
        let mut failed_seeds = Vec::new();
        for anilist_id in ids {
            let Some(mal_id) = seed_resolution
                .provider_id_by_anilist_id
                .get(anilist_id)
                .copied()
            else {
                continue;
            };
            let result = self
                .client
                .http
                .get_json(mal_recommendations_url(&self.client.api_base, mal_id)?)
                .await
                .and_then(|payload| parse_mal_recommendations(payload, mal_id));
            match result {
                Ok(recommendations) => recommendations_by_seed.push((*anilist_id, recommendations)),
                Err(error) => failed_seeds.push((*anilist_id, error)),
            }
        }
        if recommendations_by_seed.is_empty() {
            let detail = failed_seeds
                .first()
                .map(|(_, error)| format!(" First failure: {error}"))
                .unwrap_or_default();
            return Err(format!(
                "MyAnimeList recommendations were unavailable for every mapped seed.{detail}"
            ));
        }
        if !failed_seeds.is_empty() {
            warnings.push(format!(
                "MyAnimeList recommendations were unavailable for {} of {} mapped seed(s); partial recommendations are shown. First failure: {}",
                failed_seeds.len(),
                seed_resolution.provider_id_by_anilist_id.len(),
                failed_seeds[0].1
            ));
        }

        let aggregates = aggregate_mal_recommendations(recommendations_by_seed, &seed_mal_ids);
        if aggregates.is_empty() {
            return Ok((Vec::new(), warnings));
        }
        let provider_ids = aggregates
            .iter()
            .map(|item| ProviderId::mal(item.mal_id))
            .collect::<HashSet<_>>();
        let resolution = self.identity.resolve_ids(&provider_ids, cache_dir).await?;
        extend_unique(&mut warnings, resolution.warnings);

        let mut mapped = Vec::new();
        let mut missing_mappings = 0;
        for aggregate in aggregates {
            match resolution
                .anilist_by_provider_id
                .get(&ProviderId::mal(aggregate.mal_id))
                .copied()
            {
                Some(anilist_id) => mapped.push((aggregate.mal_id, anilist_id)),
                None => missing_mappings += 1,
            }
        }
        if missing_mappings > 0 {
            warnings.push(format!(
                "{missing_mappings} MyAnimeList recommendation(s) were omitted because no verified canonical AniList mapping was available."
            ));
        }
        if mapped.is_empty() {
            return Err(format!(
                "MyAnimeList returned recommendations, but none had verified canonical AniList mappings. {}",
                warnings.join(" ")
            ));
        }
        if mapped.len() > MAL_RECOMMENDATION_DETAIL_LIMIT {
            let omitted = mapped.len() - MAL_RECOMMENDATION_DETAIL_LIMIT;
            mapped.truncate(MAL_RECOMMENDATION_DETAIL_LIMIT);
            warnings.push(format!(
                "MyAnimeList recommendations were limited to {MAL_RECOMMENDATION_DETAIL_LIMIT} items; {omitted} additional mapped recommendation(s) were omitted."
            ));
        }

        let mut items = Vec::new();
        let mut adult = 0;
        let mut skipped = 0;
        let mut failed_details = Vec::new();
        for (mal_id, anilist_id) in mapped {
            let result = self
                .client
                .http
                .get_json(mal_details_url(&self.client.api_base, mal_id)?)
                .await
                .and_then(|payload| parse_mal_anime(payload, mal_id));
            let anime = match result {
                Ok(anime) => anime,
                Err(error) => {
                    failed_details.push(error);
                    continue;
                }
            };
            if !mal_is_safe(&anime) {
                adult += 1;
                continue;
            }
            match normalize_mal_anime(anime, anilist_id) {
                Ok(item) if item.validate("MyAnimeList").is_ok() => items.push(item),
                _ => skipped += 1,
            }
        }
        if adult > 0 {
            warnings.push(format!(
                "MyAnimeList returned {adult} recommendation(s) not marked safe for work; they were omitted."
            ));
        }
        push_skipped_items_warning(&mut warnings, "MyAnimeList", skipped);
        if !failed_details.is_empty() {
            warnings.push(format!(
                "Details were unavailable for {} MyAnimeList recommendation(s); those items were omitted. First failure: {}",
                failed_details.len(),
                failed_details[0]
            ));
        }
        if items.is_empty() && !failed_details.is_empty() && adult == 0 {
            return Err(format!(
                "MyAnimeList recommendation details were unavailable. {}",
                warnings.join(" ")
            ));
        }
        Ok((items, warnings))
    }

    async fn map_results(
        &self,
        edges: Vec<MalEdge>,
        requested_season: Option<(CatalogSeason, i32)>,
        cache_dir: &std::path::Path,
        mut warnings: Vec<String>,
    ) -> Result<(Vec<CatalogMedia>, Vec<String>), String> {
        let mut adult = 0;
        let mut outside_season = 0;
        let mut skipped = 0;
        let mut seen = HashSet::new();
        let mut valid = Vec::new();
        for edge in edges {
            if validate_mal_anime(&edge.node).is_err() {
                skipped += 1;
                continue;
            }
            if !mal_is_safe(&edge.node) {
                adult += 1;
                continue;
            }
            if requested_season
                .is_some_and(|(season, year)| !matches_requested_season(&edge.node, season, year))
            {
                outside_season += 1;
                continue;
            }
            if seen.insert(edge.node.id) {
                valid.push(edge.node);
            }
        }
        if adult > 0 {
            warnings.push(format!(
                "MyAnimeList returned {adult} item(s) not marked safe for work; they were omitted."
            ));
        }
        if outside_season > 0 {
            warnings.push(format!(
                "MyAnimeList returned {outside_season} item(s) outside the requested season, year, or supported TV/ONA formats; they were omitted."
            ));
        }
        if valid.is_empty() {
            push_skipped_items_warning(&mut warnings, "MyAnimeList", skipped);
            return Ok((Vec::new(), warnings));
        }

        let provider_ids = valid
            .iter()
            .map(|anime| ProviderId::mal(anime.id))
            .collect::<HashSet<_>>();
        let resolution = self.identity.resolve_ids(&provider_ids, cache_dir).await?;
        extend_unique(&mut warnings, resolution.warnings);

        let mut missing_mappings = 0;
        let mut items = Vec::new();
        for anime in valid {
            let Some(anilist_id) = resolution
                .anilist_by_provider_id
                .get(&ProviderId::mal(anime.id))
                .copied()
            else {
                missing_mappings += 1;
                continue;
            };
            match normalize_mal_anime(anime, anilist_id) {
                Ok(item) if item.validate("MyAnimeList").is_ok() => items.push(item),
                _ => skipped += 1,
            }
        }
        push_skipped_items_warning(&mut warnings, "MyAnimeList", skipped);
        if missing_mappings > 0 {
            warnings.push(format!(
                "{missing_mappings} MyAnimeList item(s) were omitted because no verified canonical AniList mapping was available."
            ));
        }
        if missing_mappings > 0 && items.is_empty() {
            return Err(format!(
                "MyAnimeList returned items, but none had verified canonical AniList mappings. {}",
                warnings.join(" ")
            ));
        }
        Ok((items, warnings))
    }
}

impl CatalogAdapter for MyAnimeListAdapter {
    fn descriptor(&self) -> CatalogProvider {
        descriptor()
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
                CatalogRequest::Recommendations { ids } => {
                    self.recommendations(ids, &cache_dir).await?
                }
            };
            Ok(CatalogResponse::new(PROVIDER_ID, &request, items, warnings))
        })
    }
}

impl MyAnimeListClient {
    fn new(http: reqwest::Client, api_base: Url, client_id: HeaderValue) -> Self {
        Self {
            api_base,
            http: ProviderHttp::new(http, &MAL_POLICY)
                .with_header(HeaderName::from_static(MAL_CLIENT_ID_HEADER), client_id),
        }
    }
}

fn interpret_mal_response(
    policy: &ProviderPolicy,
    response: &ProviderResponse,
) -> Result<Value, ProviderFailure> {
    if matches!(
        response.status,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        return Err(ProviderFailure::cooldown(
            REJECTED_COOLDOWN,
            format!(
                "MyAnimeList rejected the configured Client ID (HTTP {}). Check it in Settings.",
                response.status
            ),
        ));
    }
    interpret_json(policy, response)
}

fn mal_search_url(api_base: &Url, query: &str) -> Result<Url, String> {
    mal_url(
        api_base,
        &["anime"],
        &[
            ("q", query.trim().to_owned()),
            ("limit", MAL_SEARCH_LIMIT.to_string()),
            ("offset", "0".into()),
            ("fields", MAL_FIELDS.into()),
        ],
    )
}

fn mal_season_url(api_base: &Url, season: CatalogSeason, year: i32) -> Result<Url, String> {
    mal_url(
        api_base,
        &[
            "anime",
            "season",
            &year.to_string(),
            &season.as_str().to_ascii_lowercase(),
        ],
        &[
            ("sort", "anime_num_list_users".into()),
            ("limit", MAL_SEASON_LIMIT.to_string()),
            ("offset", "0".into()),
            ("fields", MAL_FIELDS.into()),
        ],
    )
}

fn mal_recommendations_url(api_base: &Url, mal_id: i64) -> Result<Url, String> {
    mal_url(
        api_base,
        &["anime", &mal_id.to_string()],
        &[("fields", "recommendations".into())],
    )
}

fn mal_details_url(api_base: &Url, mal_id: i64) -> Result<Url, String> {
    mal_url(
        api_base,
        &["anime", &mal_id.to_string()],
        &[("fields", MAL_FIELDS.into())],
    )
}

fn mal_url(api_base: &Url, segments: &[&str], query: &[(&str, String)]) -> Result<Url, String> {
    let mut url = api_base.clone();
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| "The MyAnimeList endpoint cannot contain path segments.".to_string())?;
        path.pop_if_empty();
        for segment in segments {
            path.push(segment);
        }
    }
    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    Ok(url)
}

fn parse_mal_page(value: Value, item_limit: usize) -> Result<MalPage, String> {
    let item_count = value
        .get("data")
        .and_then(Value::as_array)
        .map(Vec::len)
        .ok_or_else(|| "MyAnimeList returned an invalid data page.".to_string())?;
    if item_count > item_limit {
        return Err("MyAnimeList returned more items than requested.".into());
    }
    let page: MalPage = serde_json::from_value(value)
        .map_err(|error| format!("MyAnimeList returned invalid media data: {error}"))?;
    for link in [page.paging.previous.as_deref(), page.paging.next.as_deref()]
        .into_iter()
        .flatten()
    {
        validate_mal_paging_url(link)?;
    }
    Ok(page)
}

fn parse_mal_anime(value: Value, expected_id: i64) -> Result<MalAnime, String> {
    let anime: MalAnime = serde_json::from_value(value)
        .map_err(|error| format!("MyAnimeList returned invalid anime details: {error}"))?;
    if anime.id != expected_id {
        return Err("MyAnimeList returned details for a different anime.".into());
    }
    validate_mal_anime(&anime)?;
    Ok(anime)
}

fn parse_mal_recommendations(
    value: Value,
    expected_id: i64,
) -> Result<Vec<MalRecommendation>, String> {
    let anime: MalAnime = serde_json::from_value(value)
        .map_err(|error| format!("MyAnimeList returned invalid recommendation data: {error}"))?;
    if anime.id != expected_id || anime.recommendations.len() > MAL_MAX_RECOMMENDATIONS_PER_SEED {
        return Err("MyAnimeList returned invalid recommendation data.".into());
    }
    for recommendation in &anime.recommendations {
        if recommendation.num_recommendations < 0
            || recommendation.num_recommendations > i64::from(i32::MAX)
            || validate_mal_identity(&recommendation.node).is_err()
        {
            return Err("MyAnimeList returned an invalid recommendation item.".into());
        }
    }
    Ok(anime.recommendations)
}

fn validate_mal_paging_url(value: &str) -> Result<(), String> {
    if value.len() > 2_000
        || !Url::parse(value).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("api.myanimelist.net")
                && url.port_or_known_default() == Some(443)
                && url.username().is_empty()
                && url.password().is_none()
                && url.path().starts_with("/v2/anime")
                && url.fragment().is_none()
        })
    {
        return Err("MyAnimeList returned invalid pagination metadata.".into());
    }
    Ok(())
}

fn validate_mal_identity(anime: &MalAnime) -> Result<(), String> {
    if anime.id <= 0
        || anime.id > i64::from(i32::MAX)
        || anime.title.trim().is_empty()
        || !valid_text(&anime.title, 500)
        || anime
            .main_picture
            .as_ref()
            .is_some_and(|picture| !valid_mal_picture(picture))
    {
        return Err("MyAnimeList returned an invalid anime item.".into());
    }
    Ok(())
}

fn validate_mal_anime(anime: &MalAnime) -> Result<(), String> {
    validate_mal_identity(anime)?;
    if anime.alternative_titles.as_ref().is_some_and(|titles| {
        titles.synonyms.len() > 100
            || titles.synonyms.iter().any(|value| !valid_text(value, 500))
            || titles
                .en
                .as_ref()
                .is_some_and(|value| !valid_text(value, 500))
            || titles
                .ja
                .as_ref()
                .is_some_and(|value| !valid_text(value, 500))
    }) || anime
        .synopsis
        .as_ref()
        .is_some_and(|value| !valid_description(value))
        || anime
            .mean
            .is_some_and(|value| !value.is_finite() || !(0.0..=10.0).contains(&value))
        || anime.num_list_users.is_some_and(|value| value < 0)
        || anime
            .nsfw
            .as_ref()
            .is_some_and(|value| !valid_text(value, 32))
        || anime
            .media_type
            .as_ref()
            .is_some_and(|value| !valid_text(value, 32))
        || anime
            .status
            .as_ref()
            .is_some_and(|value| !valid_text(value, 64))
        || anime.genres.len() > 100
        || anime
            .genres
            .iter()
            .any(|genre| genre.id <= 0 || !valid_text(&genre.name, 100))
        || anime
            .num_episodes
            .is_some_and(|value| !(0..=100_000).contains(&value))
        || anime
            .average_episode_duration
            .is_some_and(|value| !(0..=24 * 60 * 60).contains(&value))
        || anime
            .start_season
            .as_ref()
            .is_some_and(|value| mal_start_season(value).is_none())
        || anime
            .start_date
            .as_deref()
            .is_some_and(|value| parse_mal_date(value).is_none())
        || anime
            .end_date
            .as_deref()
            .is_some_and(|value| parse_mal_date(value).is_none())
    {
        return Err("MyAnimeList returned an invalid anime item.".into());
    }
    Ok(())
}

fn valid_mal_picture(picture: &MalPicture) -> bool {
    [picture.medium.as_deref(), picture.large.as_deref()]
        .into_iter()
        .flatten()
        .all(super::valid_https_url)
}

fn mal_is_safe(anime: &MalAnime) -> bool {
    anime.nsfw.as_deref() == Some("white")
}

fn matches_requested_season(anime: &MalAnime, season: CatalogSeason, year: i32) -> bool {
    anime.start_season.as_ref().and_then(mal_start_season) == Some((season, year))
        && matches!(mal_format(anime.media_type.as_deref()), Some("TV" | "ONA"))
}

fn mal_start_season(value: &MalStartSeason) -> Option<(CatalogSeason, i32)> {
    if !(1900..=2200).contains(&value.year) {
        return None;
    }
    let season = match value.season.as_str() {
        "winter" => CatalogSeason::Winter,
        "spring" => CatalogSeason::Spring,
        "summer" => CatalogSeason::Summer,
        "fall" => CatalogSeason::Fall,
        _ => return None,
    };
    Some((season, value.year))
}

fn mal_format(value: Option<&str>) -> Option<&'static str> {
    match value? {
        "tv" => Some("TV"),
        "ona" => Some("ONA"),
        "ova" => Some("OVA"),
        "movie" => Some("MOVIE"),
        "special" => Some("SPECIAL"),
        "music" => Some("MUSIC"),
        _ => None,
    }
}

fn mal_status(value: Option<&str>) -> Option<&'static str> {
    match value? {
        "finished_airing" => Some("FINISHED"),
        "currently_airing" => Some("RELEASING"),
        "not_yet_aired" => Some("NOT_YET_RELEASED"),
        _ => None,
    }
}

fn parse_mal_date(value: &str) -> Option<Value> {
    if !(4..=10).contains(&value.len()) || !value.is_ascii() {
        return None;
    }
    let parts = value.split('-').collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 3 || parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    let year = parts[0].parse::<i32>().ok()?;
    if !(1900..=2200).contains(&year) || parts[0].len() != 4 {
        return None;
    }
    let month = parts
        .get(1)
        .map(|value| value.parse::<u32>().ok())
        .flatten();
    if parts.len() >= 2
        && (parts[1].len() != 2 || !month.is_some_and(|value| (1..=12).contains(&value)))
    {
        return None;
    }
    let day = parts
        .get(2)
        .map(|value| value.parse::<u32>().ok())
        .flatten();
    if parts.len() == 3
        && (parts[2].len() != 2
            || !day.is_some_and(|value| {
                (1..=days_in_month(year, month.unwrap_or_default()).unwrap_or_default())
                    .contains(&value)
            }))
    {
        return None;
    }
    Some(json!({ "year": year, "month": month, "day": day }))
}

fn normalize_mal_anime(mut anime: MalAnime, anilist_id: i64) -> Result<CatalogMedia, String> {
    let alternative_titles = anime.alternative_titles.take().unwrap_or_default();
    let english = nonempty(alternative_titles.en);
    let native = nonempty(alternative_titles.ja);
    let preferred = english.as_ref().unwrap_or(&anime.title).clone();
    let synonyms = (!alternative_titles.synonyms.is_empty()).then_some(
        alternative_titles
            .synonyms
            .into_iter()
            .filter(|value| !value.trim().is_empty())
            .collect::<Vec<_>>(),
    );
    let synonyms = synonyms.filter(|values| !values.is_empty());
    let cover_image = anime.main_picture.take().and_then(|picture| {
        (picture.medium.is_some() || picture.large.is_some()).then_some(CatalogCoverImage {
            extra_large: picture.large,
            large: picture.medium,
            color: None,
        })
    });
    let season = anime
        .start_season
        .as_ref()
        .and_then(mal_start_season)
        .filter(|(_, year)| valid_catalog_year(*year));
    let genres = (!anime.genres.is_empty())
        .then(|| anime.genres.into_iter().map(|genre| genre.name).collect());
    let site_url = mal_site_url(anime.id)?;

    Ok(CatalogMedia {
        id: anilist_id,
        id_mal: Some(anime.id),
        title: CatalogTitle {
            romaji: Some(anime.title),
            english,
            native,
            user_preferred: Some(preferred),
        },
        synonyms,
        description: nonempty(anime.synopsis),
        trailer: None,
        cover_image,
        banner_image: None,
        genres,
        season: season.map(|(season, _)| season),
        season_year: season.map(|(_, year)| year),
        start_date: anime.start_date.as_deref().and_then(parse_mal_date),
        end_date: anime.end_date.as_deref().and_then(parse_mal_date),
        format: mal_format(anime.media_type.as_deref()).map(str::to_owned),
        status: mal_status(anime.status.as_deref()).map(str::to_owned),
        episodes: anime.num_episodes.filter(|value| *value > 0),
        duration: anime
            .average_episode_duration
            .filter(|value| *value > 0)
            .map(|seconds| ((seconds + 30) / 60).clamp(1, 24 * 60)),
        average_score: anime
            .mean
            .filter(|mean| mean.is_finite())
            .map(|mean| (mean * 10.0).round().clamp(0.0, 100.0) as i64),
        popularity: anime.num_list_users,
        site_url: Some(site_url),
        next_airing_episode: None,
        relations: None,
    })
}

fn aggregate_mal_recommendations(
    recommendations_by_seed: Vec<(i64, Vec<MalRecommendation>)>,
    seed_mal_ids: &HashSet<i64>,
) -> Vec<MalRecommendationAggregate> {
    let mut aggregates = HashMap::<i64, MalRecommendationAggregate>::new();
    for (anilist_id, recommendations) in recommendations_by_seed {
        for recommendation in recommendations {
            if seed_mal_ids.contains(&recommendation.node.id) {
                continue;
            }
            let aggregate = aggregates.entry(recommendation.node.id).or_insert_with(|| {
                MalRecommendationAggregate {
                    mal_id: recommendation.node.id,
                    seed_ids: HashSet::new(),
                    recommendations: 0,
                }
            });
            if aggregate.seed_ids.insert(anilist_id) {
                aggregate.recommendations = aggregate
                    .recommendations
                    .saturating_add(recommendation.num_recommendations);
            }
        }
    }
    let mut aggregates = aggregates.into_values().collect::<Vec<_>>();
    aggregates.sort_by(|left, right| {
        right
            .seed_ids
            .len()
            .cmp(&left.seed_ids.len())
            .then_with(|| right.recommendations.cmp(&left.recommendations))
            .then_with(|| left.mal_id.cmp(&right.mal_id))
    });
    aggregates.truncate(MAL_RECOMMENDATION_MAPPING_LIMIT);
    aggregates
}

fn mal_site_url(mal_id: i64) -> Result<String, String> {
    let mut url = Url::parse("https://myanimelist.net/anime/")
        .map_err(|error| format!("The MyAnimeList site endpoint is invalid: {error}"))?;
    url.path_segments_mut()
        .map_err(|_| "The MyAnimeList site endpoint cannot contain path segments.".to_string())?
        .pop_if_empty()
        .push(&mal_id.to_string());
    Ok(url.to_string())
}

fn extend_unique(target: &mut Vec<String>, values: Vec<String>) {
    for value in values {
        if !target.contains(&value) {
            target.push(value);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
        thread,
        time::{Duration, Instant},
    };

    use reqwest::Url;
    use serde_json::{json, Value};

    use super::{
        aggregate_mal_recommendations, mal_details_url, mal_recommendations_url, mal_search_url,
        mal_season_url, parse_mal_anime, parse_mal_page, parse_mal_recommendations,
        validate_client_id, MalAnime, MyAnimeListAdapter, MAL_FIELDS, MAL_POLICY,
    };
    use crate::catalog::{
        http::{Penalty, RequestControl},
        identity::IdentityResolver,
        CatalogSeason,
    };

    struct MockResponse {
        status: u16,
        body: String,
    }

    struct MockServer {
        base: String,
        requests: Arc<Mutex<Vec<String>>>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl MockServer {
        fn start(responses: Vec<MockResponse>) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let address = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let received = requests.clone();
            let thread = thread::spawn(move || {
                for response in responses {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    let mut buffer = [0_u8; 2048];
                    loop {
                        let read = stream.read(&mut buffer).unwrap();
                        if read == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&buffer[..read]);
                        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                            break;
                        }
                    }
                    received
                        .lock()
                        .unwrap()
                        .push(String::from_utf8(bytes).unwrap());
                    let reason = match response.status {
                        200 => "OK",
                        401 => "Unauthorized",
                        403 => "Forbidden",
                        429 => "Too Many Requests",
                        500 => "Internal Server Error",
                        _ => "Error",
                    };
                    write!(
                        stream,
                        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        response.status,
                        reason,
                        response.body.len(),
                        response.body
                    )
                    .unwrap();
                }
            });
            Self {
                base: format!("http://{address}/v2/"),
                requests,
                thread: Some(thread),
            }
        }

        fn finish(mut self) -> Vec<String> {
            self.thread.take().unwrap().join().unwrap();
            Arc::try_unwrap(self.requests)
                .unwrap()
                .into_inner()
                .unwrap()
        }
    }

    fn response(value: Value) -> MockResponse {
        MockResponse {
            status: 200,
            body: value.to_string(),
        }
    }

    fn anime(id: i64, nsfw: &str, season: &str, year: i32) -> Value {
        json!({
            "id": id,
            "title": format!("Anime {id}"),
            "main_picture": {
                "medium": format!("https://cdn.myanimelist.net/{id}.jpg"),
                "large": format!("https://cdn.myanimelist.net/{id}l.jpg")
            },
            "alternative_titles": {
                "synonyms": [format!("Alternative {id}")],
                "en": format!("English {id}"),
                "ja": format!("Native {id}")
            },
            "start_date": format!("{year}-07-01"),
            "end_date": format!("{year}-09-30"),
            "synopsis": "A valid synopsis.",
            "mean": 8.45,
            "num_list_users": 1234,
            "nsfw": nsfw,
            "media_type": "tv",
            "status": "finished_airing",
            "genres": [{"id": 1, "name": "Action"}],
            "num_episodes": 12,
            "start_season": {"year": year, "season": season},
            "average_episode_duration": 1440
        })
    }

    fn recommendation_seed(id: i64, recommendations: &[(i64, i64)]) -> Value {
        json!({
            "id": id,
            "title": format!("Seed {id}"),
            "recommendations": recommendations.iter().map(|(candidate, count)| json!({
                "node": {
                    "id": candidate,
                    "title": format!("Candidate {candidate}"),
                    "main_picture": {"medium": format!("https://cdn.myanimelist.net/{candidate}.jpg")}
                },
                "num_recommendations": count
            })).collect::<Vec<_>>()
        })
    }

    fn write_identity_cache(directory: &std::path::Path, mappings: &[(i64, i64)]) {
        let fetched_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let entries = mappings
            .iter()
            .map(|(anilist_id, mal_id)| {
                json!({"anilistId": anilist_id, "providerIds": {"mal": mal_id}})
            })
            .collect::<Vec<_>>();
        std::fs::write(
            directory.join("identity-fribb-v1.json"),
            serde_json::to_vec(&json!({
                "version": 1,
                "fetchedAt": fetched_at,
                "entries": entries
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn adapter_for(server: &MockServer, directory: &std::path::Path) -> MyAnimeListAdapter {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let identity = Arc::new(IdentityResolver::new(http.clone()));
        assert!(directory.exists());
        MyAnimeListAdapter::with_api_base(http, identity, "client-id_123", &server.base).unwrap()
    }

    fn request_target(request: &str) -> &str {
        request
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
    }

    fn assert_client_id(request: &str) {
        let request = request.to_ascii_lowercase();
        assert!(request.contains("\r\nx-mal-client-id: client-id_123\r\n"));
        assert!(!request.contains("\r\nauthorization:"));
    }

    #[tokio::test]
    async fn sends_official_search_request_and_maps_only_safe_verified_ids() {
        let directory = tempfile::tempdir().unwrap();
        write_identity_cache(directory.path(), &[(100, 1), (200, 2)]);
        let server = MockServer::start(vec![response(json!({
            "data": [
                {"node": anime(1, "white", "summer", 2026)},
                {"node": anime(2, "black", "summer", 2026)}
            ],
            "paging": {}
        }))]);
        let adapter = adapter_for(&server, directory.path());
        let (items, warnings) = adapter
            .search("Frieren & Fern", directory.path())
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, 100);
        assert_eq!(items[0].id_mal, Some(1));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("safe for work")));

        let requests = server.finish();
        assert_eq!(requests.len(), 1);
        assert_client_id(&requests[0]);
        let target =
            Url::parse(&format!("http://localhost{}", request_target(&requests[0]))).unwrap();
        assert_eq!(target.path(), "/v2/anime");
        let query = target.query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(
            query.get("q").map(|value| value.as_ref()),
            Some("Frieren & Fern")
        );
        assert_eq!(
            query.get("fields").map(|value| value.as_ref()),
            Some(MAL_FIELDS)
        );
    }

    #[tokio::test]
    async fn validates_official_season_metadata_membership_and_formats() {
        let directory = tempfile::tempdir().unwrap();
        write_identity_cache(directory.path(), &[(100, 1), (200, 2), (300, 3)]);
        let mut outside = anime(2, "white", "spring", 2026);
        outside["start_date"] = Value::String("2026-04-01".into());
        let mut movie = anime(3, "white", "summer", 2026);
        movie["media_type"] = Value::String("movie".into());
        let server = MockServer::start(vec![response(json!({
            "data": [
                {"node": anime(1, "white", "summer", 2026)},
                {"node": outside},
                {"node": movie}
            ],
            "paging": {},
            "season": {"year": 2026, "season": "summer"}
        }))]);
        let adapter = adapter_for(&server, directory.path());
        let (items, warnings) = adapter
            .season(CatalogSeason::Summer, 2026, directory.path())
            .await
            .unwrap();
        assert_eq!(items.iter().map(|item| item.id).collect::<Vec<_>>(), [100]);
        assert_eq!(items[0].season, Some(CatalogSeason::Summer));
        assert!(warnings.iter().any(|warning| warning.contains("outside")));

        let requests = server.finish();
        assert_client_id(&requests[0]);
        let target =
            Url::parse(&format!("http://localhost{}", request_target(&requests[0]))).unwrap();
        assert_eq!(target.path(), "/v2/anime/season/2026/summer");
        assert!(target
            .query_pairs()
            .any(|(key, value)| { key == "sort" && value == "anime_num_list_users" }));
    }

    #[tokio::test]
    async fn maps_anilist_seeds_and_aggregates_official_recommendations() {
        let directory = tempfile::tempdir().unwrap();
        write_identity_cache(directory.path(), &[(100, 1), (200, 2), (300, 3), (400, 4)]);
        let server = MockServer::start(vec![
            response(recommendation_seed(1, &[(3, 2), (4, 20)])),
            response(recommendation_seed(2, &[(3, 3), (1, 100)])),
            response(anime(3, "white", "summer", 2026)),
            response(anime(4, "black", "summer", 2026)),
        ]);
        let adapter = adapter_for(&server, directory.path());
        let (items, warnings) = adapter
            .recommendations(&[100, 200], directory.path())
            .await
            .unwrap();
        assert_eq!(items.iter().map(|item| item.id).collect::<Vec<_>>(), [300]);
        assert_eq!(items[0].id_mal, Some(3));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("safe for work")));

        let requests = server.finish();
        assert_eq!(requests.len(), 4);
        assert_eq!(
            requests
                .iter()
                .map(|request| {
                    Url::parse(&format!("http://localhost{}", request_target(request)))
                        .unwrap()
                        .path()
                        .to_owned()
                })
                .collect::<Vec<_>>(),
            ["/v2/anime/1", "/v2/anime/2", "/v2/anime/3", "/v2/anime/4"]
        );
        for (index, request) in requests.into_iter().enumerate() {
            assert_client_id(&request);
            let target =
                Url::parse(&format!("http://localhost{}", request_target(&request))).unwrap();
            let fields = target
                .query_pairs()
                .find_map(|(key, value)| (key == "fields").then(|| value.into_owned()))
                .unwrap();
            assert_eq!(
                fields,
                if index < 2 {
                    "recommendations"
                } else {
                    MAL_FIELDS
                }
            );
        }
    }

    #[tokio::test]
    async fn stops_recommendation_detail_requests_during_cooldown() {
        let directory = tempfile::tempdir().unwrap();
        write_identity_cache(directory.path(), &[(100, 1), (300, 3), (400, 4), (500, 5)]);
        let server = MockServer::start(vec![
            response(recommendation_seed(1, &[(3, 30), (4, 20), (5, 10)])),
            MockResponse {
                status: 403,
                body: json!({"error": "forbidden"}).to_string(),
            },
        ]);
        let adapter = adapter_for(&server, directory.path());
        let error = adapter
            .recommendations(&[100], directory.path())
            .await
            .unwrap_err();
        assert!(error.contains("recommendation details were unavailable"));

        let requests = server.finish();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests
                .iter()
                .map(|request| {
                    Url::parse(&format!("http://localhost{}", request_target(request)))
                        .unwrap()
                        .path()
                        .to_owned()
                })
                .collect::<Vec<_>>(),
            ["/v2/anime/1", "/v2/anime/3"]
        );
    }

    #[tokio::test]
    async fn reports_auth_json_season_and_identity_failures() {
        let directory = tempfile::tempdir().unwrap();
        write_identity_cache(directory.path(), &[(100, 1)]);
        let auth_server = MockServer::start(vec![MockResponse {
            status: 403,
            body: json!({"error": "forbidden", "message": "bad client"}).to_string(),
        }]);
        let adapter = adapter_for(&auth_server, directory.path());
        let error = adapter
            .search("Example", directory.path())
            .await
            .unwrap_err();
        assert!(error.contains("configured Client ID"));
        assert!(!error.contains("bad client"));
        assert_client_id(&auth_server.finish()[0]);

        let invalid_json_server = MockServer::start(vec![MockResponse {
            status: 200,
            body: "not-json".into(),
        }]);
        let adapter = adapter_for(&invalid_json_server, directory.path());
        assert!(adapter
            .search("Example", directory.path())
            .await
            .unwrap_err()
            .contains("invalid JSON"));
        invalid_json_server.finish();

        let season_server = MockServer::start(vec![response(json!({
            "data": [], "paging": {}, "season": {"year": 2026, "season": "spring"}
        }))]);
        let adapter = adapter_for(&season_server, directory.path());
        assert!(adapter
            .season(CatalogSeason::Summer, 2026, directory.path())
            .await
            .unwrap_err()
            .contains("different season"));
        season_server.finish();

        let unmapped_server = MockServer::start(Vec::new());
        let adapter = adapter_for(&unmapped_server, directory.path());
        let edges = serde_json::from_value::<super::MalPage>(json!({
            "data": [{"node": anime(999, "white", "summer", 2026)}], "paging": {}
        }))
        .unwrap()
        .data;
        assert!(adapter
            .map_results(edges, None, directory.path(), Vec::new())
            .await
            .unwrap_err()
            .contains("canonical AniList mappings"));
        unmapped_server.finish();
    }

    #[test]
    fn builds_fixed_official_urls_and_validates_provider_shapes() {
        let base = Url::parse(super::MAL_API_BASE).unwrap();
        let search = mal_search_url(&base, "  Frieren & Fern  ").unwrap();
        assert_eq!(search.path(), "/v2/anime");
        assert!(search.query().unwrap().contains("Frieren+%26+Fern"));
        let season = mal_season_url(&base, CatalogSeason::Winter, 2026).unwrap();
        assert_eq!(season.path(), "/v2/anime/season/2026/winter");
        assert_eq!(
            mal_recommendations_url(&base, 5114).unwrap().path(),
            "/v2/anime/5114"
        );
        assert_eq!(
            mal_details_url(&base, 5114).unwrap().path(),
            "/v2/anime/5114"
        );

        let page = parse_mal_page(
            json!({
                "data": [],
                "paging": {"next": "https://api.myanimelist.net/v2/anime?offset=50"}
            }),
            50,
        )
        .unwrap();
        assert!(page.paging.next.is_some());
        assert!(parse_mal_page(
            json!({"data": [], "paging": {"next": "https://example.com/v2/anime"}}),
            50
        )
        .is_err());
        assert!(parse_mal_page(json!({"data": vec![json!({}); 51]}), 50).is_err());
    }

    #[test]
    fn parses_and_sorts_recommendations_without_seeds_or_duplicate_weight() {
        let recommendations = |candidate, count| {
            let value = recommendation_seed(1, &[(candidate, count)]);
            parse_mal_recommendations(value, 1).unwrap()
        };
        let aggregates = aggregate_mal_recommendations(
            vec![
                (100, recommendations(3, 2)),
                (200, recommendations(3, 3)),
                (100, recommendations(3, 100)),
                (100, recommendations(4, 20)),
                (100, recommendations(1, 1000)),
            ],
            &[1, 2].into_iter().collect(),
        );
        assert_eq!(
            aggregates
                .iter()
                .map(|item| item.mal_id)
                .collect::<Vec<_>>(),
            [3, 4]
        );
        assert_eq!(aggregates[0].recommendations, 5);
        assert_eq!(aggregates[0].seed_ids.len(), 2);
    }

    #[test]
    fn rejects_malformed_recommendation_and_anime_responses() {
        for invalid in [
            json!({"id": 1, "title": "Seed", "recommendations": [{"node": {"id": 0, "title": "Bad"}, "num_recommendations": 1}]}),
            json!({"id": 1, "title": "Seed", "recommendations": [{"node": {"id": 2, "title": "Bad"}, "num_recommendations": -1}]}),
            json!({"id": 2, "title": "Wrong seed", "recommendations": []}),
        ] {
            assert!(parse_mal_recommendations(invalid, 1).is_err());
        }
        let oversized = json!({
            "id": 1,
            "title": "Seed",
            "recommendations": vec![json!({
                "node": {"id": 2, "title": "Candidate"}, "num_recommendations": 1
            }); super::MAL_MAX_RECOMMENDATIONS_PER_SEED + 1]
        });
        assert!(parse_mal_recommendations(oversized, 1).is_err());
        assert!(parse_mal_anime(anime(2, "white", "summer", 2026), 1).is_err());
        let mut invalid_score = anime(1, "white", "summer", 2026);
        invalid_score["mean"] = json!(11);
        assert!(parse_mal_anime(invalid_score, 1).is_err());
    }

    #[test]
    fn validates_partial_dates_client_ids_response_bytes_and_cache_bound() {
        assert_eq!(super::parse_mal_date("2024").unwrap()["year"], 2024);
        assert!(super::parse_mal_date("1917-01").is_some());
        assert!(super::parse_mal_date("2024-02-29").is_some());
        assert!(super::parse_mal_date("2025-02-29").is_none());
        assert!(validate_client_id(Some(" valid-id_123 ")).is_ok());
        assert!(validate_client_id(None)
            .unwrap_err()
            .contains("requires a Client ID"));
        assert!(validate_client_id(Some(" ")).is_err());
        assert!(validate_client_id(Some("has spaces")).is_err());
        assert!(validate_client_id(Some("é")).is_err());
        assert!(validate_client_id(Some(&"x".repeat(129))).is_err());

        assert_eq!(MAL_POLICY.max_response_bytes, 2 * 1024 * 1024);

        let now = Instant::now();
        let mut control = RequestControl::new(now);
        for index in 0..=MAL_POLICY.cache_limit {
            control.store(index.to_string(), json!(index), &MAL_POLICY, now);
        }
        assert_eq!(MAL_POLICY.cache_limit, 32);
        assert_eq!(control.cache_len(), MAL_POLICY.cache_limit);
    }

    #[test]
    fn bounds_rate_limit_cooldowns_and_paces_requests() {
        assert_eq!(MAL_POLICY.max_concurrent_requests, 1);
        assert_eq!(MAL_POLICY.network_cooldown, Some(Duration::from_secs(30)));

        let now = Instant::now();
        let mut control = RequestControl::new(now);
        assert_eq!(control.reserve(&MAL_POLICY, now).unwrap(), Duration::ZERO);
        assert_eq!(
            control.reserve(&MAL_POLICY, now).unwrap(),
            Duration::from_millis(1_100)
        );
        control.penalize(Penalty::Cooldown(Duration::from_secs(30)), "", now);
        assert!(control
            .reserve(&MAL_POLICY, now)
            .unwrap_err()
            .starts_with("MyAnimeList requests are cooling down"));

        for status in [
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::FORBIDDEN,
        ] {
            let failure = super::interpret_mal_response(
                &MAL_POLICY,
                &crate::catalog::http::ProviderResponse {
                    status,
                    retry_after: None,
                    body: Vec::new(),
                },
            )
            .unwrap_err();
            assert_eq!(
                failure.penalty,
                Some(Penalty::Cooldown(Duration::from_secs(5 * 60)))
            );
            assert!(failure.message.contains("configured Client ID"));
        }
    }

    #[test]
    fn normalizes_official_media_without_changing_canonical_identity() {
        let anime: MalAnime = serde_json::from_value(anime(5114, "white", "spring", 2009)).unwrap();
        let media = super::normalize_mal_anime(anime, 11061).unwrap();
        let value = serde_json::to_value(media).unwrap();
        assert_eq!(value["id"], 11061);
        assert_eq!(value["idMal"], 5114);
        assert_eq!(value["title"]["english"], "English 5114");
        assert_eq!(value["season"], "SPRING");
        assert_eq!(value["format"], "TV");
        assert_eq!(value["averageScore"], 85);
        assert_eq!(value["duration"], 24);
        assert_eq!(value["siteUrl"], "https://myanimelist.net/anime/5114");
    }

    #[test]
    fn keeps_very_short_episode_durations_valid() {
        let mut value = anime(5114, "white", "spring", 2009);
        value["average_episode_duration"] = json!(20);
        value["mean"] = json!(10.0);
        let anime: MalAnime = serde_json::from_value(value).unwrap();
        let media = super::normalize_mal_anime(anime, 11061).unwrap();
        assert_eq!(media.duration, Some(1));
        assert_eq!(media.average_score, Some(100));
        assert!(media.validate("MyAnimeList").is_ok());
    }

    #[tokio::test]
    async fn skips_invalid_items_without_failing_the_page() {
        let directory = tempfile::tempdir().unwrap();
        write_identity_cache(directory.path(), &[(100, 1), (200, 2)]);
        let mut invalid = anime(2, "white", "summer", 2026);
        invalid["mean"] = json!(11);
        let server = MockServer::start(vec![response(json!({
            "data": [
                {"node": anime(1, "white", "summer", 2026)},
                {"node": invalid}
            ],
            "paging": {}
        }))]);
        let adapter = adapter_for(&server, directory.path());
        let (items, warnings) = adapter.search("Example", directory.path()).await.unwrap();
        assert_eq!(items.iter().map(|item| item.id).collect::<Vec<_>>(), [100]);
        assert!(warnings.contains(
            &"1 catalog item(s) from MyAnimeList were skipped because they were invalid.".into()
        ));
        server.finish();
    }
}
