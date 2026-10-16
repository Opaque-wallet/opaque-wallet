//! Opaque Privacy Signals is intentionally a reusable, read-only Substreams
//! module. It converts public EVM events into aggregate signals; it never emits
//! a note secret, depositor, recipient, real ring position, selected decoys, or
//! relay route.

use substreams::errors::Error;
use substreams_ethereum::pb::eth::v2::Block;

pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/opaque.privacy.v1.rs"));
}

substreams_ethereum::init!();
substreams_ethereum::use_contract!(private_pool, "abi/private-pool.json");
substreams_ethereum::use_contract!(relay_directory, "abi/relay-directory.json");

const EMPTY: String = String::new();

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn signal(kind: pb::privacy_signal::Kind, source: String) -> pb::PrivacySignal {
    pb::PrivacySignal {
        kind: kind as i32,
        source,
        relay_id: EMPTY,
        operator: EMPTY,
        ring_size: 0,
        reliability_bps: 0,
        batch_occupancy: 0,
        recent_selections: 0,
        observed_at: 0,
    }
}

/// Converts only the four event classes required to compute public privacy
/// readiness. Values that could identify a payment are intentionally omitted.
#[substreams::handlers::map]
pub fn map_privacy_signals(block: Block) -> Result<pb::PrivacySignalBlock, Error> {
    let mut signals = Vec::new();

    for log in block.logs() {
        let raw = log.as_ref();
        let source = hex(log.address());

        if private_pool::events::Deposited::match_log(raw) {
            signals.push(signal(pb::privacy_signal::Kind::PoolDeposit, source));
            continue;
        }

        if relay_directory::events::RelayAnnounced::match_log(raw) {
            let event = relay_directory::events::RelayAnnounced::decode(raw).map_err(Error::msg)?;
            let mut entry = signal(pb::privacy_signal::Kind::RelayAnnounced, source);
            entry.relay_id = hex(&event.node_id);
            entry.operator = hex(&event.operator);
            signals.push(entry);
            continue;
        }

        if relay_directory::events::RelayHealth::match_log(raw) {
            let event = relay_directory::events::RelayHealth::decode(raw).map_err(Error::msg)?;
            let mut entry = signal(pb::privacy_signal::Kind::RelayHealth, source);
            entry.relay_id = hex(&event.node_id);
            entry.reliability_bps = event.reliability_bps.to_u64() as u32;
            entry.batch_occupancy = event.batch_occupancy.to_u64() as u32;
            entry.recent_selections = event.recent_selections.to_u64() as u32;
            entry.observed_at = event.observed_at.to_u64();
            signals.push(entry);
            continue;
        }

        if private_pool::events::RingUsed::match_log(raw) {
            let event = private_pool::events::RingUsed::decode(raw).map_err(Error::msg)?;
            let mut entry = signal(pb::privacy_signal::Kind::RingObserved, source);
            entry.ring_size = event.ring.len() as u32;
            signals.push(entry);
        }
    }

    Ok(pb::PrivacySignalBlock {
        block_number: block.number,
        signals,
    })
}

#[cfg(test)]
mod tests {
    use super::{hex, signal};
    use crate::pb::privacy_signal::Kind;

    #[test]
    fn encodes_addresses_without_ever_exporting_a_secret() {
        assert_eq!(hex(&[0xab, 0xcd]), "0xabcd");
        let output = signal(Kind::RingObserved, "0xpool".to_owned());
        assert_eq!(output.ring_size, 0);
        assert!(output.relay_id.is_empty());
        assert!(output.operator.is_empty());
    }
}
