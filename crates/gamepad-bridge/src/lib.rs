//! Loopback DSU server: MonitorOS's four phone controllers appear in Dolphin
//! as `DSUClient/0..3/MonitorOS`.
//!
//! Security: binds 127.0.0.1 only (refuses anything else), validates every
//! packet, caps the number of subscribed clients, and expires subscriptions
//! that stop re-registering. DSU itself is unauthenticated, so anything on
//! this machine could read pad state; same-user processes are already
//! outside MonitorOS's threat model (docs/gaming/SECURITY_REVIEW.md).

pub mod proto;

use proto::{ClientRequest, PadState, Subscription, SLOT_COUNT};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::UdpSocket;
use tokio::sync::Notify;

pub const DEFAULT_PORT: u16 = 26760;
/// Dolphin re-registers every second; DS4Windows expires after 5 s.
const SUBSCRIPTION_TTL: Duration = Duration::from_secs(5);
/// Keep-alive cadence so Dolphin never marks the server unresponsive (1 s).
const HEARTBEAT: Duration = Duration::from_millis(100);
const MAX_CLIENTS: usize = 8;

#[derive(Debug, Clone, Copy)]
struct Slot {
    connected: bool,
    state: PadState,
    counter: u32,
}

#[derive(Debug, Default)]
struct Client {
    all: bool,
    slots: [bool; SLOT_COUNT],
    last_seen: Option<Instant>,
}

struct Shared {
    slots: Mutex<[Slot; SLOT_COUNT]>,
    clients: Mutex<HashMap<SocketAddr, Client>>,
    changed: Notify,
    started: Instant,
}

/// Handle used by the game session to drive the four virtual pads.
#[derive(Clone)]
pub struct Bridge {
    shared: Arc<Shared>,
    pub addr: SocketAddr,
    stop: Arc<Notify>,
}

impl Bridge {
    /// Starts the server on 127.0.0.1:`port` (0 = any free port, for tests).
    pub async fn start(port: u16) -> std::io::Result<Bridge> {
        Self::start_on(IpAddr::V4(Ipv4Addr::LOCALHOST), port).await
    }

    pub async fn start_on(ip: IpAddr, port: u16) -> std::io::Result<Bridge> {
        if !ip.is_loopback() {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "the DSU server only listens on loopback"));
        }
        let socket = Arc::new(UdpSocket::bind((ip, port)).await?);
        let addr = socket.local_addr()?;
        let shared = Arc::new(Shared {
            slots: Mutex::new([Slot { connected: false, state: PadState::neutral(), counter: 0 }; SLOT_COUNT]),
            clients: Mutex::new(HashMap::new()),
            changed: Notify::new(),
            started: Instant::now(),
        });
        let stop = Arc::new(Notify::new());
        let server_id: u32 = rand::random();

        // Receiver: answers version/port queries, records subscriptions.
        {
            let (socket, shared, stop) = (socket.clone(), shared.clone(), stop.clone());
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                loop {
                    let (n, from) = tokio::select! {
                        r = socket.recv_from(&mut buf) => match r { Ok(v) => v, Err(_) => continue },
                        _ = stop.notified() => break,
                    };
                    // Only local peers (the socket is loopback, but be explicit).
                    if !from.ip().is_loopback() {
                        continue;
                    }
                    let Ok(req) = proto::parse_client(&buf[..n]) else { continue };
                    match req {
                        ClientRequest::Version => {
                            let _ = socket.send_to(&proto::version_response(server_id), from).await;
                        }
                        ClientRequest::ListPorts(slots) => {
                            let snapshot = *shared.slots.lock().unwrap();
                            for s in slots {
                                let _ = socket.send_to(&proto::port_info(server_id, s, snapshot[s as usize].connected), from).await;
                            }
                        }
                        ClientRequest::PadData(sub) => {
                            let mut clients = shared.clients.lock().unwrap();
                            let now = Instant::now();
                            clients.retain(|_, c| c.last_seen.is_some_and(|t| now - t < SUBSCRIPTION_TTL));
                            if !clients.contains_key(&from) && clients.len() >= MAX_CLIENTS {
                                continue;
                            }
                            let c = clients.entry(from).or_default();
                            c.last_seen = Some(now);
                            match sub {
                                Subscription::All => c.all = true,
                                Subscription::Slot(s) => c.slots[s as usize] = true,
                                Subscription::Mac(mac) => {
                                    if let Some(s) = (0..SLOT_COUNT as u8).find(|&s| proto::slot_mac(s) == mac) {
                                        c.slots[s as usize] = true;
                                    }
                                }
                            }
                            drop(clients);
                            shared.changed.notify_one();
                        }
                    }
                }
            });
        }

        // Sender: pushes pad data on every change and as a heartbeat.
        {
            let (socket, shared, stop) = (socket.clone(), shared.clone(), stop.clone());
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = shared.changed.notified() => {}
                        _ = tokio::time::sleep(HEARTBEAT) => {}
                        _ = stop.notified() => break,
                    }
                    let ts = shared.started.elapsed().as_micros() as u64;
                    let packets: Vec<(SocketAddr, [u8; proto::PAD_DATA_LEN])> = {
                        let mut slots = shared.slots.lock().unwrap();
                        let clients = shared.clients.lock().unwrap();
                        let now = Instant::now();
                        let mut out = vec![];
                        for (i, slot) in slots.iter_mut().enumerate() {
                            if !slot.connected {
                                continue;
                            }
                            slot.counter = slot.counter.wrapping_add(1);
                            let pkt = proto::pad_data(server_id, i as u8, true, slot.counter, ts, &slot.state);
                            for (addr, c) in clients.iter() {
                                let live = c.last_seen.is_some_and(|t| now - t < SUBSCRIPTION_TTL);
                                if live && (c.all || c.slots[i]) {
                                    out.push((*addr, pkt));
                                }
                            }
                        }
                        out
                    };
                    for (addr, pkt) in packets {
                        let _ = socket.send_to(&pkt, addr).await;
                    }
                }
            });
        }

        Ok(Bridge { shared, addr, stop })
    }

    /// A player joined (slot shows up in Dolphin) or left (slot disappears).
    pub fn set_connected(&self, slot: usize, connected: bool) {
        if slot >= SLOT_COUNT {
            return;
        }
        let mut slots = self.shared.slots.lock().unwrap();
        slots[slot].connected = connected;
        slots[slot].state = PadState::neutral(); // never carry input across owners
        drop(slots);
        self.shared.changed.notify_one();
    }

    /// Full snapshot for one slot. Values are clamped; out-of-range slots ignored.
    pub fn set_state(&self, slot: usize, state: PadState) {
        if slot >= SLOT_COUNT {
            return;
        }
        self.shared.slots.lock().unwrap()[slot].state = state.sanitized();
        self.shared.changed.notify_one();
    }

    /// Release every button on a slot (disconnect, focus loss, game exit).
    pub fn release(&self, slot: usize) {
        self.set_state(slot, PadState::neutral());
    }

    pub fn is_connected(&self, slot: usize) -> bool {
        slot < SLOT_COUNT && self.shared.slots.lock().unwrap()[slot].connected
    }

    /// Number of live subscribers (e.g. Dolphin) per slot, for diagnostics.
    pub fn subscribers(&self) -> [usize; SLOT_COUNT] {
        let now = Instant::now();
        let clients = self.shared.clients.lock().unwrap();
        let mut out = [0; SLOT_COUNT];
        for c in clients.values().filter(|c| c.last_seen.is_some_and(|t| now - t < SUBSCRIPTION_TTL)) {
            for (i, n) in out.iter_mut().enumerate() {
                if c.all || c.slots[i] {
                    *n += 1;
                }
            }
        }
        out
    }

    pub fn stop(&self) {
        self.stop.notify_waiters();
    }
}
