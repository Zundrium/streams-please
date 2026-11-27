use iroh::{defaults::prod::default_relay_map, EndpointAddr, PublicKey, RelayUrl};

const INVITE_PREFIX: &str = "sproom1:";
const MAX_INVITE_LENGTH: usize = 256;

pub fn encode_invite(addr: &EndpointAddr) -> Result<String, String> {
    let relay_host = addr
        .relay_urls()
        .find_map(|relay| relay.host_str())
        .ok_or("The room has no relay yet. Check the internet connection and try again.")?;
    Ok(format!(
        "{INVITE_PREFIX}{}@{}",
        addr.id.to_z32(),
        relay_host.trim_end_matches('.')
    ))
}

pub fn parse_invite(invite: &str) -> Result<EndpointAddr, String> {
    let invite = invite.trim();
    if invite.len() > MAX_INVITE_LENGTH {
        return Err("The invite code is too long.".into());
    }
    let rest = invite
        .strip_prefix(INVITE_PREFIX)
        .ok_or("This is not a StreamsPlease invite code.")?;
    let (id, relay_host) = rest
        .split_once('@')
        .ok_or("The invite code is incomplete. Copy it again from the host.")?;
    let id = PublicKey::from_z32(id)
        .map_err(|_| "The invite code is damaged. Copy it again from the host.")?;
    let relay = known_relay(relay_host)
        .ok_or("The invite code names an unknown relay. The host may use another version.")?;
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

#[cfg(test)]
mod tests {
    use iroh::SecretKey;

    use super::*;

    #[test]
    fn invite_round_trips_through_a_default_relay() {
        let id = SecretKey::generate().public();
        let relay = default_relay_map().urls::<Vec<RelayUrl>>()[0].clone();
        let invite = encode_invite(&EndpointAddr::new(id).with_relay_url(relay.clone())).unwrap();

        let parsed = parse_invite(&format!("  {invite}\n")).unwrap();

        assert!(invite.len() < 100, "{invite}");
        assert!(!invite.ends_with('.'), "{invite}");
        assert_eq!(parsed.id, id);
        assert_eq!(parsed.relay_urls().collect::<Vec<_>>(), vec![&relay]);
    }

    #[test]
    fn invite_without_a_relay_cannot_be_encoded() {
        let id = SecretKey::generate().public();
        assert!(encode_invite(&EndpointAddr::new(id)).is_err());
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
}
