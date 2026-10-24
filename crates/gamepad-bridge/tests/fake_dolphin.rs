//! Talks to the bridge over real UDP the way Dolphin's DSU client does.

use gamepad_bridge::proto::{self, button, PadState};
use gamepad_bridge::Bridge;
use std::time::Duration;
use tokio::net::UdpSocket;
use tokio::time::timeout;

async fn client(bridge: &Bridge) -> UdpSocket {
    let s = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    s.connect(bridge.addr).await.unwrap();
    s
}

async fn recv(s: &UdpSocket) -> Vec<u8> {
    let mut buf = [0u8; 256];
    let n = timeout(Duration::from_secs(2), s.recv(&mut buf)).await.expect("no reply").unwrap();
    buf[..n].to_vec()
}

/// Next pad packet for `slot` (others are skipped).
async fn pad_for(s: &UdpSocket, slot: u8) -> proto::DecodedPad {
    loop {
        if let Some(p) = proto::decode_pad_data(&recv(s).await) {
            if p.slot == slot {
                return p;
            }
        }
    }
}

#[tokio::test]
async fn refuses_non_loopback_bind() {
    assert!(Bridge::start_on("0.0.0.0".parse().unwrap(), 0).await.is_err());
}

#[tokio::test]
async fn answers_version_and_port_queries() {
    let bridge = Bridge::start(0).await.unwrap();
    bridge.set_connected(1, true);
    let c = client(&bridge).await;

    c.send(&proto::client_packet(proto::MSG_VERSION, &[])).await.unwrap();
    assert_eq!(recv(&c).await.len(), proto::VERSION_RESPONSE_LEN);

    c.send(&proto::client_packet(proto::MSG_PORTS, &[4, 0, 0, 0, 0, 1, 2, 3])).await.unwrap();
    let states: Vec<u8> = futures_states(&c).await;
    assert_eq!(states, vec![0, 2, 0, 0]); // only slot 1 connected
    bridge.stop();
}

async fn futures_states(c: &UdpSocket) -> Vec<u8> {
    let mut out = vec![];
    for _ in 0..4 {
        let p = recv(c).await;
        assert_eq!(p.len(), proto::PORT_INFO_LEN);
        out.push(p[21]);
    }
    out
}

#[tokio::test]
async fn four_players_are_isolated() {
    let bridge = Bridge::start(0).await.unwrap();
    for i in 0..4 {
        bridge.set_connected(i, true);
    }
    let c = client(&bridge).await;
    c.send(&proto::client_packet(proto::MSG_DATA, &[0; 8])).await.unwrap();

    // Player 3 presses A (cross); everyone else stays neutral.
    bridge.set_state(2, PadState { buttons: button::CROSS, left: (1.0, 0.0), ..PadState::neutral() });
    let p3 = loop {
        let p = pad_for(&c, 2).await;
        if p.states2 != 0 {
            break p;
        }
    };
    assert_eq!(p3.states2, 0x40);
    assert_eq!(p3.left.0, 255);
    for other in [0, 1, 3] {
        let p = pad_for(&c, other).await;
        assert_eq!((p.states1, p.states2, p.left), (0, 0, (128, 128)), "slot {other} leaked input");
    }
    bridge.stop();
}

#[tokio::test]
async fn per_slot_subscription_only_receives_that_slot() {
    let bridge = Bridge::start(0).await.unwrap();
    bridge.set_connected(0, true);
    bridge.set_connected(3, true);
    let c = client(&bridge).await;
    c.send(&proto::client_packet(proto::MSG_DATA, &[1, 3, 0, 0, 0, 0, 0, 0])).await.unwrap();
    for _ in 0..5 {
        assert_eq!(proto::decode_pad_data(&recv(&c).await).unwrap().slot, 3);
    }
    assert_eq!(bridge.subscribers(), [0, 0, 0, 1]);
    bridge.stop();
}

#[tokio::test]
async fn release_and_disconnect_clear_input() {
    let bridge = Bridge::start(0).await.unwrap();
    bridge.set_connected(0, true);
    let c = client(&bridge).await;
    c.send(&proto::client_packet(proto::MSG_DATA, &[0; 8])).await.unwrap();
    bridge.set_state(0, PadState { buttons: button::R2, ..PadState::neutral() });
    while pad_for(&c, 0).await.states2 == 0 {}
    bridge.release(0);
    while pad_for(&c, 0).await.states2 != 0 {}

    // Rejoining after a disconnect starts neutral, never with stale input.
    bridge.set_state(0, PadState { buttons: button::R2, ..PadState::neutral() });
    bridge.set_connected(0, false);
    bridge.set_connected(0, true);
    assert!(!bridge.is_connected(1));
    assert_eq!(pad_for(&c, 0).await.states2, 0);
    bridge.stop();
}

#[tokio::test]
async fn ignores_garbage_and_keeps_serving() {
    let bridge = Bridge::start(0).await.unwrap();
    let c = client(&bridge).await;
    c.send(&[0xFF; 64]).await.unwrap();
    c.send(b"DSUC").await.unwrap();
    c.send(&proto::client_packet(proto::MSG_VERSION, &[])).await.unwrap();
    assert_eq!(recv(&c).await.len(), proto::VERSION_RESPONSE_LEN);
    bridge.stop();
}
