use std::{
    collections::HashSet,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Manager, State};

pub mod anilist;
mod http;
mod identity;
mod jikan;
mod kitsu;
mod myanimelist;
pub mod subsplease;

use identity::IdentityResolver;

const MAX_CATALOG_QUERY_LENGTH: usize = 160;
const MAX_RECOMMENDATION_SEEDS: usize = 10;
const MIN_CATALOG_YEAR: i32 = 1940;
const MAX_CATALOG_YEAR: i32 = 2200;

type AdapterFuture<'a> = Pin<Box<dyn Future<Output = Result<CatalogResponse, String>> + Send + 'a>>;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CatalogSeason {
    Winter,
    Spring,
    Summer,
    Fall,
}

impl CatalogSeason {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Winter => "WINTER",
            Self::Spring => "SPRING",
            Self::Summer => "SUMMER",
            Self::Fall => "FALL",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum CatalogRequest {
    Search { query: String },
    Season { season: CatalogSeason, year: i32 },
    Recommendations { ids: Vec<i64> },
}

impl CatalogRequest {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Search { query } => validate_catalog_query(query),
            Self::Season { year, .. } if !valid_catalog_year(*year) => {
                Err("Invalid catalog season year.".into())
            }
            Self::Season { .. } => Ok(()),
            Self::Recommendations { ids } => validate_recommendation_ids(ids),
        }
    }

    fn capability(&self) -> CatalogCapability {
        match self {
            Self::Search { .. } => CatalogCapability::Search,
            Self::Season { .. } => CatalogCapability::Season,
            Self::Recommendations { .. } => CatalogCapability::Recommendations,
        }
    }

    fn season_context(&self) -> (Option<CatalogSeason>, Option<i32>) {
        match self {
            Self::Search { .. } | Self::Recommendations { .. } => (None, None),
            Self::Season { season, year } => (Some(*season), Some(*year)),
        }
    }
}

fn validate_catalog_query(query: &str) -> Result<(), String> {
    let trimmed = query.trim();
    if trimmed.len() < 2
        || trimmed.len() > MAX_CATALOG_QUERY_LENGTH
        || trimmed.chars().any(char::is_control)
    {
        return Err("Enter between 2 and 160 characters to search the catalog.".into());
    }
    Ok(())
}

fn validate_recommendation_ids(ids: &[i64]) -> Result<(), String> {
    if ids.is_empty()
        || ids.len() > MAX_RECOMMENDATION_SEEDS
        || ids.iter().any(|id| !valid_catalog_id(*id))
        || ids.iter().copied().collect::<HashSet<_>>().len() != ids.len()
    {
        return Err(format!(
            "Choose between 1 and {MAX_RECOMMENDATION_SEEDS} unique valid AniList IDs for recommendations."
        ));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogCapability {
    Search,
    Season,
    Recommendations,
}

#[derive(Clone, Debug, Serialize)]
pub struct CatalogProvider {
    id: &'static str,
    label: &'static str,
    capabilities: &'static [CatalogCapability],
}

impl CatalogProvider {
    const fn new(
        id: &'static str,
        label: &'static str,
        capabilities: &'static [CatalogCapability],
    ) -> Self {
        Self {
            id,
            label,
            capabilities,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct CatalogResponse {
    provider: &'static str,
    items: Vec<CatalogMedia>,
    warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    season: Option<CatalogSeason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    year: Option<i32>,
}

impl CatalogResponse {
    fn new(
        provider: &'static str,
        request: &CatalogRequest,
        items: Vec<CatalogMedia>,
        warnings: Vec<String>,
    ) -> Self {
        let (season, year) = request.season_context();
        Self {
            provider,
            items,
            warnings,
            season,
            year,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CatalogMedia {
    pub(super) id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) id_mal: Option<i64>,
    pub(super) title: CatalogTitle,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) synonyms: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) trailer: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cover_image: Option<CatalogCoverImage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) banner_image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) genres: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) season: Option<CatalogSeason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) season_year: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) start_date: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) end_date: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) episodes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) duration: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) average_score: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) popularity: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) site_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) next_airing_episode: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) relations: Option<Value>,
}

impl CatalogMedia {
    pub(super) fn from_anilist(value: Value) -> Result<Self, String> {
        let media: Self = serde_json::from_value(value)
            .map_err(|error| format!("AniList returned an invalid catalog item: {error}"))?;
        media.validate("AniList")?;
        Ok(media)
    }

    pub(super) fn validate(&self, provider: &str) -> Result<(), String> {
        if !valid_catalog_id(self.id)
            || self.id_mal.is_some_and(|id| !valid_catalog_id(id))
            || !self.title.is_valid()
            || self.synonyms.as_ref().is_some_and(|items| {
                items.len() > 100 || items.iter().any(|item| !valid_text(item, 500))
            })
            || self
                .description
                .as_ref()
                .is_some_and(|value| !valid_description(value))
            || self.genres.as_ref().is_some_and(|items| {
                items.len() > 100 || items.iter().any(|item| !valid_text(item, 100))
            })
            || self
                .episodes
                .is_some_and(|value| !(0..=100_000).contains(&value))
            || self
                .duration
                .is_some_and(|value| !(1..=24 * 60).contains(&value))
            || self
                .average_score
                .is_some_and(|value| !(0..=100).contains(&value))
            || self.popularity.is_some_and(|value| value < 0)
            || self
                .season_year
                .is_some_and(|year| !valid_catalog_year(year))
            || self
                .cover_image
                .as_ref()
                .is_some_and(|image| !image.is_valid())
            || self
                .banner_image
                .as_ref()
                .is_some_and(|value| !valid_https_url(value))
            || self
                .site_url
                .as_ref()
                .is_some_and(|value| !valid_https_url(value))
            || self
                .format
                .as_ref()
                .is_some_and(|value| !valid_text(value, 100))
            || self
                .status
                .as_ref()
                .is_some_and(|value| !valid_text(value, 100))
        {
            return Err(format!("{provider} returned an invalid catalog item."));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CatalogTitle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) romaji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) english: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) native: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) user_preferred: Option<String>,
}

impl CatalogTitle {
    fn is_valid(&self) -> bool {
        let values = [
            self.romaji.as_deref(),
            self.english.as_deref(),
            self.native.as_deref(),
            self.user_preferred.as_deref(),
        ];
        values.iter().flatten().all(|value| valid_text(value, 500))
            && values
                .iter()
                .flatten()
                .any(|value| !value.trim().is_empty())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CatalogCoverImage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) extra_large: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) large: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) color: Option<String>,
}

impl CatalogCoverImage {
    fn is_valid(&self) -> bool {
        self.extra_large
            .as_ref()
            .is_none_or(|value| valid_https_url(value))
            && self
                .large
                .as_ref()
                .is_none_or(|value| valid_https_url(value))
            && self
                .color
                .as_ref()
                .is_none_or(|value| valid_text(value, 100))
    }
}

fn valid_catalog_id(id: i64) -> bool {
    (1..=i64::from(i32::MAX)).contains(&id)
}

fn valid_text(value: &str, max_len: usize) -> bool {
    value.len() <= max_len && !value.chars().any(char::is_control)
}

fn valid_description(value: &str) -> bool {
    value.len() <= 100_000
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

fn valid_https_url(value: &str) -> bool {
    value.len() <= 2_000
        && reqwest::Url::parse(value).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str().is_some()
                && url.port_or_known_default() == Some(443)
                && url.username().is_empty()
                && url.password().is_none()
        })
}

fn valid_catalog_year(year: i32) -> bool {
    (MIN_CATALOG_YEAR..=MAX_CATALOG_YEAR).contains(&year)
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

fn nonempty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

fn push_skipped_items_warning(warnings: &mut Vec<String>, provider: &str, skipped: usize) {
    if skipped > 0 {
        warnings.push(format!(
            "{skipped} catalog item(s) from {provider} were skipped because they were invalid."
        ));
    }
}

trait CatalogAdapter: Send + Sync {
    fn descriptor(&self) -> CatalogProvider;
    fn request<'a>(&'a self, request: CatalogRequest, cache_dir: PathBuf) -> AdapterFuture<'a>;
}

type MyAnimeListSession = (String, Arc<myanimelist::MyAnimeListAdapter>);

pub struct CatalogState {
    http: reqwest::Client,
    anilist: Arc<anilist::AniListClient>,
    identity: Arc<IdentityResolver>,
    myanimelist: Mutex<Option<MyAnimeListSession>>,
    adapters: Vec<Arc<dyn CatalogAdapter>>,
    providers: Vec<CatalogProvider>,
}

impl CatalogState {
    pub fn new() -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .user_agent(concat!(
                "StreamsPlease/",
                env!("CARGO_PKG_VERSION"),
                " (+local desktop client)"
            ))
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|error| error.to_string())?;
        let anilist = Arc::new(anilist::AniListClient::new(http.clone()));
        let identity = Arc::new(IdentityResolver::new(http.clone()));
        let adapters: Vec<Arc<dyn CatalogAdapter>> = vec![
            Arc::new(anilist::AniListAdapter::new(
                anilist.clone(),
                identity.clone(),
            )),
            Arc::new(jikan::JikanAdapter::new(http.clone(), identity.clone())),
            Arc::new(kitsu::KitsuAdapter::new(http.clone(), identity.clone())),
        ];
        let providers = vec![
            adapters[0].descriptor(),
            myanimelist::descriptor(),
            adapters[1].descriptor(),
            adapters[2].descriptor(),
        ];

        for (index, descriptor) in providers.iter().enumerate() {
            if !valid_provider_id(descriptor.id)
                || providers[..index]
                    .iter()
                    .any(|registered| registered.id == descriptor.id)
            {
                return Err("The catalog provider registry is invalid.".into());
            }
        }

        Ok(Self {
            http,
            anilist,
            identity,
            myanimelist: Mutex::new(None),
            adapters,
            providers,
        })
    }

    fn myanimelist_adapter(
        &self,
        client_id: &str,
    ) -> Result<Arc<myanimelist::MyAnimeListAdapter>, String> {
        let mut session = self
            .myanimelist
            .lock()
            .map_err(|_| "The MyAnimeList client state is unavailable.".to_string())?;
        if let Some((active_client_id, adapter)) = session.as_ref() {
            if active_client_id == client_id {
                return Ok(adapter.clone());
            }
        }
        let adapter = Arc::new(myanimelist::MyAnimeListAdapter::new(
            self.http.clone(),
            self.identity.clone(),
            client_id,
        )?);
        *session = Some((client_id.to_owned(), adapter.clone()));
        Ok(adapter)
    }

    fn provider(&self, provider: &str) -> Result<&CatalogProvider, String> {
        if !valid_provider_id(provider) {
            return Err("Invalid catalog provider.".into());
        }
        self.providers
            .iter()
            .find(|descriptor| descriptor.id == provider)
            .ok_or_else(|| format!("Unknown catalog provider: {provider}."))
    }

    fn adapter(&self, provider: &str) -> Result<&Arc<dyn CatalogAdapter>, String> {
        self.adapters
            .iter()
            .find(|adapter| adapter.descriptor().id == provider)
            .ok_or_else(|| format!("Unknown catalog provider: {provider}."))
    }
}

fn valid_provider_id(provider: &str) -> bool {
    !provider.is_empty()
        && provider.len() <= 32
        && provider
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[tauri::command(rename_all = "camelCase")]
pub async fn catalog_request(
    app: tauri::AppHandle,
    state: State<'_, CatalogState>,
    provider: String,
    request: CatalogRequest,
    my_anime_list_client_id: Option<String>,
) -> Result<CatalogResponse, String> {
    request.validate()?;
    let descriptor = state.provider(&provider)?;
    if !descriptor.capabilities.contains(&request.capability()) {
        return Err(format!(
            "{provider} does not support this catalog operation."
        ));
    }
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("The catalog cache directory is unavailable: {error}"))?
        .join("catalog");
    if provider == myanimelist::PROVIDER_ID {
        let client_id = myanimelist::validate_client_id(my_anime_list_client_id.as_deref())?;
        let adapter = state.myanimelist_adapter(&client_id)?;
        return adapter.request(request, cache_dir).await;
    }
    state.adapter(&provider)?.request(request, cache_dir).await
}

#[tauri::command]
pub fn catalog_providers(state: State<'_, CatalogState>) -> Vec<CatalogProvider> {
    state.providers.clone()
}

#[cfg(test)]
mod tests {
    use super::{
        validate_catalog_query, CatalogCapability, CatalogMedia, CatalogRequest, CatalogResponse,
        CatalogSeason, CatalogState,
    };

    #[test]
    fn validates_provider_independent_inputs() {
        assert!(validate_catalog_query("Frieren").is_ok());
        assert!(validate_catalog_query("x").is_err());
        assert!(validate_catalog_query("Frieren\nseason two").is_err());

        let request: CatalogRequest = serde_json::from_value(serde_json::json!({
            "kind": "season",
            "season": "SPRING",
            "year": 2026
        }))
        .unwrap();
        assert!(request.validate().is_ok());
        assert!(CatalogRequest::Season {
            season: CatalogSeason::Spring,
            year: 1200,
        }
        .validate()
        .is_err());
        assert!(serde_json::from_value::<CatalogRequest>(serde_json::json!({
            "kind": "season",
            "season": "spring",
            "year": 2026
        }))
        .is_err());
    }

    #[test]
    fn deserializes_and_validates_the_recommendations_contract() {
        let request: CatalogRequest = serde_json::from_value(serde_json::json!({
            "kind": "recommendations",
            "ids": [154587, 11061]
        }))
        .unwrap();
        assert!(request.validate().is_ok());
        assert_eq!(request.capability(), CatalogCapability::Recommendations);
        assert_eq!(request.season_context(), (None, None));

        assert!(CatalogRequest::Recommendations {
            ids: (1..=10).collect(),
        }
        .validate()
        .is_ok());
        for ids in [
            Vec::new(),
            vec![1, 1],
            vec![0],
            vec![i64::from(i32::MAX) + 1],
            (1..=11).collect(),
        ] {
            assert!(CatalogRequest::Recommendations { ids }.validate().is_err());
        }
        assert!(serde_json::from_value::<CatalogRequest>(serde_json::json!({
            "kind": "recommendation",
            "ids": [1]
        }))
        .is_err());
    }

    #[test]
    fn normalizes_anilist_cards_without_provider_fields() {
        let media = CatalogMedia::from_anilist(serde_json::json!({
            "id": 42,
            "idMal": 84,
            "title": { "romaji": "Example", "userPreferred": "Example" },
            "season": "SUMMER",
            "seasonYear": 2026,
            "format": "TV"
        }))
        .unwrap();
        let value = serde_json::to_value(media).unwrap();
        assert_eq!(value["id"], 42);
        assert_eq!(value["idMal"], 84);
        assert_eq!(value["season"], "SUMMER");
        assert!(value.get("provider").is_none());
    }

    #[test]
    fn serializes_the_agreed_catalog_envelope() {
        let request = CatalogRequest::Season {
            season: CatalogSeason::Winter,
            year: 2026,
        };
        let value = serde_json::to_value(CatalogResponse::new(
            "jikan",
            &request,
            Vec::new(),
            vec!["coverage warning".into()],
        ))
        .unwrap();
        assert_eq!(value["provider"], "jikan");
        assert_eq!(value["items"], serde_json::json!([]));
        assert_eq!(value["warnings"], serde_json::json!(["coverage warning"]));
        assert_eq!(value["season"], "WINTER");
        assert_eq!(value["year"], 2026);

        let recommendations = serde_json::to_value(CatalogResponse::new(
            "anilist",
            &CatalogRequest::Recommendations { ids: vec![42] },
            Vec::new(),
            Vec::new(),
        ))
        .unwrap();
        assert!(recommendations.get("season").is_none());
        assert!(recommendations.get("year").is_none());
    }

    #[test]
    fn registry_is_provider_driven_and_stably_ordered() {
        let state = CatalogState::new().unwrap();
        let providers = state
            .providers
            .iter()
            .map(|provider| provider.id)
            .collect::<Vec<_>>();
        assert_eq!(providers, ["anilist", "myanimelist", "jikan", "kitsu"]);
        for provider in [
            &state.providers[0],
            &state.providers[1],
            &state.providers[2],
        ] {
            assert!(provider
                .capabilities
                .contains(&CatalogCapability::Recommendations));
        }
        assert!(!state.providers[3]
            .capabilities
            .contains(&CatalogCapability::Recommendations));
        assert_eq!(CatalogSeason::Fall.as_str(), "FALL");
    }

    #[test]
    fn reuses_the_myanimelist_client_until_its_id_changes() {
        let state = CatalogState::new().unwrap();
        let first = state.myanimelist_adapter("client-a").unwrap();
        let again = state.myanimelist_adapter("client-a").unwrap();
        assert!(std::sync::Arc::ptr_eq(&first, &again));
        let replaced = state.myanimelist_adapter("client-b").unwrap();
        assert!(!std::sync::Arc::ptr_eq(&first, &replaced));
        assert!(std::sync::Arc::ptr_eq(
            &replaced,
            &state.myanimelist_adapter("client-b").unwrap()
        ));
    }

    #[test]
    fn reports_skipped_invalid_items_once() {
        let mut warnings = Vec::new();
        super::push_skipped_items_warning(&mut warnings, "Jikan", 0);
        assert!(warnings.is_empty());
        super::push_skipped_items_warning(&mut warnings, "Jikan", 2);
        assert_eq!(
            warnings,
            ["2 catalog item(s) from Jikan were skipped because they were invalid."]
        );
    }
}
