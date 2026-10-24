//! Remote pairing (spec §12).
//!
//! Flow:
//!  1. Phone calls `request()` → gets a `request_id`; the desktop shows a
//!     6-digit code + device name and asks the user to approve.
//!  2. User approves on the desktop (`approve()`); the phone must then submit
//!     the code shown on the TV (`complete()`), proving it can see the screen.
//!  3. Phone receives a 256-bit bearer token. Only its SHA-256 is stored.
//!
//! Codes expire after 2 minutes and allow 5 attempts. Tokens expire after 30
//! days and can be revoked individually.

use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub const CODE_TTL_MS: u64 = 120_000;
pub const TOKEN_TTL_MS: u64 = 30 * 24 * 3600 * 1000;
pub const MAX_ATTEMPTS: u8 = 5;
pub const MAX_PENDING: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingPairing {
    pub request_id: String,
    pub device_name: String,
    pub code: String,
    pub created_ms: u64,
    pub approved: bool,
    #[serde(skip)]
    attempts: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub paired_ms: u64,
    pub expires_ms: u64,
    pub last_seen_ms: u64,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum PairingError {
    #[error("pairing request not found or expired")]
    NotFound,
    #[error("waiting for approval on the TV")]
    NotApproved,
    #[error("wrong code")]
    WrongCode,
    #[error("too many attempts; start pairing again")]
    TooManyAttempts,
    #[error("too many pending pairing requests")]
    Busy,
    #[error("invalid device name")]
    InvalidName,
}

pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Constant-time comparison for hex digests.
fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, Default)]
pub struct PairingManager {
    pending: HashMap<String, PendingPairing>,
    devices: HashMap<String, PairedDevice>,
}

impl PairingManager {
    pub fn with_devices(devices: Vec<PairedDevice>) -> Self {
        Self { pending: HashMap::new(), devices: devices.into_iter().map(|d| (d.id.clone(), d)).collect() }
    }

    fn sweep(&mut self, now: u64) {
        self.pending.retain(|_, p| now.saturating_sub(p.created_ms) < CODE_TTL_MS);
        self.devices.retain(|_, d| d.expires_ms > now);
    }

    pub fn request(&mut self, device_name: &str, now: u64) -> Result<PendingPairing, PairingError> {
        self.sweep(now);
        let name: String = device_name.chars().filter(|c| !c.is_control()).take(40).collect();
        if name.trim().is_empty() {
            return Err(PairingError::InvalidName);
        }
        if self.pending.len() >= MAX_PENDING {
            return Err(PairingError::Busy);
        }
        let mut rng = rand::thread_rng();
        let p = PendingPairing {
            request_id: (&mut rng).sample_iter(&Alphanumeric).take(24).map(char::from).collect(),
            device_name: name.trim().to_string(),
            code: format!("{:06}", rng.gen_range(0..1_000_000)),
            created_ms: now,
            approved: false,
            attempts: 0,
        };
        self.pending.insert(p.request_id.clone(), p.clone());
        Ok(p)
    }

    pub fn pending(&mut self, now: u64) -> Vec<PendingPairing> {
        self.sweep(now);
        self.pending.values().cloned().collect()
    }

    pub fn approve(&mut self, request_id: &str, now: u64) -> Result<(), PairingError> {
        self.sweep(now);
        self.pending.get_mut(request_id).map(|p| p.approved = true).ok_or(PairingError::NotFound)
    }

    pub fn deny(&mut self, request_id: &str) {
        self.pending.remove(request_id);
    }

    /// Returns (device, plaintext token). The plaintext is never stored.
    pub fn complete(&mut self, request_id: &str, code: &str, now: u64) -> Result<(PairedDevice, String), PairingError> {
        self.sweep(now);
        let p = self.pending.get_mut(request_id).ok_or(PairingError::NotFound)?;
        if !p.approved {
            return Err(PairingError::NotApproved);
        }
        p.attempts += 1;
        if p.attempts > MAX_ATTEMPTS {
            self.pending.remove(request_id);
            return Err(PairingError::TooManyAttempts);
        }
        if !ct_eq(&p.code, code.trim()) {
            return Err(PairingError::WrongCode);
        }
        let p = self.pending.remove(request_id).expect("present");
        let token: String = rand::thread_rng().sample_iter(&Alphanumeric).take(48).map(char::from).collect();
        let device = PairedDevice {
            id: p.request_id,
            name: p.device_name,
            token_hash: hash_token(&token),
            paired_ms: now,
            expires_ms: now + TOKEN_TTL_MS,
            last_seen_ms: now,
        };
        self.devices.insert(device.id.clone(), device.clone());
        Ok((device, token))
    }

    pub fn authenticate(&mut self, token: &str, now: u64) -> Option<PairedDevice> {
        self.sweep(now);
        let h = hash_token(token);
        let d = self.devices.values_mut().find(|d| ct_eq(&d.token_hash, &h))?;
        d.last_seen_ms = now;
        Some(d.clone())
    }

    pub fn revoke(&mut self, device_id: &str) -> bool {
        self.devices.remove(device_id).is_some()
    }

    pub fn devices(&self) -> Vec<PairedDevice> {
        self.devices.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_pairing_flow() {
        let mut m = PairingManager::default();
        let p = m.request("Priyanshu's iPhone", 0).unwrap();
        assert_eq!(p.code.len(), 6);
        assert_eq!(m.complete(&p.request_id, &p.code, 1), Err(PairingError::NotApproved));
        m.approve(&p.request_id, 2).unwrap();
        assert_eq!(m.complete(&p.request_id, "000000x", 3), Err(PairingError::WrongCode));
        let (dev, token) = m.complete(&p.request_id, &p.code, 4).unwrap();
        assert_ne!(dev.token_hash, token, "token must be stored hashed");
        assert!(m.authenticate(&token, 5).is_some());
        assert!(m.authenticate("forged", 5).is_none());
        // request is single-use
        assert_eq!(m.complete(&p.request_id, &p.code, 6), Err(PairingError::NotFound));
    }

    #[test]
    fn codes_expire() {
        let mut m = PairingManager::default();
        let p = m.request("phone", 0).unwrap();
        assert_eq!(m.approve(&p.request_id, CODE_TTL_MS + 1), Err(PairingError::NotFound));
    }

    #[test]
    fn brute_force_is_capped() {
        let mut m = PairingManager::default();
        let p = m.request("phone", 0).unwrap();
        m.approve(&p.request_id, 0).unwrap();
        for _ in 0..MAX_ATTEMPTS {
            assert_eq!(m.complete(&p.request_id, "x", 1), Err(PairingError::WrongCode));
        }
        assert_eq!(m.complete(&p.request_id, &p.code, 1), Err(PairingError::TooManyAttempts));
    }

    #[test]
    fn tokens_expire_and_revoke() {
        let mut m = PairingManager::default();
        let p = m.request("phone", 0).unwrap();
        m.approve(&p.request_id, 0).unwrap();
        let (dev, token) = m.complete(&p.request_id, &p.code, 0).unwrap();
        assert!(m.authenticate(&token, TOKEN_TTL_MS - 1).is_some());
        assert!(m.revoke(&dev.id));
        assert!(m.authenticate(&token, 1).is_none());

        let p = m.request("phone2", 0).unwrap();
        m.approve(&p.request_id, 0).unwrap();
        let (_, token) = m.complete(&p.request_id, &p.code, 0).unwrap();
        assert!(m.authenticate(&token, TOKEN_TTL_MS + 1).is_none());
    }

    #[test]
    fn limits_pending_and_names() {
        let mut m = PairingManager::default();
        for i in 0..MAX_PENDING {
            m.request(&format!("p{i}"), 0).unwrap();
        }
        assert_eq!(m.request("one too many", 0), Err(PairingError::Busy));
        assert_eq!(PairingManager::default().request("\u{0}\n", 0), Err(PairingError::InvalidName));
    }
}
