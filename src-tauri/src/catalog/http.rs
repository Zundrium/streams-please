use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, RETRY_AFTER},
    Method, StatusCode, Url,
};
use serde_json::Value;
use tokio::sync::Semaphore;

pub(super) const MAX_JSON_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub(super) const NETWORK_COOLDOWN: Duration = Duration::from_secs(30);
pub(super) const REJECTED_COOLDOWN: Duration = Duration::from_secs(5 * 60);
const SERVER_COOLDOWN: Duration = Duration::from_secs(60);
const DEFAULT_RATE_COOLDOWN_SECONDS: u64 = 30;
const MAX_RATE_COOLDOWN_SECONDS: u64 = 5 * 60;

pub(super) type ResponseInterpreter =
    fn(&ProviderPolicy, &ProviderResponse) -> Result<Value, ProviderFailure>;

pub(super) struct ProviderPolicy {
    pub(super) label: &'static str,
    pub(super) accept: &'static str,
    pub(super) max_concurrent_requests: usize,
    pub(super) request_interval: Duration,
    pub(super) cache_ttl: Duration,
    pub(super) cache_limit: usize,
    pub(super) max_response_bytes: usize,
    pub(super) network_cooldown: Option<Duration>,
    pub(super) interpret: ResponseInterpreter,
}

impl ProviderPolicy {
    pub(super) fn transport_failure(&self, message: String) -> ProviderFailure {
        match self.network_cooldown {
            Some(duration) => ProviderFailure::cooldown(
                duration,
                format!("{message} This request will not retry automatically."),
            ),
            None => ProviderFailure::new(message),
        }
    }
}

pub(super) struct ProviderResponse {
    pub(super) status: StatusCode,
    pub(super) retry_after: Option<String>,
    pub(super) body: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Penalty {
    Cooldown(Duration),
    Block(Duration),
}

#[derive(Debug)]
pub(super) struct ProviderFailure {
    pub(super) penalty: Option<Penalty>,
    pub(super) message: String,
}

impl ProviderFailure {
    pub(super) fn new(message: impl Into<String>) -> Self {
        Self {
            penalty: None,
            message: message.into(),
        }
    }

    pub(super) fn cooldown(duration: Duration, message: impl Into<String>) -> Self {
        Self {
            penalty: Some(Penalty::Cooldown(duration)),
            message: message.into(),
        }
    }

    pub(super) fn block(duration: Duration, message: impl Into<String>) -> Self {
        Self {
            penalty: Some(Penalty::Block(duration)),
            message: message.into(),
        }
    }
}

struct CacheEntry {
    expires_at: Instant,
    value: Value,
}

pub(super) struct RequestControl {
    cache: HashMap<String, CacheEntry>,
    blocked: Option<(Instant, String)>,
    cooldown_until: Option<Instant>,
    next_request_at: Instant,
}

impl RequestControl {
    pub(super) fn new(now: Instant) -> Self {
        Self {
            cache: HashMap::new(),
            blocked: None,
            cooldown_until: None,
            next_request_at: now,
        }
    }

    pub(super) fn cached(&mut self, key: &str, now: Instant) -> Option<Value> {
        self.cache.retain(|_, entry| entry.expires_at > now);
        self.cache.get(key).map(|entry| entry.value.clone())
    }

    pub(super) fn store(
        &mut self,
        key: String,
        value: Value,
        policy: &ProviderPolicy,
        now: Instant,
    ) {
        self.cache.retain(|_, entry| entry.expires_at > now);
        if !self.cache.contains_key(&key) && self.cache.len() >= policy.cache_limit {
            if let Some(oldest_key) = self
                .cache
                .iter()
                .min_by_key(|(_, entry)| entry.expires_at)
                .map(|(key, _)| key.clone())
            {
                self.cache.remove(&oldest_key);
            }
        }
        self.cache.insert(
            key,
            CacheEntry {
                expires_at: now + policy.cache_ttl,
                value,
            },
        );
    }

    #[cfg(test)]
    pub(super) fn cache_len(&self) -> usize {
        self.cache.len()
    }

    pub(super) fn ensure_available(&mut self, label: &str, now: Instant) -> Result<(), String> {
        if let Some((until, message)) = &self.blocked {
            if *until > now {
                return Err(message.clone());
            }
        }
        self.blocked = None;

        let Some(until) = self.cooldown_until else {
            return Ok(());
        };
        if until <= now {
            self.cooldown_until = None;
            return Ok(());
        }
        let remaining = until.saturating_duration_since(now);
        let seconds = remaining.as_secs() + u64::from(remaining.subsec_nanos() > 0);
        Err(format!(
            "{label} requests are cooling down. Try again in {seconds} seconds."
        ))
    }

    pub(super) fn reserve(
        &mut self,
        policy: &ProviderPolicy,
        now: Instant,
    ) -> Result<Duration, String> {
        self.ensure_available(policy.label, now)?;
        let request_at = self.next_request_at.max(now);
        self.next_request_at = request_at + policy.request_interval;
        Ok(request_at.saturating_duration_since(now))
    }

    pub(super) fn penalize(&mut self, penalty: Penalty, message: &str, now: Instant) {
        match penalty {
            Penalty::Cooldown(duration) => self.cooldown_until = Some(now + duration),
            Penalty::Block(duration) => self.blocked = Some((now + duration, message.to_owned())),
        }
    }
}

pub(super) struct ProviderHttp {
    http: reqwest::Client,
    policy: &'static ProviderPolicy,
    headers: HeaderMap,
    in_flight: Semaphore,
    control: Mutex<RequestControl>,
}

impl ProviderHttp {
    pub(super) fn new(http: reqwest::Client, policy: &'static ProviderPolicy) -> Self {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static(policy.accept));
        Self {
            http,
            policy,
            headers,
            in_flight: Semaphore::new(policy.max_concurrent_requests),
            control: Mutex::new(RequestControl::new(Instant::now())),
        }
    }

    pub(super) fn with_header(mut self, name: HeaderName, value: HeaderValue) -> Self {
        self.headers.insert(name, value);
        self
    }

    pub(super) async fn get_json(&self, url: Url) -> Result<Value, String> {
        let cache_key = url.as_str().to_owned();
        self.request(Method::GET, url, None, cache_key).await
    }

    pub(super) async fn post_json(&self, url: Url, body: &Value) -> Result<Value, String> {
        let serialized = serde_json::to_string(body).map_err(|error| {
            format!(
                "The {} request could not be prepared: {error}",
                self.policy.label
            )
        })?;
        let cache_key = format!("{url} {serialized}");
        self.request(Method::POST, url, Some(body), cache_key).await
    }

    async fn request(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
        cache_key: String,
    ) -> Result<Value, String> {
        let policy = self.policy;
        if let Some(value) =
            self.with_control(|control, now| Ok(control.cached(&cache_key, now)))?
        {
            return Ok(value);
        }
        let _permit = self
            .in_flight
            .acquire()
            .await
            .map_err(|_| format!("The {} request queue is unavailable.", policy.label))?;
        if let Some(value) =
            self.with_control(|control, now| Ok(control.cached(&cache_key, now)))?
        {
            return Ok(value);
        }

        let wait = self.with_control(|control, now| control.reserve(policy, now))?;
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        self.with_control(|control, now| control.ensure_available(policy.label, now))?;

        let mut request = self.http.request(method, url).headers(self.headers.clone());
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                return Err(self.reject(
                    policy.transport_failure(format!("{} is unreachable: {error}.", policy.label)),
                ))
            }
        };
        let status = response.status();
        let retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = match read_bounded_body(response, policy.max_response_bytes, policy.label).await
        {
            Ok(body) => body,
            Err(error) if status.is_success() => {
                return Err(self.reject(policy.transport_failure(error)))
            }
            Err(_) => Vec::new(),
        };
        let response = ProviderResponse {
            status,
            retry_after,
            body,
        };
        match (policy.interpret)(policy, &response) {
            Ok(value) => {
                self.with_control(|control, now| {
                    control.store(cache_key, value.clone(), policy, now);
                    Ok(())
                })?;
                Ok(value)
            }
            Err(failure) => Err(self.reject(failure)),
        }
    }

    fn with_control<T>(
        &self,
        operation: impl FnOnce(&mut RequestControl, Instant) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut control = self
            .control
            .lock()
            .map_err(|_| format!("The {} request state is unavailable.", self.policy.label))?;
        operation(&mut control, Instant::now())
    }

    fn reject(&self, failure: ProviderFailure) -> String {
        if let Some(penalty) = failure.penalty {
            if let Err(error) = self.with_control(|control, now| {
                control.penalize(penalty, &failure.message, now);
                Ok(())
            }) {
                return error;
            }
        }
        failure.message
    }
}

pub(super) fn interpret_json(
    policy: &ProviderPolicy,
    response: &ProviderResponse,
) -> Result<Value, ProviderFailure> {
    let label = policy.label;
    let status = response.status;
    if status == StatusCode::TOO_MANY_REQUESTS {
        let cooldown = rate_limit_cooldown(response.retry_after.as_deref());
        return Err(ProviderFailure::cooldown(
            cooldown,
            format!(
                "{label} is rate limiting requests. Try again in {} seconds; this request will not retry automatically.",
                cooldown.as_secs()
            ),
        ));
    }
    if status == StatusCode::FORBIDDEN {
        return Err(ProviderFailure::cooldown(
            REJECTED_COOLDOWN,
            format!(
                "{label} rejected this request (HTTP 403); this request will not retry automatically."
            ),
        ));
    }
    if status.is_server_error() {
        return Err(ProviderFailure::cooldown(
            SERVER_COOLDOWN,
            format!(
                "{label} returned an HTTP {status} server error; this request will not retry automatically."
            ),
        ));
    }
    if !status.is_success() {
        return Err(ProviderFailure::new(format!(
            "{label} returned an HTTP {status} error."
        )));
    }
    serde_json::from_slice(&response.body).map_err(|error| {
        policy.transport_failure(format!("{label} returned invalid JSON: {error}"))
    })
}

pub(super) fn retry_after_seconds(retry_after: Option<&str>) -> Option<u64> {
    retry_after
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| seconds.clamp(1, MAX_RATE_COOLDOWN_SECONDS))
}

pub(super) fn rate_limit_cooldown(retry_after: Option<&str>) -> Duration {
    Duration::from_secs(retry_after_seconds(retry_after).unwrap_or(DEFAULT_RATE_COOLDOWN_SECONDS))
}

pub(super) async fn read_bounded_body(
    mut response: reqwest::Response,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(too_large_message(label));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("The {label} response could not be read: {error}"))?
    {
        append_bounded(&mut bytes, &chunk, max_bytes, label)?;
    }
    Ok(bytes)
}

pub(super) fn append_bounded(
    target: &mut Vec<u8>,
    chunk: &[u8],
    max_bytes: usize,
    label: &str,
) -> Result<(), String> {
    if chunk.len() > max_bytes.saturating_sub(target.len()) {
        return Err(too_large_message(label));
    }
    target.extend_from_slice(chunk);
    Ok(())
}

fn too_large_message(label: &str) -> String {
    format!("The {label} response is too large.")
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use reqwest::StatusCode;
    use serde_json::json;

    use super::{
        append_bounded, interpret_json, rate_limit_cooldown, retry_after_seconds, Penalty,
        ProviderPolicy, ProviderResponse, RequestControl, NETWORK_COOLDOWN, REJECTED_COOLDOWN,
    };

    static TEST_POLICY: ProviderPolicy = ProviderPolicy {
        label: "Example",
        accept: "application/json",
        max_concurrent_requests: 1,
        request_interval: Duration::from_millis(1_000),
        cache_ttl: Duration::from_secs(60),
        cache_limit: 2,
        max_response_bytes: 4,
        network_cooldown: Some(NETWORK_COOLDOWN),
        interpret: interpret_json,
    };

    fn response(status: StatusCode, retry_after: Option<&str>, body: &[u8]) -> ProviderResponse {
        ProviderResponse {
            status,
            retry_after: retry_after.map(str::to_owned),
            body: body.to_vec(),
        }
    }

    #[test]
    fn bounds_response_assembly_and_names_the_provider() {
        let mut bytes = vec![0; 2];
        append_bounded(&mut bytes, &[1, 2], 4, "Example").unwrap();
        assert_eq!(bytes, [0, 0, 1, 2]);
        assert_eq!(
            append_bounded(&mut bytes, &[3], 4, "Example").unwrap_err(),
            "The Example response is too large."
        );
        assert_eq!(bytes.len(), 4);
    }

    #[test]
    fn parses_and_bounds_retry_after_headers() {
        assert_eq!(retry_after_seconds(Some(" 42 ")), Some(42));
        assert_eq!(retry_after_seconds(Some("0")), Some(1));
        assert_eq!(retry_after_seconds(Some("9999")), Some(300));
        assert_eq!(retry_after_seconds(Some("soon")), None);
        assert_eq!(retry_after_seconds(None), None);
        assert_eq!(rate_limit_cooldown(Some("0")), Duration::from_secs(1));
        assert_eq!(rate_limit_cooldown(Some("9999")), Duration::from_secs(300));
        assert_eq!(rate_limit_cooldown(None), Duration::from_secs(30));
    }

    #[test]
    fn expires_and_trims_cached_responses() {
        let now = Instant::now();
        let mut control = RequestControl::new(now);
        control.store("a".into(), json!(1), &TEST_POLICY, now);
        control.store(
            "b".into(),
            json!(2),
            &TEST_POLICY,
            now + Duration::from_secs(1),
        );
        control.store(
            "c".into(),
            json!(3),
            &TEST_POLICY,
            now + Duration::from_secs(2),
        );
        assert_eq!(control.cache_len(), 2);
        assert_eq!(control.cached("a", now + Duration::from_secs(2)), None);
        assert_eq!(
            control.cached("b", now + Duration::from_secs(2)),
            Some(json!(2))
        );
        assert_eq!(control.cached("b", now + Duration::from_secs(61)), None);
        assert_eq!(
            control.cached("c", now + Duration::from_secs(61)),
            Some(json!(3))
        );
        assert_eq!(control.cached("c", now + Duration::from_secs(62)), None);
        assert_eq!(control.cache_len(), 0);
    }

    #[test]
    fn spaces_requests_and_enforces_cooldowns_and_blocks() {
        let now = Instant::now();
        let mut control = RequestControl::new(now);
        assert_eq!(control.reserve(&TEST_POLICY, now).unwrap(), Duration::ZERO);
        assert_eq!(
            control.reserve(&TEST_POLICY, now).unwrap(),
            Duration::from_secs(1)
        );
        assert_eq!(
            control
                .reserve(&TEST_POLICY, now + Duration::from_millis(1_500))
                .unwrap(),
            Duration::from_millis(500)
        );

        control.penalize(Penalty::Cooldown(Duration::from_secs(30)), "ignored", now);
        assert_eq!(
            control
                .reserve(&TEST_POLICY, now + Duration::from_millis(500))
                .unwrap_err(),
            "Example requests are cooling down. Try again in 30 seconds."
        );
        assert!(control
            .ensure_available("Example", now + Duration::from_secs(31))
            .is_ok());

        control.penalize(Penalty::Block(Duration::from_secs(60)), "Blocked.", now);
        assert_eq!(
            control
                .ensure_available("Example", now + Duration::from_secs(59))
                .unwrap_err(),
            "Blocked."
        );
        assert!(control
            .ensure_available("Example", now + Duration::from_secs(60))
            .is_ok());
    }

    #[test]
    fn classifies_standard_json_provider_statuses() {
        let rate_limited = interpret_json(
            &TEST_POLICY,
            &response(StatusCode::TOO_MANY_REQUESTS, Some("12"), b""),
        )
        .unwrap_err();
        assert_eq!(
            rate_limited.penalty,
            Some(Penalty::Cooldown(Duration::from_secs(12)))
        );
        assert!(rate_limited.message.contains("Try again in 12 seconds"));

        let forbidden =
            interpret_json(&TEST_POLICY, &response(StatusCode::FORBIDDEN, None, b"")).unwrap_err();
        assert_eq!(
            forbidden.penalty,
            Some(Penalty::Cooldown(REJECTED_COOLDOWN))
        );
        assert!(forbidden.message.contains("HTTP 403"));

        let server = interpret_json(&TEST_POLICY, &response(StatusCode::BAD_GATEWAY, None, b""))
            .unwrap_err();
        assert_eq!(
            server.penalty,
            Some(Penalty::Cooldown(Duration::from_secs(60)))
        );

        let missing =
            interpret_json(&TEST_POLICY, &response(StatusCode::NOT_FOUND, None, b"")).unwrap_err();
        assert_eq!(missing.penalty, None);
        assert_eq!(
            missing.message,
            "Example returned an HTTP 404 Not Found error."
        );

        let invalid =
            interpret_json(&TEST_POLICY, &response(StatusCode::OK, None, b"nope")).unwrap_err();
        assert_eq!(invalid.penalty, Some(Penalty::Cooldown(NETWORK_COOLDOWN)));
        assert!(invalid.message.starts_with("Example returned invalid JSON"));
        assert!(invalid.message.ends_with("will not retry automatically."));

        assert_eq!(
            interpret_json(&TEST_POLICY, &response(StatusCode::OK, None, b"{\"a\":1}")).unwrap(),
            json!({ "a": 1 })
        );
    }
}
