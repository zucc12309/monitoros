//! Manual check against a real Dolphin: serves four pads on 127.0.0.1:26760
//! and holds a different button on each, so Dolphin's controller settings
//! show which `DSUClient/N/MonitorOS` device is which.
//!
//!   cargo run -p gamepad-bridge --example dsu_demo
//!
//! Pad 0 holds Cross, 1 Circle, 2 Square, 3 Triangle; the left stick of each
//! sweeps slowly. Prints how many clients subscribe to each slot.

use gamepad_bridge::proto::{button, PadState};
use gamepad_bridge::{Bridge, DEFAULT_PORT};
use std::time::Duration;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let bridge = Bridge::start(DEFAULT_PORT).await?;
    println!("DSU server on {}", bridge.addr);
    let held = [button::CROSS, button::CIRCLE, button::SQUARE, button::TRIANGLE];
    for slot in 0..4 {
        bridge.set_connected(slot, true);
    }
    let mut tick = 0u32;
    loop {
        let phase = tick as f32 / 20.0;
        for (slot, b) in held.iter().enumerate() {
            let x = (phase + slot as f32).sin();
            bridge.set_state(slot, PadState { buttons: *b, left: (x, 0.0), ..PadState::neutral() });
        }
        if tick.is_multiple_of(20) {
            println!("subscribers per slot: {:?}", bridge.subscribers());
        }
        tick += 1;
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
