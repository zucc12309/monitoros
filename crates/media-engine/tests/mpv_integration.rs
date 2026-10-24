//! Real mpv integration test. Generates a 3-second MKV with ffmpeg and plays
//! it headless (--vo=null --ao=null), exercising spawn → IPC → events → seek →
//! quit. Skips (passes with a note) if mpv or ffmpeg is not installed.

use media_engine::{find_mpv, MpvEvent, MpvSession, PlayOptions, PlayerCommand};
use std::process::Command;
use std::time::Duration;

#[tokio::test]
async fn plays_local_mkv_via_ipc() {
    let Some(mpv) = find_mpv() else {
        eprintln!("SKIP: mpv not installed");
        return;
    };
    let dir = std::env::temp_dir().join(format!("monitoros-mpv-it-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("test.mkv");
    let ok = Command::new("ffmpeg")
        .args(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-c:v", "libx264", "-c:a", "aac"])
        .arg(&file)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        eprintln!("SKIP: ffmpeg not available");
        return;
    }

    let opts = PlayOptions { title: Some("Integration".into()), hwdec: Some("no".into()), headless: true, ..Default::default() };
    let (mut s, mut rx) = MpvSession::spawn(&mpv, file.to_str().unwrap(), &opts).await.expect("spawn mpv");

    let mut saw_duration = false;
    let mut saw_time = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline && !(saw_duration && saw_time) {
        if let Ok(Ok(ev)) = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
            match ev {
                MpvEvent::Duration { duration } => {
                    assert!((duration - 3.0).abs() < 0.5, "duration {duration}");
                    saw_duration = true;
                }
                MpvEvent::Time { .. } => saw_time = true,
                _ => {}
            }
        }
    }
    assert!(saw_duration && saw_time, "expected duration and time-pos events");

    s.command(PlayerCommand::SetPause { paused: true }).await.expect("pause");
    let paused = s.command(PlayerCommand::GetProperty { name: "pause".into() }).await.unwrap();
    assert_eq!(paused, serde_json::Value::Bool(true));
    s.command(PlayerCommand::SeekAbsolute { seconds: 1.0 }).await.expect("seek");
    s.stop().await;
    assert!(!s.is_running());
    std::fs::remove_dir_all(dir).ok();
}
