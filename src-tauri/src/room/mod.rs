use std::{sync::Arc, time::Duration};

use iroh::{
    endpoint::{presets, Connection, SendStream},
    Endpoint, RelayMode,
};
use serde::Serialize;
use tauri::{ipc::Channel, State};
use tokio::sync::{mpsc, watch, Mutex};

mod guest;
mod host;
mod invite;
mod protocol;

use guest::GuestSession;
use host::HostSession;
use protocol::{write_frame, EventSink, RoomEvent, RoomOutbound, Route};

const NOT_IN_A_ROOM: &str = "You are not in a room.";
const HOST_ONLY: &str = "Only the host can do this.";
const SUPERSEDED: &str = "The room was left before it was ready.";

enum Session {
    Host(HostSession),
    Guest(GuestSession),
}

impl Session {
    async fn close(self) {
        match self {
            Self::Host(host) => host.close().await,
            Self::Guest(guest) => guest.close().await,
        }
    }
}

pub struct RoomService {
    generation: watch::Sender<u64>,
    session: Mutex<Option<Session>>,
}

impl RoomService {
    pub fn new() -> Self {
        Self {
            generation: watch::Sender::new(0),
            session: Mutex::new(None),
        }
    }

    pub async fn shutdown(&self) {
        self.replace().await;
    }

    async fn replace(&self) -> u64 {
        let mut generation = 0;
        self.generation.send_modify(|current| {
            *current += 1;
            generation = *current;
        });
        let previous = self.session.lock().await.take();
        if let Some(previous) = previous {
            previous.close().await;
        }
        generation
    }

    async fn superseded(&self, generation: u64) {
        let mut current = self.generation.subscribe();
        let _ = current.wait_for(|current| *current != generation).await;
    }

    async fn install(&self, generation: u64, session: Session) -> Result<(), String> {
        let mut slot = self.session.lock().await;
        if *self.generation.borrow() == generation {
            *slot = Some(session);
            return Ok(());
        }
        drop(slot);
        session.close().await;
        Err(SUPERSEDED.into())
    }

    async fn is_hosting(&self, endpoint_id: iroh::PublicKey) -> bool {
        matches!(
            &*self.session.lock().await,
            Some(Session::Host(host)) if host.endpoint_id() == endpoint_id
        )
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomHostResult {
    invite: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomJoinResult {
    self_id: u32,
    host_name: String,
}

fn event_sink(channel: Channel<RoomEvent>) -> EventSink {
    Arc::new(move |event| channel.send(event).is_ok())
}

async fn bind_endpoint(alpns: Vec<Vec<u8>>) -> Result<Endpoint, String> {
    Endpoint::builder(presets::Minimal)
        .relay_mode(RelayMode::Default)
        .alpns(alpns)
        .bind()
        .await
        .map_err(|error| format!("The room connection could not be opened: {error}"))
}

fn selected_route(connection: &Connection) -> Option<Route> {
    let paths = connection.paths();
    let selected = paths.iter().find(|path| path.is_selected())?;
    if selected.is_ip() {
        Some(Route::Direct)
    } else if selected.is_relay() {
        Some(Route::Relay)
    } else {
        None
    }
}

async fn say_farewell(connection: &Connection, send: &mut SendStream, farewell: Duration) {
    let _ = send.finish();
    let _ = tokio::time::timeout(farewell, connection.closed()).await;
}

async fn write_outbound<T, F>(
    connection: Connection,
    mut send: SendStream,
    mut outbound: mpsc::Receiver<T>,
    is_farewell: F,
    farewell: Duration,
) where
    T: Serialize + Send + Sync + 'static,
    F: Fn(&T) -> bool + Send + 'static,
{
    while let Some(message) = outbound.recv().await {
        if write_frame(&mut send, &message).await.is_err() {
            break;
        }
        if is_farewell(&message) {
            say_farewell(&connection, &mut send, farewell).await;
            break;
        }
    }
    connection.close(0u32.into(), b"closed");
}

#[tauri::command]
pub async fn room_host(
    service: State<'_, RoomService>,
    name: String,
    on_event: Channel<RoomEvent>,
) -> Result<RoomHostResult, String> {
    let generation = service.replace().await;
    let session = tokio::select! {
        session = HostSession::start(&name, event_sink(on_event)) => session?,
        _ = service.superseded(generation) => return Err(SUPERSEDED.into()),
    };
    let invite = session.invite();
    service.install(generation, Session::Host(session)).await?;
    Ok(RoomHostResult { invite })
}

#[tauri::command]
pub async fn room_join(
    service: State<'_, RoomService>,
    invite: String,
    name: String,
    on_event: Channel<RoomEvent>,
) -> Result<RoomJoinResult, String> {
    let addr = invite::parse_invite(&invite)?;
    if service.is_hosting(addr.id).await {
        return Err("This is the invite code of your own room.".into());
    }
    let generation = service.replace().await;
    let (session, joined) = tokio::select! {
        joined = GuestSession::join(addr, &name, event_sink(on_event)) => joined?,
        _ = service.superseded(generation) => return Err(SUPERSEDED.into()),
    };
    service.install(generation, Session::Guest(session)).await?;
    Ok(RoomJoinResult {
        self_id: joined.self_id,
        host_name: joined.host_name,
    })
}

#[tauri::command]
pub async fn room_send(
    service: State<'_, RoomService>,
    message: RoomOutbound,
) -> Result<(), String> {
    match &*service.session.lock().await {
        Some(Session::Host(host)) => host.send(message),
        Some(Session::Guest(guest)) => guest.send(message),
        None => Err(NOT_IN_A_ROOM.into()),
    }
}

#[tauri::command]
pub async fn room_remove(service: State<'_, RoomService>, id: u32) -> Result<(), String> {
    match &*service.session.lock().await {
        Some(Session::Host(host)) => host.remove(id),
        Some(Session::Guest(_)) => Err(HOST_ONLY.into()),
        None => Err(NOT_IN_A_ROOM.into()),
    }
}

#[tauri::command]
pub async fn room_lock(service: State<'_, RoomService>, locked: bool) -> Result<(), String> {
    match &*service.session.lock().await {
        Some(Session::Host(host)) => {
            host.set_locked(locked);
            Ok(())
        }
        Some(Session::Guest(_)) => Err(HOST_ONLY.into()),
        None => Err(NOT_IN_A_ROOM.into()),
    }
}

#[tauri::command]
pub async fn room_leave(service: State<'_, RoomService>) -> Result<(), String> {
    service.replace().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use iroh::EndpointAddr;
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

    use super::{
        protocol::{
            tests::{participant, state},
            CloseReason, GuestStatus, LinkStatus, ParticipantPhase, PeerLeftReason, Timing, ALPN,
        },
        *,
    };

    const PATIENCE: Duration = Duration::from_secs(10);

    struct Events(UnboundedReceiver<RoomEvent>);

    impl Events {
        fn sink() -> (EventSink, Self) {
            let (sender, receiver) = unbounded_channel();
            let sink: EventSink = Arc::new(move |event| sender.send(event).is_ok());
            (sink, Self(receiver))
        }

        async fn next(&mut self) -> RoomEvent {
            loop {
                let event = tokio::time::timeout(PATIENCE, self.0.recv())
                    .await
                    .expect("an event within the patience window")
                    .expect("an open event stream");
                if !matches!(event, RoomEvent::Route { .. }) {
                    return event;
                }
            }
        }

        async fn expect(&mut self, expected: RoomEvent) {
            assert_eq!(self.next().await, expected);
        }
    }

    fn timing() -> Timing {
        Timing {
            hello: Duration::from_millis(300),
            reconnect: Duration::from_secs(3),
            farewell: Duration::from_millis(500),
            ..Timing::default()
        }
    }

    async fn loopback_endpoint(alpns: Vec<Vec<u8>>) -> Endpoint {
        Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .alpns(alpns)
            .clear_ip_transports()
            .bind_addr("127.0.0.1:0")
            .expect("loopback address")
            .bind()
            .await
            .expect("bind loopback endpoint")
    }

    struct Room {
        host: HostSession,
        events: Events,
        addr: EndpointAddr,
    }

    async fn host_room() -> Room {
        let endpoint = loopback_endpoint(vec![ALPN.to_vec()]).await;
        let addr = EndpointAddr::new(endpoint.id()).with_ip_addr(endpoint.bound_sockets()[0]);
        let (sink, events) = Events::sink();
        let host = HostSession::serve(
            endpoint,
            "test-invite".into(),
            " The  Host ",
            sink,
            timing(),
        );
        Room { host, events, addr }
    }

    struct Guest {
        session: GuestSession,
        joined: guest::Joined,
        events: Events,
        endpoint: Endpoint,
    }

    async fn join_room(room: &Room, name: &str) -> Result<Guest, String> {
        let endpoint = loopback_endpoint(Vec::new()).await;
        let (sink, events) = Events::sink();
        let (session, joined) =
            GuestSession::connect(endpoint.clone(), room.addr.clone(), name, sink, timing())
                .await?;
        Ok(Guest {
            session,
            joined,
            events,
            endpoint,
        })
    }

    async fn expect_welcome(guest: &mut Guest) {
        guest
            .events
            .expect(RoomEvent::Link {
                status: LinkStatus::Connected,
            })
            .await;
        assert!(matches!(guest.events.next().await, RoomEvent::State { .. }));
        assert!(matches!(
            guest.events.next().await,
            RoomEvent::Roster { .. }
        ));
    }

    fn ready() -> GuestStatus {
        GuestStatus {
            epoch: 2,
            phase: ParticipantPhase::Ready,
            progress: None,
        }
    }

    #[tokio::test]
    async fn guest_is_welcomed_with_the_cached_state_and_roster() {
        let mut room = host_room().await;
        let roster = vec![participant(0, "The Host")];
        room.host
            .send(RoomOutbound::State { state: state() })
            .unwrap();
        room.host
            .send(RoomOutbound::Roster {
                participants: roster.clone(),
            })
            .unwrap();

        let mut guest = join_room(&room, "Alice\u{0007}").await.unwrap();

        assert_eq!(guest.joined.self_id, 1);
        assert_eq!(guest.joined.host_name, "The Host");
        room.events
            .expect(RoomEvent::PeerJoined {
                id: 1,
                name: "Alice".into(),
            })
            .await;
        guest
            .events
            .expect(RoomEvent::Link {
                status: LinkStatus::Connected,
            })
            .await;
        guest
            .events
            .expect(RoomEvent::State { state: state() })
            .await;
        guest
            .events
            .expect(RoomEvent::Roster {
                participants: roster,
            })
            .await;
        room.host.close().await;
    }

    #[tokio::test]
    async fn messages_travel_both_ways_and_roles_are_enforced() {
        let mut room = host_room().await;
        let mut guest = join_room(&room, "Alice").await.unwrap();
        room.events.next().await;
        expect_welcome(&mut guest).await;

        guest
            .session
            .send(RoomOutbound::Status { status: ready() })
            .unwrap();
        guest
            .session
            .send(RoomOutbound::Ping {
                ping_id: 4,
                sent_at: 100.0,
            })
            .unwrap();
        room.events
            .expect(RoomEvent::PeerStatus {
                id: 1,
                status: ready(),
            })
            .await;
        room.events
            .expect(RoomEvent::PeerPing {
                id: 1,
                ping_id: 4,
                sent_at: 100.0,
            })
            .await;

        room.host
            .send(RoomOutbound::Pong {
                id: 1,
                ping_id: 4,
                sent_at: 100.0,
                host_time: 150.0,
            })
            .unwrap();
        room.host
            .send(RoomOutbound::State { state: state() })
            .unwrap();
        guest
            .events
            .expect(RoomEvent::Pong {
                ping_id: 4,
                sent_at: 100.0,
                host_time: 150.0,
            })
            .await;
        guest
            .events
            .expect(RoomEvent::State { state: state() })
            .await;

        assert!(guest
            .session
            .send(RoomOutbound::State { state: state() })
            .is_err());
        assert!(room
            .host
            .send(RoomOutbound::Status { status: ready() })
            .is_err());
        let mut broken = state();
        broken.speed = 9.0;
        assert!(room
            .host
            .send(RoomOutbound::State { state: broken })
            .is_err());

        guest.session.close().await;
        room.events
            .expect(RoomEvent::PeerLeft {
                id: 1,
                reason: PeerLeftReason::Left,
            })
            .await;
        room.host.close().await;
    }

    #[tokio::test]
    async fn removed_guest_stays_out_while_the_room_is_locked() {
        let mut room = host_room().await;
        let mut guest = join_room(&room, "Alice").await.unwrap();
        room.events.next().await;
        expect_welcome(&mut guest).await;

        room.host.set_locked(true);
        room.host.remove(1).unwrap();

        room.events
            .expect(RoomEvent::PeerLeft {
                id: 1,
                reason: PeerLeftReason::Removed,
            })
            .await;
        guest
            .events
            .expect(RoomEvent::Closed {
                reason: CloseReason::Removed,
            })
            .await;
        assert!(room.host.remove(1).is_err());
        let refused = join_room(&room, "Alice").await.err().unwrap();
        assert_eq!(refused, "The host locked the room.");

        room.host.set_locked(false);
        let returned = join_room(&room, "Alice").await.unwrap();
        assert_eq!(returned.joined.self_id, 2);
        room.host.close().await;
    }

    #[tokio::test]
    async fn eighth_guest_is_refused() {
        let room = host_room().await;
        let mut guests = Vec::new();
        for index in 0..7 {
            guests.push(join_room(&room, &format!("Guest {index}")).await.unwrap());
        }

        let refused = join_room(&room, "Late").await.err().unwrap();

        assert_eq!(refused, "The room is full.");
        room.host.close().await;
    }

    #[tokio::test]
    async fn silent_connection_is_dropped_after_the_hello_timeout() {
        let room = host_room().await;
        let endpoint = loopback_endpoint(Vec::new()).await;
        let connection = endpoint.connect(room.addr.clone(), ALPN).await.unwrap();
        let (_send, _recv) = connection.open_bi().await.unwrap();

        let closed = tokio::time::timeout(PATIENCE, connection.closed()).await;

        assert!(closed.is_ok());
        endpoint.close().await;
        room.host.close().await;
    }

    #[tokio::test]
    async fn guest_reconnects_with_the_same_id() {
        let mut room = host_room().await;
        let mut guest = join_room(&room, "Alice").await.unwrap();
        room.events.next().await;
        expect_welcome(&mut guest).await;

        room.host.drop_connection(1);

        guest
            .events
            .expect(RoomEvent::Link {
                status: LinkStatus::Reconnecting,
            })
            .await;
        expect_welcome(&mut guest).await;
        loop {
            let joined_again = RoomEvent::PeerJoined {
                id: 1,
                name: "Alice".into(),
            };
            if room.events.next().await == joined_again {
                break;
            }
        }
        guest
            .session
            .send(RoomOutbound::Status { status: ready() })
            .unwrap();
        room.events
            .expect(RoomEvent::PeerStatus {
                id: 1,
                status: ready(),
            })
            .await;
        room.host.close().await;
    }

    #[tokio::test]
    async fn ending_the_room_tells_the_guests() {
        let mut room = host_room().await;
        let mut guest = join_room(&room, "Alice").await.unwrap();
        room.events.next().await;
        expect_welcome(&mut guest).await;

        room.host.close().await;

        guest
            .events
            .expect(RoomEvent::Closed {
                reason: CloseReason::Ended,
            })
            .await;
        guest.session.close().await;
    }

    #[tokio::test]
    async fn lost_event_channel_ends_the_room() {
        let mut room = host_room().await;
        let mut guest = join_room(&room, "Alice").await.unwrap();
        room.events.next().await;
        expect_welcome(&mut guest).await;

        room.events.0.close();
        guest
            .session
            .send(RoomOutbound::Status { status: ready() })
            .unwrap();

        guest
            .events
            .expect(RoomEvent::Closed {
                reason: CloseReason::Ended,
            })
            .await;
        guest.session.close().await;
    }

    #[tokio::test]
    async fn vanished_host_ends_the_guest_room_as_host_lost() {
        let mut room = host_room().await;
        let mut guest = join_room(&room, "Alice").await.unwrap();
        room.events.next().await;
        expect_welcome(&mut guest).await;

        room.host.vanish().await;

        guest
            .events
            .expect(RoomEvent::Link {
                status: LinkStatus::Reconnecting,
            })
            .await;
        guest
            .events
            .expect(RoomEvent::Closed {
                reason: CloseReason::HostLost,
            })
            .await;
        guest.endpoint.close().await;
    }

    #[tokio::test]
    async fn newer_room_request_supersedes_an_older_one() {
        let service = RoomService::new();
        let first = service.replace().await;
        let second = service.replace().await;

        tokio::time::timeout(PATIENCE, service.superseded(first))
            .await
            .expect("the first request is superseded");
        let pending = tokio::time::timeout(Duration::from_millis(50), service.superseded(second));
        assert!(pending.await.is_err());
    }
}
