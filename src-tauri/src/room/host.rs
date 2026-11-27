use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use iroh::{
    endpoint::{Connection, RecvStream, SendStream},
    Endpoint, EndpointAddr, PublicKey, Watcher,
};
use tokio::sync::{mpsc, Semaphore};

use super::{
    bind_endpoint,
    invite::encode_invite,
    protocol::{
        clean_name, read_frame, write_frame, CloseReason, EventSink, GuestMessage, HostMessage,
        Participant, ParticipantPhase, PeerLeftReason, RoomEvent, RoomOutbound, RoomState, Route,
        Timing, TokenBucket, ALPN, GUEST_RATE, MAX_PARTICIPANTS, OUTBOUND_QUEUE_FRAMES,
    },
    say_farewell, selected_route, write_outbound,
};

const MAX_PENDING_HANDSHAKES: usize = 16;

pub struct HostSession {
    room: Arc<HostRoom>,
}

struct HostRoom {
    endpoint: Endpoint,
    host_name: String,
    events: EventSink,
    timing: Timing,
    table: Mutex<PeerTable>,
}

struct PeerTable {
    invite: String,
    ended: bool,
    locked: bool,
    state: RoomState,
    roster: Vec<Participant>,
    peers: HashMap<u32, Peer>,
    lost: HashMap<PublicKey, (u32, Instant)>,
    last_id: u32,
    last_link: u64,
}

struct Peer {
    link: u64,
    endpoint_id: PublicKey,
    connection: Connection,
    outbound: mpsc::Sender<HostMessage>,
}

struct Admission {
    id: u32,
    link: u64,
    outbound: mpsc::Receiver<HostMessage>,
}

impl HostSession {
    pub async fn start(name: &str, events: EventSink) -> Result<Self, String> {
        let timing = Timing::default();
        let endpoint = bind_endpoint(vec![ALPN.to_vec()]).await?;
        let online = tokio::time::timeout(timing.online, endpoint.online()).await;
        let invite = match online {
            Ok(()) => encode_invite(&endpoint.addr()),
            Err(_) => Err(
                "No relay answered within 10 seconds. Check the internet connection and try again."
                    .to_string(),
            ),
        };
        match invite {
            Ok(invite) => {
                let addrs = endpoint.watch_addr();
                let session = Self::serve(endpoint, invite, name, events, timing);
                tokio::spawn(session.room.clone().follow_invite(addrs));
                Ok(session)
            }
            Err(error) => {
                endpoint.close().await;
                Err(error)
            }
        }
    }

    pub fn serve(
        endpoint: Endpoint,
        invite: String,
        name: &str,
        events: EventSink,
        timing: Timing,
    ) -> Self {
        let host_name = clean_name(name);
        let host = Participant {
            id: 0,
            name: host_name.clone(),
            host: true,
            phase: ParticipantPhase::Idle,
            progress: None,
            blocking: false,
        };
        let room = Arc::new(HostRoom {
            endpoint,
            host_name,
            events,
            timing,
            table: Mutex::new(PeerTable::new(invite, host)),
        });
        tokio::spawn(room.clone().accept_guests());
        Self { room }
    }

    pub fn invite(&self) -> String {
        self.room.table().invite.clone()
    }

    pub fn endpoint_id(&self) -> PublicKey {
        self.room.endpoint.id()
    }

    pub fn send(&self, message: RoomOutbound) -> Result<(), String> {
        message.validate()?;
        let mut table = self.room.table();
        match message {
            RoomOutbound::State { state } => {
                table.state = state.clone();
                self.room
                    .broadcast(&mut table, HostMessage::State { state });
            }
            RoomOutbound::Roster { participants } => {
                table.roster = participants.clone();
                self.room
                    .broadcast(&mut table, HostMessage::Roster { participants });
            }
            RoomOutbound::Pong {
                id,
                ping_id,
                sent_at,
                host_time,
            } => {
                let pong = HostMessage::Pong {
                    ping_id,
                    sent_at,
                    host_time,
                };
                self.room.deliver(&mut table, id, pong);
            }
            RoomOutbound::Status { .. } | RoomOutbound::Ping { .. } => {
                return Err("Only a guest can send this room message.".into());
            }
        }
        Ok(())
    }

    pub fn remove(&self, id: u32) -> Result<(), String> {
        let mut table = self.room.table();
        let peer = table
            .peers
            .remove(&id)
            .ok_or("That guest is no longer in the room.")?;
        peer.dismiss(CloseReason::Removed);
        self.room.emit(
            &mut table,
            RoomEvent::PeerLeft {
                id,
                reason: PeerLeftReason::Removed,
            },
        );
        Ok(())
    }

    pub fn set_locked(&self, locked: bool) {
        self.room.table().locked = locked;
    }

    pub async fn close(self) {
        let connections = self.room.table().end();
        finish_room(
            self.room.endpoint.clone(),
            connections,
            self.room.timing.farewell,
        )
        .await;
    }

    #[cfg(test)]
    pub fn drop_connection(&self, id: u32) {
        if let Some(peer) = self.room.table().peers.get(&id) {
            peer.connection.close(0u32.into(), b"test");
        }
    }

    #[cfg(test)]
    pub async fn vanish(self) {
        self.room.endpoint.close().await;
    }
}

impl Peer {
    fn dismiss(self, reason: CloseReason) {
        if self
            .outbound
            .try_send(HostMessage::Closed { reason })
            .is_err()
        {
            self.connection.close(0u32.into(), b"closed");
        }
    }
}

impl PeerTable {
    fn new(invite: String, host: Participant) -> Self {
        Self {
            invite,
            ended: false,
            locked: false,
            state: RoomState::default(),
            roster: vec![host],
            peers: HashMap::new(),
            lost: HashMap::new(),
            last_id: 0,
            last_link: 0,
        }
    }

    fn changed_invite(&mut self, addr: &EndpointAddr) -> Option<String> {
        let invite = encode_invite(addr).ok()?;
        if invite == self.invite {
            return None;
        }
        self.invite = invite.clone();
        Some(invite)
    }

    fn end(&mut self) -> Vec<Connection> {
        self.ended = true;
        self.lost.clear();
        self.peers
            .drain()
            .map(|(_, peer)| {
                let connection = peer.connection.clone();
                peer.dismiss(CloseReason::Ended);
                connection
            })
            .collect()
    }

    fn is_current(&self, id: u32, link: u64) -> bool {
        self.peers.get(&id).is_some_and(|peer| peer.link == link)
    }
}

async fn finish_room(endpoint: Endpoint, connections: Vec<Connection>, farewell: Duration) {
    let _ = tokio::time::timeout(farewell, async {
        for connection in &connections {
            connection.closed().await;
        }
    })
    .await;
    endpoint.close().await;
}

async fn receive_hello(
    connection: &Connection,
) -> Result<(SendStream, RecvStream, String), String> {
    let (send, mut recv) = connection
        .accept_bi()
        .await
        .map_err(|error| error.to_string())?;
    match read_frame(&mut recv).await? {
        GuestMessage::Hello { name } => Ok((send, recv, clean_name(&name))),
        _ => Err("The first room message must be hello.".into()),
    }
}

impl HostRoom {
    fn table(&self) -> MutexGuard<'_, PeerTable> {
        self.table
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn emit(&self, table: &mut PeerTable, event: RoomEvent) {
        if table.ended || (self.events)(event) {
            return;
        }
        let connections = table.end();
        tokio::spawn(finish_room(
            self.endpoint.clone(),
            connections,
            self.timing.farewell,
        ));
    }

    fn drop_peer(&self, table: &mut PeerTable, id: u32, reason: PeerLeftReason) {
        let Some(peer) = table.peers.remove(&id) else {
            return;
        };
        peer.connection.close(0u32.into(), b"dropped");
        if reason == PeerLeftReason::Lost {
            table.lost.insert(peer.endpoint_id, (id, Instant::now()));
        }
        self.emit(table, RoomEvent::PeerLeft { id, reason });
    }

    fn deliver(&self, table: &mut PeerTable, id: u32, message: HostMessage) {
        let overflowed = table
            .peers
            .get(&id)
            .is_some_and(|peer| peer.outbound.try_send(message).is_err());
        if overflowed {
            self.drop_peer(table, id, PeerLeftReason::Lost);
        }
    }

    fn broadcast(&self, table: &mut PeerTable, message: HostMessage) {
        let ids: Vec<u32> = table.peers.keys().copied().collect();
        for id in ids {
            self.deliver(table, id, message.clone());
        }
    }

    fn announce_invite(&self, addr: &EndpointAddr) -> bool {
        let mut table = self.table();
        if table.ended {
            return false;
        }
        if let Some(invite) = table.changed_invite(addr) {
            self.emit(&mut table, RoomEvent::InviteChanged { invite });
        }
        true
    }

    async fn follow_invite(self: Arc<Self>, mut addrs: impl Watcher<Value = EndpointAddr>) {
        let mut addr = addrs.get();
        while self.announce_invite(&addr) {
            addr = tokio::select! {
                _ = self.endpoint.closed() => return,
                updated = addrs.updated() => match updated {
                    Ok(addr) => addr,
                    Err(_) => return,
                },
            };
        }
    }

    async fn accept_guests(self: Arc<Self>) {
        let handshakes = Arc::new(Semaphore::new(MAX_PENDING_HANDSHAKES));
        while let Some(incoming) = self.endpoint.accept().await {
            let Ok(permit) = handshakes.clone().try_acquire_owned() else {
                incoming.refuse();
                continue;
            };
            let room = self.clone();
            tokio::spawn(async move {
                let Ok(connection) = incoming.await else {
                    return;
                };
                let hello =
                    tokio::time::timeout(room.timing.hello, receive_hello(&connection)).await;
                drop(permit);
                match hello {
                    Ok(Ok((send, recv, name))) => {
                        room.serve_guest(connection, send, recv, name).await
                    }
                    _ => connection.close(0u32.into(), b"hello"),
                }
            });
        }
    }

    async fn serve_guest(
        &self,
        connection: Connection,
        mut send: SendStream,
        recv: RecvStream,
        name: String,
    ) {
        match self.admit(&connection, name) {
            Ok(admission) => {
                tokio::spawn(write_outbound(
                    connection.clone(),
                    send,
                    admission.outbound,
                    |message| matches!(message, HostMessage::Closed { .. }),
                    self.timing.farewell,
                ));
                self.read_guest(connection, recv, admission.id, admission.link)
                    .await;
            }
            Err(reason) => {
                if write_frame(&mut send, &HostMessage::Closed { reason })
                    .await
                    .is_ok()
                {
                    say_farewell(&connection, &mut send, self.timing.farewell).await;
                }
                connection.close(0u32.into(), b"refused");
            }
        }
    }

    fn admit(&self, connection: &Connection, name: String) -> Result<Admission, CloseReason> {
        let mut table = self.table();
        if table.ended {
            return Err(CloseReason::Ended);
        }
        let endpoint_id = connection.remote_id();
        let now = Instant::now();
        let memory = self.timing.reconnect * 2;
        table
            .lost
            .retain(|_, (_, lost_at)| now.saturating_duration_since(*lost_at) < memory);
        let connected = table
            .peers
            .iter()
            .find(|(_, peer)| peer.endpoint_id == endpoint_id)
            .map(|(id, _)| *id);
        let id = match connected {
            Some(id) => id,
            None => {
                let remembered = table.lost.remove(&endpoint_id).map(|(id, _)| id);
                if remembered.is_none() && table.locked {
                    return Err(CloseReason::Locked);
                }
                if table.peers.len() + 1 >= MAX_PARTICIPANTS {
                    return Err(CloseReason::Full);
                }
                remembered.unwrap_or_else(|| {
                    table.last_id += 1;
                    table.last_id
                })
            }
        };
        table.last_link += 1;
        let link = table.last_link;
        let (outbound, queue) = mpsc::channel(OUTBOUND_QUEUE_FRAMES);
        let _ = outbound.try_send(HostMessage::Welcome {
            self_id: id,
            host_name: self.host_name.clone(),
            state: table.state.clone(),
            roster: table.roster.clone(),
        });
        let peer = Peer {
            link,
            endpoint_id,
            connection: connection.clone(),
            outbound,
        };
        if let Some(previous) = table.peers.insert(id, peer) {
            previous.connection.close(0u32.into(), b"replaced");
        }
        self.emit(&mut table, RoomEvent::PeerJoined { id, name });
        Ok(Admission {
            id,
            link,
            outbound: queue,
        })
    }

    async fn read_guest(&self, connection: Connection, mut recv: RecvStream, id: u32, link: u64) {
        let mut bucket = TokenBucket::new(GUEST_RATE, Instant::now());
        let mut route = None;
        let reason = loop {
            let frame = tokio::time::timeout(self.timing.silence, read_frame(&mut recv)).await;
            let Ok(Ok(message)) = frame else {
                break PeerLeftReason::Lost;
            };
            let message: GuestMessage = message;
            if !bucket.allow(Instant::now()) || message.validate().is_err() {
                break PeerLeftReason::Lost;
            }
            let event = match message {
                GuestMessage::Hello { .. } => break PeerLeftReason::Lost,
                GuestMessage::Bye {} => break PeerLeftReason::Left,
                GuestMessage::Status { status } => RoomEvent::PeerStatus { id, status },
                GuestMessage::Ping { ping_id, sent_at } => RoomEvent::PeerPing {
                    id,
                    ping_id,
                    sent_at,
                },
            };
            if !self.forward(id, link, event, &connection, &mut route) {
                return;
            }
        };
        let mut table = self.table();
        if table.is_current(id, link) {
            self.drop_peer(&mut table, id, reason);
        }
    }

    fn forward(
        &self,
        id: u32,
        link: u64,
        event: RoomEvent,
        connection: &Connection,
        known_route: &mut Option<Route>,
    ) -> bool {
        let mut table = self.table();
        if !table.is_current(id, link) {
            return false;
        }
        if let Some(route) = selected_route(connection) {
            if *known_route != Some(route) {
                *known_route = Some(route);
                self.emit(&mut table, RoomEvent::Route { id, route });
            }
        }
        self.emit(&mut table, event);
        true
    }
}

#[cfg(test)]
mod tests {
    use iroh::{defaults::prod::default_relay_map, RelayUrl, SecretKey};

    use super::{super::protocol::tests::participant, *};

    #[test]
    fn invite_changes_only_when_the_relay_does() {
        let id = SecretKey::generate().public();
        let relays = default_relay_map().urls::<Vec<RelayUrl>>();
        let first = EndpointAddr::new(id).with_relay_url(relays[0].clone());
        let second = EndpointAddr::new(id).with_relay_url(relays[1].clone());
        let mut table = PeerTable::new(encode_invite(&first).unwrap(), participant(0, "Host"));

        assert_eq!(table.changed_invite(&first), None);
        assert_eq!(table.changed_invite(&EndpointAddr::new(id)), None);
        let invite = table.changed_invite(&second).expect("a new invite");
        assert_eq!(invite, encode_invite(&second).unwrap());
        assert_eq!(table.invite, invite);
        assert_eq!(table.changed_invite(&second), None);
    }
}
