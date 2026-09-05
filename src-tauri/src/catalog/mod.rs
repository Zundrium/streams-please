pub mod anilist;
pub mod subsplease;

pub struct CatalogState {
    http: reqwest::Client,
    anilist: anilist::AniListClient,
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
        let anilist = anilist::AniListClient::new(http.clone());
        Ok(Self { http, anilist })
    }
}
