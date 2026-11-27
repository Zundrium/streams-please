use std::{
    error::Error,
    time::{Duration, Instant},
};

use iroh::{
    defaults::prod::default_relay_map,
    endpoint::{presets, Connection, Incoming},
    Endpoint, EndpointAddr, PublicKey, RelayMode, RelayUrl,
};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

type SpikeResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

const ALPN: &[u8] = b"streamsplease/room/1";
const INVITE_PREFIX: &str = "sproom1:";
const MAX_INVITE_LENGTH: usize = 256;
const MAX_FRAME_BYTES: usize = 16 * 1024;
const ONLINE_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const PING_INTERVAL: Duration = Duration::from_secs(2);
const USAGE: &str =
    "usage: room_spike host [--relay-only]\n       room_spike join <invite> [--relay-only]";

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let relay_only = args.iter().any(|arg| arg == "--relay-only");
    let positional: Vec<&str> = args
        .iter()
        .filter(|arg| !arg.starts_with("--"))
        .map(String::as_str)
        .collect();
    let result = match positional.as_slice() {
        ["host"] => host(relay_only).await,
        ["join", invite] => join(invite, relay_only).await,
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    };
    if let Err(error) = result {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

async fn bind_endpoint(alpns: Vec<Vec<u8>>, relay_only: bool) -> SpikeResult<Endpoint> {
    let mut builder = Endpoint::builder(presets::Minimal)
        .relay_mode(RelayMode::Default)
        .alpns(alpns);
    if relay_only {
        builder = builder.clear_ip_transports();
    }
    Ok(builder.bind().await?)
}

async fn host(relay_only: bool) -> SpikeResult<()> {
    let started = Instant::now();
    let endpoint = bind_endpoint(vec![ALPN.to_vec()], relay_only).await?;
    println!(
        "bound after {} ms on {:?}",
        elapsed_ms(started),
        endpoint.bound_sockets()
    );
    tokio::time::timeout(ONLINE_TIMEOUT, endpoint.online())
        .await
        .map_err(|_| "no relay answered within 10 seconds")?;
    println!("online after {} ms", elapsed_ms(started));
    println!("invite: {}", encode_invite(&endpoint.addr())?);
    while let Some(incoming) = endpoint.accept().await {
        tokio::spawn(async move {
            if let Err(error) = serve_guest(incoming).await {
                println!("guest ended: {error}");
            }
        });
    }
    Ok(())
}

async fn serve_guest(incoming: Incoming) -> SpikeResult<()> {
    let started = Instant::now();
    let connection = incoming.await?;
    let guest = connection.remote_id().fmt_short().to_string();
    println!("{guest}: connected");
    let (mut send, mut recv) = connection.accept_bi().await?;
    let hello = tokio::time::timeout(HELLO_TIMEOUT, read_frame(&mut recv))
        .await
        .map_err(|_| "no hello within 5 seconds")??;
    println!("{guest}: {hello}");
    write_frame(&mut send, &json!({ "type": "welcome", "selfId": 1 })).await?;
    let mut routes = RouteLog::default();
    loop {
        let frame = read_frame(&mut recv).await?;
        routes.report(&connection, &guest, started);
        if frame["type"] == "ping" {
            let pong = json!({ "type": "pong", "pingId": frame["pingId"] });
            write_frame(&mut send, &pong).await?;
        }
    }
}

async fn join(invite: &str, relay_only: bool) -> SpikeResult<()> {
    let addr = parse_invite(invite)?;
    let started = Instant::now();
    let endpoint = bind_endpoint(Vec::new(), relay_only).await?;
    let connection = tokio::time::timeout(CONNECT_TIMEOUT, endpoint.connect(addr, ALPN))
        .await
        .map_err(|_| "the host did not answer within 20 seconds")??;
    println!("connected after {} ms", elapsed_ms(started));
    let (mut send, mut recv) = connection.open_bi().await?;
    write_frame(&mut send, &json!({ "type": "hello", "name": "spike" })).await?;
    let welcome = read_frame(&mut recv).await?;
    println!("welcome after {} ms: {welcome}", elapsed_ms(started));
    let mut routes = RouteLog::default();
    for ping_id in 1u64.. {
        routes.report(&connection, "host", started);
        let sent = Instant::now();
        write_frame(&mut send, &json!({ "type": "ping", "pingId": ping_id })).await?;
        read_frame(&mut recv).await?;
        println!("ping {ping_id}: {} ms", elapsed_ms(sent));
        tokio::time::sleep(PING_INTERVAL).await;
    }
    Ok(())
}

#[derive(Default)]
struct RouteLog {
    last: Option<&'static str>,
}

impl RouteLog {
    fn report(&mut self, connection: &Connection, peer: &str, started: Instant) {
        let route = selected_route(connection);
        if self.last != Some(route) {
            println!("{peer}: route {route} after {} ms", elapsed_ms(started));
            self.last = Some(route);
        }
    }
}

fn selected_route(connection: &Connection) -> &'static str {
    let paths = connection.paths();
    let selected = paths.iter().find(|path| path.is_selected());
    match selected {
        Some(path) if path.is_ip() => "direct",
        Some(path) if path.is_relay() => "relay",
        Some(_) => "other",
        None => "none",
    }
}

fn elapsed_ms(since: Instant) -> u128 {
    since.elapsed().as_millis()
}

fn encode_invite(addr: &EndpointAddr) -> SpikeResult<String> {
    let relay = addr
        .relay_urls()
        .next()
        .ok_or("the endpoint has no home relay")?;
    let relay_host = relay.host_str().ok_or("the home relay has no hostname")?;
    Ok(format!(
        "{INVITE_PREFIX}{}@{}",
        addr.id.to_z32(),
        relay_host.trim_end_matches('.')
    ))
}

fn parse_invite(invite: &str) -> SpikeResult<EndpointAddr> {
    let invite = invite.trim();
    if invite.len() > MAX_INVITE_LENGTH {
        return Err("the invite code is too long".into());
    }
    let rest = invite
        .strip_prefix(INVITE_PREFIX)
        .ok_or("this is not a StreamsPlease invite code")?;
    let (id, relay_host) = rest.split_once('@').ok_or("the invite code has no relay")?;
    let id = PublicKey::from_z32(id).map_err(|_| "the invite code has an invalid room id")?;
    let relay = known_relay(relay_host).ok_or("the invite code names an unknown relay")?;
    Ok(EndpointAddr::new(id).with_relay_url(relay))
}

fn known_relay(relay_host: &str) -> Option<RelayUrl> {
    default_relay_map()
        .urls::<Vec<RelayUrl>>()
        .into_iter()
        .find(|url| {
            url.host_str()
                .is_some_and(|host| host.trim_end_matches('.').eq_ignore_ascii_case(relay_host))
        })
}

async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, value: &Value) -> SpikeResult<()> {
    let body = serde_json::to_vec(value)?;
    if body.len() > MAX_FRAME_BYTES {
        return Err("the frame is too large".into());
    }
    writer.write_all(&(body.len() as u32).to_be_bytes()).await?;
    writer.write_all(&body).await?;
    Ok(())
}

async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> SpikeResult<Value> {
    let length = reader.read_u32().await? as usize;
    if length > MAX_FRAME_BYTES {
        return Err(format!("a frame of {length} bytes exceeds the limit").into());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await?;
    Ok(serde_json::from_slice(&body)?)
}

#[cfg(test)]
mod tests {
    use iroh::SecretKey;

    use super::*;

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

    #[tokio::test]
    async fn loopback_endpoints_exchange_a_frame() {
        let host = loopback_endpoint(vec![ALPN.to_vec()]).await;
        let guest = loopback_endpoint(Vec::new()).await;
        let host_addr = EndpointAddr::new(host.id()).with_ip_addr(host.bound_sockets()[0]);

        let server = tokio::spawn({
            let host = host.clone();
            async move {
                let connection = host
                    .accept()
                    .await
                    .expect("incoming")
                    .await
                    .expect("accept");
                let (mut send, mut recv) = connection.accept_bi().await.expect("stream");
                let hello = read_frame(&mut recv).await.expect("hello");
                write_frame(
                    &mut send,
                    &json!({ "type": "welcome", "echo": hello["name"] }),
                )
                .await
                .expect("welcome");
                connection.closed().await;
            }
        });

        let connection = guest.connect(host_addr, ALPN).await.expect("connect");
        let (mut send, mut recv) = connection.open_bi().await.expect("stream");
        write_frame(&mut send, &json!({ "type": "hello", "name": "Alice" }))
            .await
            .expect("hello");
        let welcome = read_frame(&mut recv).await.expect("welcome");
        assert_eq!(welcome, json!({ "type": "welcome", "echo": "Alice" }));

        connection.close(0u32.into(), b"bye");
        server.await.expect("server task");
        guest.close().await;
        host.close().await;
    }

    #[test]
    fn invite_round_trips_through_a_default_relay() {
        let id = SecretKey::generate().public();
        let relay = default_relay_map().urls::<Vec<RelayUrl>>()[0].clone();
        let invite = encode_invite(&EndpointAddr::new(id).with_relay_url(relay.clone())).unwrap();

        let parsed = parse_invite(&invite).unwrap();

        assert!(invite.len() < 100, "{invite}");
        assert_eq!(parsed.id, id);
        assert_eq!(parsed.relay_urls().collect::<Vec<_>>(), vec![&relay]);
    }

    #[test]
    fn invite_rejects_foreign_or_malformed_codes() {
        let id = SecretKey::generate().public().to_z32();
        for invite in [
            format!("sproom2:{id}@euc1-1.relay.n0.iroh.link"),
            "sproom1:not-a-key@euc1-1.relay.n0.iroh.link".to_string(),
            format!("sproom1:{id}@relay.example.com"),
            format!("sproom1:{id}"),
            format!("sproom1:{id}@{}", "a".repeat(MAX_INVITE_LENGTH)),
        ] {
            assert!(parse_invite(&invite).is_err(), "{invite}");
        }
    }

    #[tokio::test]
    async fn oversized_frame_is_rejected_before_reading_the_body() {
        let header = ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes();
        let error = read_frame(&mut &header[..]).await.unwrap_err();
        assert!(error.to_string().contains("exceeds the limit"));
    }
}
