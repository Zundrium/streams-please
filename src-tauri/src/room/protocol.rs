use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::torrent::{magnet_info_hash, validate_magnet};

pub const ALPN: &[u8] = b"streamsplease/room/1";
pub const MAX_FRAME_BYTES: usize = 16 * 1024;
pub const MAX_PARTICIPANTS: usize = 8;
pub const MAX_NAME_CHARS: usize = 24;
pub const MAX_ROOM_MAGNET_BYTES: usize = 8_192;
pub const OUTBOUND_QUEUE_FRAMES: usize = 32;
pub const GUEST_RATE: Rate = Rate {
    per_second: 10,
    burst: 20,
};
pub const HOST_RATE: Rate = Rate {
    per_second: 30,
    burst: 60,
};

const DEFAULT_GUEST_NAME: &str = "Guest";
const MAX_POSITION_SECONDS: f64 = 86_400.0;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const PLAYBACK_SPEEDS: [f64; 5] = [1.0, 1.25, 1.5, 2.0, 0.75];

pub type EventSink = Arc<dyn Fn(RoomEvent) -> bool + Send + Sync>;

#[derive(Clone, Copy)]
pub struct Timing {
    pub online: Duration,
    pub connect: Duration,
    pub hello: Duration,
    pub silence: Duration,
    pub reconnect: Duration,
    pub farewell: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            online: Duration::from_secs(10),
            connect: Duration::from_secs(20),
            hello: Duration::from_secs(5),
            silence: Duration::from_secs(15),
            reconnect: Duration::from_secs(15),
            farewell: Duration::from_secs(1),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomMedia {
    pub magnet: String,
    pub title: String,
    pub episode: String,
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anilist_id: Option<u64>,
    pub image_url: String,
    pub quality: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomState {
    pub seq: u64,
    pub epoch: u64,
    pub media_seq: u64,
    pub media: Option<RoomMedia>,
    pub playing: bool,
    pub position: f64,
    pub host_time: f64,
    pub speed: f64,
}

impl Default for RoomState {
    fn default() -> Self {
        Self {
            seq: 0,
            epoch: 0,
            media_seq: 0,
            media: None,
            playing: false,
            position: 0.0,
            host_time: 0.0,
            speed: 1.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ParticipantPhase {
    Idle,
    Loading,
    Ready,
    Away,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuestStatus {
    pub epoch: u64,
    pub phase: ParticipantPhase,
    pub progress: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Participant {
    pub id: u32,
    pub name: String,
    pub host: bool,
    pub phase: ParticipantPhase,
    pub progress: Option<f64>,
    pub blocking: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseReason {
    Ended,
    Removed,
    Full,
    Locked,
    HostLost,
    Failed,
}

impl CloseReason {
    fn travels(self) -> bool {
        !matches!(self, Self::HostLost | Self::Failed)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PeerLeftReason {
    Left,
    Lost,
    Removed,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkStatus {
    Connected,
    Reconnecting,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Route {
    Direct,
    Relay,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GuestMessage {
    Hello { name: String },
    Status { status: GuestStatus },
    Ping { ping_id: u64, sent_at: f64 },
    Bye {},
}

impl GuestMessage {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Hello { .. } | Self::Bye {} => Ok(()),
            Self::Status { status } => validate_status(status),
            Self::Ping { ping_id, sent_at } => {
                validate_count(*ping_id)?;
                validate_clock_time(*sent_at)
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostMessage {
    Welcome {
        self_id: u32,
        host_name: String,
        state: RoomState,
        roster: Vec<Participant>,
    },
    State {
        state: RoomState,
    },
    Roster {
        participants: Vec<Participant>,
    },
    Pong {
        ping_id: u64,
        sent_at: f64,
        host_time: f64,
    },
    Closed {
        reason: CloseReason,
    },
}

impl HostMessage {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Welcome {
                self_id,
                host_name,
                state,
                roster,
            } => {
                if *self_id == 0 || !is_clean_name(host_name) {
                    return Err("The welcome is invalid.".into());
                }
                validate_state(state)?;
                validate_participants(roster)
            }
            Self::State { state } => validate_state(state),
            Self::Roster { participants } => validate_participants(participants),
            Self::Pong {
                ping_id,
                sent_at,
                host_time,
            } => {
                validate_count(*ping_id)?;
                validate_clock_time(*sent_at)?;
                validate_clock_time(*host_time)
            }
            Self::Closed { reason } if reason.travels() => Ok(()),
            Self::Closed { .. } => Err("The close reason is invalid.".into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RoomOutbound {
    State {
        state: RoomState,
    },
    Roster {
        participants: Vec<Participant>,
    },
    Pong {
        id: u32,
        ping_id: u64,
        sent_at: f64,
        host_time: f64,
    },
    Status {
        status: GuestStatus,
    },
    Ping {
        ping_id: u64,
        sent_at: f64,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RoomEvent {
    PeerJoined {
        id: u32,
        name: String,
    },
    PeerLeft {
        id: u32,
        reason: PeerLeftReason,
    },
    PeerStatus {
        id: u32,
        status: GuestStatus,
    },
    PeerPing {
        id: u32,
        ping_id: u64,
        sent_at: f64,
    },
    State {
        state: RoomState,
    },
    Roster {
        participants: Vec<Participant>,
    },
    Pong {
        ping_id: u64,
        sent_at: f64,
        host_time: f64,
    },
    Link {
        status: LinkStatus,
    },
    Route {
        id: u32,
        route: Route,
    },
    Closed {
        reason: CloseReason,
    },
}

pub fn clean_name(input: &str) -> String {
    let spaced: String = input
        .chars()
        .map(|character| {
            if character.is_control() || character == '\u{feff}' {
                ' '
            } else {
                character
            }
        })
        .collect();
    let collapsed = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = collapsed.chars().take(MAX_NAME_CHARS).collect();
    match cut.trim() {
        "" => DEFAULT_GUEST_NAME.to_string(),
        name => name.to_string(),
    }
}

fn is_clean_name(name: &str) -> bool {
    clean_name(name) == name
}

fn is_text(value: &str, max_units: usize) -> bool {
    value.encode_utf16().count() <= max_units && !value.chars().any(char::is_control)
}

fn is_image_url(value: &str) -> bool {
    let local = value.starts_with('/') && !value.starts_with("//");
    !value.is_empty()
        && is_text(value, 500)
        && !value.chars().any(char::is_whitespace)
        && (value.starts_with("https://") || local)
}

fn is_slug(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn validate_count(value: u64) -> Result<(), String> {
    if value <= MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err("A room counter is out of range.".into())
    }
}

fn validate_clock_time(value: f64) -> Result<(), String> {
    if value.is_finite() && (0.0..=MAX_SAFE_INTEGER as f64).contains(&value) {
        Ok(())
    } else {
        Err("A room timestamp is out of range.".into())
    }
}

fn validate_progress(progress: Option<f64>) -> Result<(), String> {
    match progress {
        Some(value) if !value.is_finite() || !(0.0..=1.0).contains(&value) => {
            Err("The loading progress is out of range.".into())
        }
        _ => Ok(()),
    }
}

fn validate_room_magnet(magnet: &str) -> Result<(), String> {
    if magnet.len() > MAX_ROOM_MAGNET_BYTES
        || magnet != magnet.trim()
        || !is_text(magnet, usize::MAX)
    {
        return Err("The room magnet link is invalid.".into());
    }
    validate_magnet(magnet)?;
    magnet_info_hash(magnet).map(|_| ())
}

pub fn validate_media(media: &RoomMedia) -> Result<(), String> {
    validate_room_magnet(&media.magnet)?;
    let valid = !media.title.is_empty()
        && is_text(&media.title, 200)
        && is_text(&media.episode, 16)
        && is_text(&media.slug, 120)
        && is_slug(&media.slug)
        && is_image_url(&media.image_url)
        && is_text(&media.quality, 8)
        && media
            .anilist_id
            .is_none_or(|id| id > 0 && id <= MAX_SAFE_INTEGER);
    if valid {
        Ok(())
    } else {
        Err("The room media is invalid.".into())
    }
}

pub fn validate_state(state: &RoomState) -> Result<(), String> {
    validate_count(state.seq)?;
    validate_count(state.epoch)?;
    validate_count(state.media_seq)?;
    validate_clock_time(state.host_time)?;
    if let Some(media) = &state.media {
        validate_media(media)?;
    }
    let valid = state.position.is_finite()
        && (0.0..=MAX_POSITION_SECONDS).contains(&state.position)
        && PLAYBACK_SPEEDS.contains(&state.speed)
        && (!state.playing || state.media.is_some());
    if valid {
        Ok(())
    } else {
        Err("The room state is invalid.".into())
    }
}

pub fn validate_status(status: &GuestStatus) -> Result<(), String> {
    validate_count(status.epoch)?;
    validate_progress(status.progress)
}

pub fn validate_participants(participants: &[Participant]) -> Result<(), String> {
    let mut ids = HashSet::new();
    let valid = participants.len() <= MAX_PARTICIPANTS
        && participants.iter().all(|participant| {
            ids.insert(participant.id)
                && participant.host == (participant.id == 0)
                && is_clean_name(&participant.name)
                && validate_progress(participant.progress).is_ok()
        });
    if valid {
        Ok(())
    } else {
        Err("The room roster is invalid.".into())
    }
}

impl RoomOutbound {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::State { state } => validate_state(state),
            Self::Roster { participants } => validate_participants(participants),
            Self::Pong {
                ping_id,
                sent_at,
                host_time,
                ..
            } => {
                validate_count(*ping_id)?;
                validate_clock_time(*sent_at)?;
                validate_clock_time(*host_time)
            }
            Self::Status { status } => validate_status(status),
            Self::Ping { ping_id, sent_at } => {
                validate_count(*ping_id)?;
                validate_clock_time(*sent_at)
            }
        }
    }
}

pub async fn write_frame<W, T>(writer: &mut W, message: &T) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let body = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    if body.len() > MAX_FRAME_BYTES {
        return Err("The room message is too large.".into());
    }
    let mut frame = Vec::with_capacity(body.len() + 4);
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    writer
        .write_all(&frame)
        .await
        .map_err(|error| error.to_string())
}

pub async fn read_frame<R, T>(reader: &mut R) -> Result<T, String>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let length = reader.read_u32().await.map_err(|error| error.to_string())? as usize;
    if length > MAX_FRAME_BYTES {
        return Err(format!(
            "A room message of {length} bytes exceeds the limit."
        ));
    }
    let mut body = vec![0; length];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&body).map_err(|error| error.to_string())
}

#[derive(Clone, Copy)]
pub struct Rate {
    pub per_second: u32,
    pub burst: u32,
}

pub struct TokenBucket {
    rate: Rate,
    tokens: f64,
    refilled: Instant,
}

impl TokenBucket {
    pub fn new(rate: Rate, now: Instant) -> Self {
        Self {
            rate,
            tokens: f64::from(rate.burst),
            refilled: now,
        }
    }

    pub fn allow(&mut self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.refilled).as_secs_f64();
        let refilled = self.tokens + elapsed * f64::from(self.rate.per_second);
        self.tokens = refilled.min(f64::from(self.rate.burst));
        self.refilled = now;
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

#[cfg(test)]
pub mod tests {
    use serde_json::{json, Value};

    use super::*;

    pub const MAGNET: &str =
        "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel";

    pub fn media() -> RoomMedia {
        RoomMedia {
            magnet: MAGNET.into(),
            title: "Sintel".into(),
            episode: "01".into(),
            slug: "sintel".into(),
            anilist_id: Some(7),
            image_url: "https://s4.anilist.co/sintel.jpg".into(),
            quality: "1080".into(),
        }
    }

    pub fn state() -> RoomState {
        RoomState {
            seq: 3,
            epoch: 2,
            media_seq: 1,
            media: Some(media()),
            playing: true,
            position: 12.5,
            host_time: 1_800_000_000_000.0,
            speed: 1.25,
        }
    }

    pub fn participant(id: u32, name: &str) -> Participant {
        Participant {
            id,
            name: name.into(),
            host: id == 0,
            phase: ParticipantPhase::Ready,
            progress: None,
            blocking: false,
        }
    }

    fn parse<T: DeserializeOwned>(value: Value) -> Result<T, serde_json::Error> {
        serde_json::from_value(value)
    }

    #[tokio::test]
    async fn frames_round_trip() {
        let message = HostMessage::State { state: state() };
        let mut wire = Vec::new();
        write_frame(&mut wire, &message).await.unwrap();

        let read: HostMessage = read_frame(&mut wire.as_slice()).await.unwrap();

        assert_eq!(read, message);
        assert_eq!(wire[..4], ((wire.len() - 4) as u32).to_be_bytes());
    }

    #[tokio::test]
    async fn oversized_frames_are_rejected_before_the_body_is_read() {
        let header = ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes();
        let error = read_frame::<_, HostMessage>(&mut &header[..])
            .await
            .unwrap_err();
        assert!(error.contains("exceeds the limit"), "{error}");

        let huge = HostMessage::Welcome {
            self_id: 1,
            host_name: "x".repeat(MAX_FRAME_BYTES),
            state: RoomState::default(),
            roster: Vec::new(),
        };
        assert!(write_frame(&mut Vec::new(), &huge).await.is_err());
    }

    #[tokio::test]
    async fn truncated_and_malformed_frames_are_rejected() {
        let mut wire = Vec::new();
        write_frame(&mut wire, &GuestMessage::Bye {}).await.unwrap();
        let truncated = &wire[..wire.len() - 1];
        assert!(read_frame::<_, GuestMessage>(&mut &truncated[..])
            .await
            .is_err());

        let mut garbage = 3u32.to_be_bytes().to_vec();
        garbage.extend_from_slice(b"{]}");
        assert!(read_frame::<_, GuestMessage>(&mut garbage.as_slice())
            .await
            .is_err());
    }

    #[test]
    fn wire_shapes_match_the_frontend_contract() {
        let state_json = serde_json::to_value(state()).unwrap();
        assert_eq!(state_json["mediaSeq"], 1);
        assert_eq!(state_json["hostTime"], 1_800_000_000_000.0);
        assert_eq!(state_json["media"]["anilistId"], 7);
        assert_eq!(
            state_json["media"]["imageUrl"],
            "https://s4.anilist.co/sintel.jpg"
        );

        let without_id = RoomMedia {
            anilist_id: None,
            ..media()
        };
        assert!(serde_json::to_value(without_id)
            .unwrap()
            .get("anilistId")
            .is_none());

        assert_eq!(
            serde_json::to_value(RoomEvent::PeerPing {
                id: 2,
                ping_id: 5,
                sent_at: 10.0
            })
            .unwrap(),
            json!({ "type": "peerPing", "id": 2, "pingId": 5, "sentAt": 10.0 })
        );
        assert_eq!(
            serde_json::to_value(RoomEvent::Closed {
                reason: CloseReason::HostLost
            })
            .unwrap(),
            json!({ "type": "closed", "reason": "hostLost" })
        );
        assert_eq!(
            parse::<RoomOutbound>(
                json!({ "type": "pong", "id": 1, "pingId": 2, "sentAt": 3, "hostTime": 4 })
            )
            .unwrap(),
            RoomOutbound::Pong {
                id: 1,
                ping_id: 2,
                sent_at: 3.0,
                host_time: 4.0
            }
        );
    }

    #[test]
    fn each_side_only_parses_the_other_sides_messages() {
        let status = json!({
            "type": "status",
            "status": { "epoch": 1, "phase": "ready", "progress": null }
        });
        let roster = json!({ "type": "roster", "participants": [] });

        assert!(parse::<GuestMessage>(status.clone()).is_ok());
        assert!(parse::<HostMessage>(status).is_err());
        assert!(parse::<HostMessage>(roster.clone()).is_ok());
        assert!(parse::<GuestMessage>(roster).is_err());
    }

    #[test]
    fn unknown_types_and_fields_are_rejected() {
        assert!(parse::<GuestMessage>(json!({ "type": "chat", "text": "hi" })).is_err());
        assert!(parse::<GuestMessage>(json!({ "type": "bye", "extra": 1 })).is_err());
        assert!(parse::<GuestMessage>(json!({
            "type": "status",
            "status": { "epoch": 1, "phase": "ready", "progress": null, "extra": 1 }
        }))
        .is_err());
        assert!(parse::<GuestMessage>(json!({
            "type": "status",
            "status": { "epoch": 1, "phase": "sleeping", "progress": null }
        }))
        .is_err());
        assert!(parse::<GuestMessage>(json!({
            "type": "status",
            "status": { "epoch": -1, "phase": "ready", "progress": null }
        }))
        .is_err());
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean_name("  Alice\u{0007}\n  B  "), "Alice B");
        assert_eq!(clean_name("\u{0000}\t"), "Guest");
        assert_eq!(clean_name(&"é".repeat(40)), "é".repeat(24));
        assert!(is_clean_name("Alice B"));
        assert!(!is_clean_name(" Alice"));
        assert!(!is_clean_name(""));
    }

    #[test]
    fn media_rules_are_enforced() {
        assert!(validate_media(&media()).is_ok());
        assert!(validate_media(&RoomMedia {
            image_url: "/poster.png".into(),
            anilist_id: None,
            ..media()
        })
        .is_ok());

        let invalid = [
            RoomMedia {
                magnet: "https://example.com/video.mkv".into(),
                ..media()
            },
            RoomMedia {
                magnet: "magnet:?xt=urn:btih:0123".into(),
                ..media()
            },
            RoomMedia {
                magnet: format!("{MAGNET}&dn={}", "a".repeat(MAX_ROOM_MAGNET_BYTES)),
                ..media()
            },
            RoomMedia {
                title: String::new(),
                ..media()
            },
            RoomMedia {
                title: "a".repeat(201),
                ..media()
            },
            RoomMedia {
                title: "line\nbreak".into(),
                ..media()
            },
            RoomMedia {
                episode: "1".repeat(17),
                ..media()
            },
            RoomMedia {
                slug: "Not_A_Slug".into(),
                ..media()
            },
            RoomMedia {
                quality: "123456789".into(),
                ..media()
            },
            RoomMedia {
                image_url: "http://example.com/a.jpg".into(),
                ..media()
            },
            RoomMedia {
                image_url: "//example.com/a.jpg".into(),
                ..media()
            },
            RoomMedia {
                image_url: "https://example.com/a b.jpg".into(),
                ..media()
            },
            RoomMedia {
                anilist_id: Some(0),
                ..media()
            },
        ];
        for media in invalid {
            assert!(validate_media(&media).is_err(), "{media:?}");
        }
    }

    #[test]
    fn state_rules_are_enforced() {
        assert!(validate_state(&state()).is_ok());
        assert!(validate_state(&RoomState::default()).is_ok());

        let invalid = [
            RoomState {
                seq: MAX_SAFE_INTEGER + 1,
                ..state()
            },
            RoomState {
                position: -1.0,
                ..state()
            },
            RoomState {
                position: 86_401.0,
                ..state()
            },
            RoomState {
                position: f64::NAN,
                ..state()
            },
            RoomState {
                host_time: f64::INFINITY,
                ..state()
            },
            RoomState {
                speed: 3.0,
                ..state()
            },
            RoomState {
                media: None,
                ..state()
            },
        ];
        for state in invalid {
            assert!(validate_state(&state).is_err(), "{state:?}");
        }
    }

    #[test]
    fn status_and_roster_rules_are_enforced() {
        let status = |progress| GuestStatus {
            epoch: 1,
            phase: ParticipantPhase::Loading,
            progress,
        };
        assert!(validate_status(&status(Some(0.4))).is_ok());
        assert!(validate_status(&status(None)).is_ok());
        assert!(validate_status(&status(Some(1.5))).is_err());

        let roster = vec![participant(0, "Host"), participant(1, "Alice")];
        assert!(validate_participants(&roster).is_ok());
        assert!(validate_participants(&[participant(1, "Alice"), participant(1, "Bob")]).is_err());
        assert!(validate_participants(&[participant(1, " Alice ")]).is_err());
        assert!(validate_participants(&[Participant {
            host: true,
            ..participant(1, "Alice")
        }])
        .is_err());
        let crowd: Vec<_> = (0..9).map(|id| participant(id, "Guest")).collect();
        assert!(validate_participants(&crowd).is_err());
    }

    #[test]
    fn host_messages_are_validated() {
        let welcome = |self_id, host_name: &str| HostMessage::Welcome {
            self_id,
            host_name: host_name.into(),
            state: RoomState::default(),
            roster: vec![participant(0, "Host")],
        };
        assert!(welcome(1, "Host").validate().is_ok());
        assert!(welcome(0, "Host").validate().is_err());
        assert!(welcome(1, "Host\u{0007}").validate().is_err());

        let closed = |reason| HostMessage::Closed { reason };
        assert!(closed(CloseReason::Locked).validate().is_ok());
        assert!(closed(CloseReason::HostLost).validate().is_err());
        assert!(HostMessage::Pong {
            ping_id: 1,
            sent_at: -1.0,
            host_time: 0.0
        }
        .validate()
        .is_err());
    }

    #[test]
    fn token_bucket_allows_a_burst_then_the_steady_rate() {
        let start = Instant::now();
        let mut bucket = TokenBucket::new(GUEST_RATE, start);

        assert!((0..20).all(|_| bucket.allow(start)));
        assert!(!bucket.allow(start));
        assert!(bucket.allow(start + Duration::from_millis(100)));
        assert!(!bucket.allow(start + Duration::from_millis(100)));

        let later = start + Duration::from_secs(60);
        assert!((0..20).all(|_| bucket.allow(later)));
        assert!(!bucket.allow(later));
    }
}
