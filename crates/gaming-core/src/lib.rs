//! Player slots for local multiplayer.
//!
//! A slot belongs to one authenticated, paired device ID (from the remote
//! server, never chosen by the client). A device can only drive its own
//! slot. On disconnect the slot is held for a grace period so a phone that
//! drops off Wi-Fi gets the same player back; its input is released at once.

use serde::Serialize;
use std::time::{Duration, Instant};

pub const MAX_PLAYERS: usize = 4;
pub const RECONNECT_GRACE: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SlotStatus {
    Empty,
    Connected,
    /// Disconnected, reserved for the same device until the grace period ends.
    Reserved,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotView {
    pub player: usize,
    pub status: SlotStatus,
    pub device_name: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum SlotError {
    #[error("all {MAX_PLAYERS} player slots are taken")]
    Full,
    #[error("this device has not joined the game")]
    NotJoined,
}

/// What the caller must do to the virtual pads after a change.
#[derive(Debug, PartialEq, Eq)]
pub enum PadEffect {
    /// Show the pad in the emulator (and release its input).
    Connect(usize),
    /// Release all input on the pad but keep it present.
    Release(usize),
    /// Remove the pad from the emulator.
    Disconnect(usize),
}

#[derive(Debug, Clone)]
struct Slot {
    device_id: String,
    device_name: String,
    connected: bool,
    since: Instant,
}

#[derive(Debug, Default)]
pub struct Slots {
    slots: [Option<Slot>; MAX_PLAYERS],
}

impl Slots {
    pub fn new() -> Self {
        Self::default()
    }

    /// Join, or rejoin the slot this device already holds.
    pub fn join(&mut self, device_id: &str, device_name: &str, now: Instant) -> Result<(usize, Vec<PadEffect>), SlotError> {
        let mut effects = self.expire(now);
        if let Some(i) = self.find(device_id) {
            let s = self.slots[i].as_mut().unwrap();
            if !s.connected {
                s.connected = true;
                s.since = now;
                effects.push(PadEffect::Connect(i));
            }
            return Ok((i, effects));
        }
        let i = self.slots.iter().position(Option::is_none).ok_or(SlotError::Full)?;
        self.slots[i] = Some(Slot { device_id: device_id.into(), device_name: device_name.into(), connected: true, since: now });
        effects.push(PadEffect::Connect(i));
        Ok((i, effects))
    }

    /// The slot a device may drive. Input from any other device is refused.
    pub fn slot_for(&self, device_id: &str) -> Result<usize, SlotError> {
        match self.find(device_id) {
            Some(i) if self.slots[i].as_ref().unwrap().connected => Ok(i),
            _ => Err(SlotError::NotJoined),
        }
    }

    /// Connection dropped: release input now, keep the slot reserved.
    pub fn disconnected(&mut self, device_id: &str, now: Instant) -> Vec<PadEffect> {
        let mut effects = self.expire(now);
        if let Some(i) = self.find(device_id) {
            let s = self.slots[i].as_mut().unwrap();
            if s.connected {
                s.connected = false;
                s.since = now;
                effects.push(PadEffect::Release(i));
            }
        }
        effects
    }

    /// The player chose to leave, or the device was revoked: free the slot.
    pub fn leave(&mut self, device_id: &str) -> Vec<PadEffect> {
        match self.find(device_id) {
            Some(i) => {
                self.slots[i] = None;
                vec![PadEffect::Disconnect(i)]
            }
            None => vec![],
        }
    }

    /// Host action from the TV: remove a player.
    pub fn remove_player(&mut self, player: usize) -> Vec<PadEffect> {
        if player < MAX_PLAYERS && self.slots[player].take().is_some() {
            vec![PadEffect::Disconnect(player)]
        } else {
            vec![]
        }
    }

    /// Free reservations whose grace period ended. Call periodically.
    pub fn expire(&mut self, now: Instant) -> Vec<PadEffect> {
        let mut effects = vec![];
        for (i, slot) in self.slots.iter_mut().enumerate() {
            if slot.as_ref().is_some_and(|s| !s.connected && now.duration_since(s.since) >= RECONNECT_GRACE) {
                *slot = None;
                effects.push(PadEffect::Disconnect(i));
            }
        }
        effects
    }

    pub fn view(&self) -> Vec<SlotView> {
        self.slots
            .iter()
            .enumerate()
            .map(|(player, s)| SlotView {
                player,
                status: match s {
                    None => SlotStatus::Empty,
                    Some(s) if s.connected => SlotStatus::Connected,
                    Some(_) => SlotStatus::Reserved,
                },
                device_name: s.as_ref().map(|s| s.device_name.clone()),
            })
            .collect()
    }

    fn find(&self, device_id: &str) -> Option<usize> {
        self.slots.iter().position(|s| s.as_ref().is_some_and(|s| s.device_id == device_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn players_get_distinct_slots_in_join_order() {
        let mut s = Slots::new();
        let t = Instant::now();
        for (n, id) in ["a", "b", "c", "d"].into_iter().enumerate() {
            assert_eq!(s.join(id, id, t).unwrap(), (n, vec![PadEffect::Connect(n)]));
        }
        assert_eq!(s.join("e", "e", t), Err(SlotError::Full));
    }

    #[test]
    fn a_device_only_drives_its_own_slot() {
        let mut s = Slots::new();
        let t = Instant::now();
        s.join("a", "A", t).unwrap();
        s.join("b", "B", t).unwrap();
        assert_eq!(s.slot_for("a"), Ok(0));
        assert_eq!(s.slot_for("b"), Ok(1));
        assert_eq!(s.slot_for("stranger"), Err(SlotError::NotJoined));
    }

    #[test]
    fn joining_twice_keeps_the_same_slot() {
        let mut s = Slots::new();
        let t = Instant::now();
        s.join("a", "A", t).unwrap();
        assert_eq!(s.join("a", "A", t).unwrap(), (0, vec![]));
    }

    #[test]
    fn disconnect_releases_input_and_reconnect_gets_the_same_player() {
        let mut s = Slots::new();
        let t = Instant::now();
        s.join("a", "A", t).unwrap();
        s.join("b", "B", t).unwrap();
        assert_eq!(s.disconnected("a", t), vec![PadEffect::Release(0)]);
        assert_eq!(s.slot_for("a"), Err(SlotError::NotJoined)); // no input while away
        // a newcomer can't take the reserved slot
        assert_eq!(s.join("c", "C", t).unwrap().0, 2);
        assert_eq!(s.join("a", "A", t + Duration::from_secs(10)).unwrap(), (0, vec![PadEffect::Connect(0)]));
    }

    #[test]
    fn reservation_expires_after_grace() {
        let mut s = Slots::new();
        let t = Instant::now();
        s.join("a", "A", t).unwrap();
        s.disconnected("a", t);
        assert_eq!(s.expire(t + RECONNECT_GRACE), vec![PadEffect::Disconnect(0)]);
        assert_eq!(s.view()[0].status, SlotStatus::Empty);
    }

    #[test]
    fn leave_and_host_removal_free_the_slot() {
        let mut s = Slots::new();
        let t = Instant::now();
        s.join("a", "A", t).unwrap();
        s.join("b", "B", t).unwrap();
        assert_eq!(s.leave("a"), vec![PadEffect::Disconnect(0)]);
        assert_eq!(s.remove_player(1), vec![PadEffect::Disconnect(1)]);
        assert_eq!(s.remove_player(1), vec![]);
        assert_eq!(s.remove_player(99), vec![]);
        assert!(s.view().iter().all(|v| v.status == SlotStatus::Empty));
    }
}
