//! Dev harness: runs the real remote server on 127.0.0.1:47815 serving the
//! built PWA, auto-approves pairing (standing in for the TV dialog) and
//! prints every command it receives. For manual/E2E testing only.
//!
//!   cargo run -p remote-server --example dev_harness -- ../../apps/remote/dist

use monitoros_core::pairing::PairingManager;
use remote_server::{start, ServerConfig, ServerEvent};
use std::sync::{Arc, Mutex};

#[tokio::main]
async fn main() {
    let dir = std::env::args().nth(1).map(std::path::PathBuf::from);
    let port: u16 = std::env::args().nth(2).and_then(|p| p.parse().ok()).unwrap_or(47815);
    let pairing = Arc::new(Mutex::new(PairingManager::default()));
    let (ctx, mut crx) = tokio::sync::mpsc::channel(64);
    let (etx, mut erx) = tokio::sync::mpsc::channel(64);
    let (_stx, srx) = tokio::sync::watch::channel(serde_json::json!({ "mode": "tv" }));
    let h = start(ServerConfig { bind_ip: "127.0.0.1".parse().unwrap(), port, static_dir: dir, pairing: pairing.clone(), commands: ctx, events: etx, status: srx })
        .await
        .expect("bind");
    println!("listening {}", h.url());
    let p = pairing.clone();
    tokio::spawn(async move {
        while let Some(ev) = erx.recv().await {
            if let ServerEvent::PairingRequested { request } = &ev {
                p.lock().unwrap().approve(&request.request_id, monitoros_core::now_ms()).unwrap();
                println!("PAIRING code={} device={}", request.code, request.device_name);
            } else {
                println!("EVENT {}", serde_json::to_string(&ev).unwrap());
            }
        }
    });
    while let Some(c) = crx.recv().await {
        println!("COMMAND {}", serde_json::to_string(&c.command).unwrap());
    }
}
