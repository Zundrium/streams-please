use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use iroh::{
    endpoint::{Connection, RecvStream, SendStream},
    Endpoint, EndpointAddr,
};
use tokio::{sync::mpsc, task::JoinHandle};

use super::{
    bind_endpoint,
    protocol::{
        clean_name, read_frame, write_frame, CloseReason, EventSink, GuestMessage, HostMessage,
        LinkStatus, Participant, RoomEvent, RoomOutbound, RoomState, Timing, TokenBucket, ALPN,
        HOST_RATE, OUTBOUND_QUEUE_FRAMES,
    },
    selected_route, write_outbound,
};

const RETRY_PAUSE: Duration = Duration::from_millis(500);

pub struct GuestSession {
    endpoint: Endpoint,
    link: Arc<GuestLink>,
    task: JoinHandle<()>,
    farewell: Duration,
}

pub struct Joined {
    pub self_id: u32,
    pub host_name: String,
}

struct GuestLink {
    events: EventSink,
    outbound: Mutex<Option<mpsc::Sender<GuestMessage>>>,
    left: AtomicBool,
}

struct Follower {
    endpoint: Endpoint,
    addr: EndpointAddr,
    name: String,
    timing: Timing,
    link: Arc<GuestLink>,
}

struct Opened {
    connection: Connection,
    send: SendStream,
    recv: RecvStream,
    self_id: u32,
    host_name: String,
    state: RoomState,
    roster: Vec<Participant>,
}

enum OpenError {
    Unreachable,
    Refused(CloseReason),
    Invalid,
}

impl OpenError {
    fn message(self) -> String {
        match self {
            Self::Unreachable => {
                "The host did not answer. Check the invite code and that the room is still open."
            }
            Self::Refused(CloseReason::Full) => "The room is full.",
            Self::Refused(CloseReason::Locked) => "The host locked the room.",
            Self::Refused(_) => "The room has ended.",
            Self::Invalid => {
                "The host sent an unexpected reply. Both sides need the same StreamsPlease version."
            }
        }
        .to_string()
    }
}

impl GuestSession {
    pub async fn join(
        addr: EndpointAddr,
        name: &str,
        events: EventSink,
    ) -> Result<(Self, Joined), String> {
        let endpoint = bind_endpoint(Vec::new()).await?;
        let joined = Self::connect(endpoint.clone(), addr, name, events, Timing::default()).await;
        if joined.is_err() {
            endpoint.close().await;
        }
        joined
    }

    pub async fn connect(
        endpoint: Endpoint,
        addr: EndpointAddr,
        name: &str,
        events: EventSink,
        timing: Timing,
    ) -> Result<(Self, Joined), String> {
        let link = Arc::new(GuestLink {
            events,
            outbound: Mutex::new(None),
            left: AtomicBool::new(false),
        });
        let follower = Follower {
            endpoint: endpoint.clone(),
            addr,
            name: clean_name(name),
            timing,
            link: link.clone(),
        };
        let opened = follower.open().await.map_err(OpenError::message)?;
        let joined = Joined {
            self_id: opened.self_id,
            host_name: opened.host_name.clone(),
        };
        let session = Self {
            endpoint,
            link,
            task: tokio::spawn(follower.run(opened)),
            farewell: timing.farewell,
        };
        Ok((session, joined))
    }

    pub fn send(&self, message: RoomOutbound) -> Result<(), String> {
        message.validate()?;
        let message = match message {
            RoomOutbound::Status { status } => GuestMessage::Status { status },
            RoomOutbound::Ping { ping_id, sent_at } => GuestMessage::Ping { ping_id, sent_at },
            _ => return Err("Only the host can send this room message.".into()),
        };
        self.link.push(message);
        Ok(())
    }

    pub async fn close(self) {
        self.link.left.store(true, Ordering::SeqCst);
        self.link.push(GuestMessage::Bye {});
        let mut task = self.task;
        if tokio::time::timeout(self.farewell * 2, &mut task)
            .await
            .is_err()
        {
            task.abort();
        }
        self.endpoint.close().await;
    }
}

impl GuestLink {
    fn has_left(&self) -> bool {
        self.left.load(Ordering::SeqCst)
    }

    fn emit(&self, event: RoomEvent) -> bool {
        if self.has_left() || (self.events)(event) {
            return true;
        }
        self.left.store(true, Ordering::SeqCst);
        false
    }

    fn set_outbound(&self, outbound: Option<mpsc::Sender<GuestMessage>>) {
        *self
            .outbound
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = outbound;
    }

    fn push(&self, message: GuestMessage) {
        let mut outbound = self
            .outbound
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let overflowed = outbound
            .as_ref()
            .is_some_and(|queue| queue.try_send(message).is_err());
        if overflowed {
            *outbound = None;
        }
    }
}

impl Follower {
    async fn open(&self) -> Result<Opened, OpenError> {
        tokio::time::timeout(self.timing.connect, self.handshake())
            .await
            .unwrap_or(Err(OpenError::Unreachable))
    }

    async fn handshake(&self) -> Result<Opened, OpenError> {
        let unreachable = |_| OpenError::Unreachable;
        let connection = self
            .endpoint
            .connect(self.addr.clone(), ALPN)
            .await
            .map_err(|_| OpenError::Unreachable)?;
        let (mut send, mut recv) = connection
            .open_bi()
            .await
            .map_err(|_| OpenError::Unreachable)?;
        let hello = GuestMessage::Hello {
            name: self.name.clone(),
        };
        write_frame(&mut send, &hello).await.map_err(unreachable)?;
        let reply: HostMessage = read_frame(&mut recv).await.map_err(unreachable)?;
        if reply.validate().is_err() {
            return Err(OpenError::Invalid);
        }
        match reply {
            HostMessage::Welcome {
                self_id,
                host_name,
                state,
                roster,
            } => Ok(Opened {
                connection,
                send,
                recv,
                self_id,
                host_name,
                state,
                roster,
            }),
            HostMessage::Closed { reason } => {
                connection.close(0u32.into(), b"refused");
                Err(OpenError::Refused(reason))
            }
            _ => Err(OpenError::Invalid),
        }
    }

    async fn run(self, opened: Opened) {
        if let Some(reason) = self.follow_until_closed(opened).await {
            self.link.emit(RoomEvent::Closed { reason });
        }
        self.link.left.store(true, Ordering::SeqCst);
        self.endpoint.close().await;
    }

    async fn follow_until_closed(&self, mut opened: Opened) -> Option<CloseReason> {
        let self_id = opened.self_id;
        loop {
            let closed = self.follow(opened).await;
            if self.link.has_left() {
                return None;
            }
            if closed.is_some() {
                return closed;
            }
            self.link.emit(RoomEvent::Link {
                status: LinkStatus::Reconnecting,
            });
            opened = match self.reopen().await {
                Ok(reopened) if reopened.self_id == self_id => reopened,
                Ok(_) => return Some(CloseReason::HostLost),
                Err(reason) => return Some(reason),
            };
            if self.link.has_left() {
                return None;
            }
        }
    }

    async fn reopen(&self) -> Result<Opened, CloseReason> {
        let deadline = Instant::now() + self.timing.reconnect;
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or(CloseReason::HostLost)?;
            match tokio::time::timeout(remaining, self.open()).await {
                Ok(Ok(opened)) => return Ok(opened),
                Ok(Err(OpenError::Refused(reason))) => return Err(reason),
                Ok(Err(OpenError::Invalid)) | Err(_) => return Err(CloseReason::HostLost),
                Ok(Err(OpenError::Unreachable)) => {
                    tokio::time::sleep(RETRY_PAUSE.min(remaining)).await
                }
            }
        }
    }

    async fn follow(&self, opened: Opened) -> Option<CloseReason> {
        let Opened {
            connection,
            send,
            mut recv,
            state,
            roster,
            ..
        } = opened;
        let (outbound, queue) = mpsc::channel(OUTBOUND_QUEUE_FRAMES);
        tokio::spawn(write_outbound(
            connection.clone(),
            send,
            queue,
            |message| matches!(message, GuestMessage::Bye {}),
            self.timing.farewell,
        ));
        self.link.set_outbound(Some(outbound));
        self.link.emit(RoomEvent::Link {
            status: LinkStatus::Connected,
        });
        self.link.emit(RoomEvent::State { state });
        self.link.emit(RoomEvent::Roster {
            participants: roster,
        });

        let mut bucket = TokenBucket::new(HOST_RATE, Instant::now());
        let mut known_route = None;
        let closed = loop {
            let frame = tokio::time::timeout(self.timing.silence, read_frame(&mut recv)).await;
            let Ok(Ok(message)) = frame else {
                break None;
            };
            let message: HostMessage = message;
            if !bucket.allow(Instant::now()) || message.validate().is_err() {
                break Some(CloseReason::Failed);
            }
            let event = match message {
                HostMessage::Welcome { .. } => break Some(CloseReason::Failed),
                HostMessage::Closed { reason } => break Some(reason),
                HostMessage::State { state } => RoomEvent::State { state },
                HostMessage::Roster { participants } => RoomEvent::Roster { participants },
                HostMessage::Pong {
                    ping_id,
                    sent_at,
                    host_time,
                } => RoomEvent::Pong {
                    ping_id,
                    sent_at,
                    host_time,
                },
            };
            if let Some(route) = selected_route(&connection) {
                if known_route != Some(route) {
                    known_route = Some(route);
                    self.link.emit(RoomEvent::Route { id: 0, route });
                }
            }
            if !self.link.emit(event) {
                break None;
            }
        };
        self.link.set_outbound(None);
        connection.close(0u32.into(), b"closed");
        closed
    }
}
