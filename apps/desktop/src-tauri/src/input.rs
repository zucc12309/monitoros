//! System-level input for services MonitorOS opened *outside* its own
//! windows (Chrome/Edge app window, default browser). The remote's commands
//! become real keystrokes / mouse movement in the frontmost app.
//!
//! Only active between "MonitorOS opened an external service" and "MonitorOS
//! regained focus", so the phone can't type into arbitrary apps at other
//! times. On macOS this needs Accessibility permission; the first use shows
//! the system prompt (MonitorOS never changes the setting itself).

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use monitoros_core::remote::{MediaAction, NavKey, RemoteCommand};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

/// Whether MonitorOS may synthesise mouse/keyboard input. macOS gates this
/// behind Privacy & Security › Accessibility; Windows allows it for
/// same-integrity apps.
pub fn permitted() -> bool {
    #[cfg(target_os = "macos")]
    // SAFETY: argument-less query of the current process's trust state.
    return unsafe { AXIsProcessTrusted() };
    #[cfg(not(target_os = "macos"))]
    true
}

/// Pointer acceleration: slow drags stay precise, fast flicks cross the screen.
pub fn accelerate(dx: f64, dy: f64) -> (i32, i32) {
    let speed = dx.hypot(dy);
    let factor = 1.4 + (speed / 25.0).min(2.0);
    ((dx * factor).round() as i32, (dy * factor).round() as i32)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Tap(KeyName),
    MoveMouse(i32, i32),
    Click,
    /// Wheel ticks: (horizontal, vertical); positive = right/down.
    Scroll(i32, i32),
    Text(String),
    /// Hold modifiers, tap a key, release (e.g. Ctrl+Cmd+F).
    Combo(Vec<KeyName>, KeyName),
}

/// Mirror of the enigo keys we use, so the mapping is testable without enigo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyName {
    Up,
    Down,
    Left,
    Right,
    Enter,
    Escape,
    Space,
    Control,
    Meta,
    F,
    F11,
}

impl From<KeyName> for Key {
    fn from(k: KeyName) -> Key {
        match k {
            KeyName::Up => Key::UpArrow,
            KeyName::Down => Key::DownArrow,
            KeyName::Left => Key::LeftArrow,
            KeyName::Right => Key::RightArrow,
            KeyName::Enter => Key::Return,
            KeyName::Escape => Key::Escape,
            KeyName::Space => Key::Space,
            KeyName::Control => Key::Control,
            KeyName::Meta => Key::Meta,
            KeyName::F => Key::Unicode('f'),
            KeyName::F11 => Key::F11,
        }
    }
}

/// The OS "toggle full screen" shortcut for the frontmost app:
/// Control+Command+F on macOS (the standard View › Enter Full Screen),
/// F11 on Windows (browsers, Explorer, most media apps).
pub fn fullscreen_combo() -> Action {
    if cfg!(target_os = "macos") {
        Action::Combo(vec![KeyName::Control, KeyName::Meta], KeyName::F)
    } else {
        Action::Combo(vec![], KeyName::F11)
    }
}

/// Remote command → input actions. Mode/volume/home are handled elsewhere
/// and map to nothing here.
pub fn plan(cmd: &RemoteCommand) -> Vec<Action> {
    use Action::*;
    match cmd {
        RemoteCommand::Nav { key } => match key {
            NavKey::Up => vec![Tap(KeyName::Up)],
            NavKey::Down => vec![Tap(KeyName::Down)],
            NavKey::Left => vec![Tap(KeyName::Left)],
            NavKey::Right => vec![Tap(KeyName::Right)],
            NavKey::Ok => vec![Tap(KeyName::Enter)],
            NavKey::Back => vec![Tap(KeyName::Escape)],
            NavKey::Home | NavKey::Search => vec![],
        },
        RemoteCommand::Media { action: MediaAction::PlayPause } => vec![Tap(KeyName::Space)],
        RemoteCommand::Media { .. } => vec![],
        RemoteCommand::Seek { delta_sec } => {
            let steps = ((delta_sec.abs() / 10.0).round() as usize).clamp(1, 12);
            vec![Tap(if *delta_sec < 0.0 { KeyName::Left } else { KeyName::Right }); steps]
        }
        RemoteCommand::Pointer { dx, dy, click } => {
            let mut v = vec![];
            let (x, y) = accelerate(*dx, *dy);
            if x != 0 || y != 0 {
                v.push(MoveMouse(x, y));
            }
            if *click {
                v.push(Click);
            }
            v
        }
        RemoteCommand::Scroll { dx, dy } => {
            // Natural scrolling: fingers up → content up → view scrolls down.
            let ticks = |d: f64| (-d / 12.0).round().clamp(-10.0, 10.0) as i32;
            let (x, y) = (ticks(*dx), ticks(*dy));
            if x == 0 && y == 0 {
                vec![]
            } else {
                vec![Scroll(x, y)]
            }
        }
        // Other apps can't be "replaced into", so text is only typed on Send.
        RemoteCommand::Text { value, submit: true } => {
            let mut v = vec![];
            if !value.is_empty() {
                v.push(Text(value.clone()));
            }
            v.push(Tap(KeyName::Enter));
            v
        }
        RemoteCommand::Fullscreen => vec![fullscreen_combo()],
        _ => vec![],
    }
}

fn run(enigo: &mut Enigo, actions: Vec<Action>) -> Result<(), String> {
    for a in actions {
        match a {
            Action::Tap(k) => enigo.key(k.into(), Direction::Click),
            Action::MoveMouse(x, y) => enigo.move_mouse(x, y, Coordinate::Rel),
            Action::Click => enigo.button(Button::Left, Direction::Click),
            Action::Scroll(x, y) => {
                if x != 0 {
                    enigo.scroll(x, Axis::Horizontal).map_err(|e| e.to_string())?;
                }
                if y != 0 {
                    enigo.scroll(y, Axis::Vertical)
                } else {
                    Ok(())
                }
            }
            Action::Text(t) => enigo.text(&t),
            Action::Combo(mods, key) => {
                for m in &mods {
                    enigo.key((*m).into(), Direction::Press).map_err(|e| e.to_string())?;
                }
                let r = enigo.key(key.into(), Direction::Click);
                for m in mods.iter().rev() {
                    let _ = enigo.key((*m).into(), Direction::Release);
                }
                r
            }
        }
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Owns enigo on a dedicated thread (its macOS event source isn't Send).
pub struct SystemInput {
    tx: Mutex<Option<mpsc::Sender<Vec<Action>>>>,
    prompted: AtomicBool,
}

impl Default for SystemInput {
    fn default() -> Self {
        Self { tx: Mutex::new(None), prompted: AtomicBool::new(false) }
    }
}

impl SystemInput {
    /// Shows the macOS Accessibility prompt at most once per run (the OS
    /// prompt is the only way MonitorOS asks; it never edits the setting).
    pub fn request_permission_once(&self) {
        if permitted() || self.prompted.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(|| {
            let settings = Settings { open_prompt_to_get_permissions: true, ..Default::default() };
            let _ = Enigo::new(&settings);
        });
    }

    fn sender(&self) -> mpsc::Sender<Vec<Action>> {
        let mut guard = self.tx.lock().unwrap();
        if let Some(tx) = guard.as_ref() {
            return tx.clone();
        }
        let (tx, rx) = mpsc::channel::<Vec<Action>>();
        std::thread::Builder::new()
            .name("monitoros-input".into())
            .spawn(move || {
                let settings = Settings { open_prompt_to_get_permissions: false, ..Default::default() };
                let mut enigo = match Enigo::new(&settings) {
                    Ok(e) => e,
                    Err(e) => {
                        tracing::warn!("system input unavailable: {e}");
                        return;
                    }
                };
                while let Ok(actions) = rx.recv() {
                    if let Err(e) = run(&mut enigo, actions) {
                        tracing::warn!("input injection failed: {e}");
                    }
                }
            })
            .expect("spawn input thread");
        *guard = Some(tx.clone());
        tx
    }

    /// Returns false when the command has no system-input meaning.
    pub fn send(&self, cmd: &RemoteCommand) -> bool {
        self.send_actions(plan(cmd))
    }

    pub fn send_actions(&self, actions: Vec<Action>) -> bool {
        if actions.is_empty() {
            return false;
        }
        if !permitted() {
            self.request_permission_once();
            return false;
        }
        if self.sender().send(actions).is_err() {
            // Worker died (e.g. permission denied): retry with a fresh one next time.
            *self.tx.lock().unwrap() = None;
            return false;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_navigation_and_media() {
        assert_eq!(plan(&RemoteCommand::Nav { key: NavKey::Ok }), vec![Action::Tap(KeyName::Enter)]);
        assert_eq!(plan(&RemoteCommand::Nav { key: NavKey::Back }), vec![Action::Tap(KeyName::Escape)]);
        assert_eq!(plan(&RemoteCommand::Media { action: MediaAction::PlayPause }), vec![Action::Tap(KeyName::Space)]);
        assert!(plan(&RemoteCommand::Nav { key: NavKey::Home }).is_empty(), "home is handled natively");
        assert_eq!(plan(&RemoteCommand::Fullscreen), vec![fullscreen_combo()]);
        if cfg!(target_os = "macos") {
            assert_eq!(fullscreen_combo(), Action::Combo(vec![KeyName::Control, KeyName::Meta], KeyName::F));
        }
    }

    #[test]
    fn seek_becomes_bounded_arrow_taps() {
        assert_eq!(plan(&RemoteCommand::Seek { delta_sec: -10.0 }), vec![Action::Tap(KeyName::Left)]);
        assert_eq!(plan(&RemoteCommand::Seek { delta_sec: 30.0 }).len(), 3);
        assert_eq!(plan(&RemoteCommand::Seek { delta_sec: 3600.0 }).len(), 12);
    }

    #[test]
    fn pointer_moves_and_clicks() {
        assert_eq!(plan(&RemoteCommand::Pointer { dx: 10.0, dy: -5.0, click: true }), vec![Action::MoveMouse(18, -9), Action::Click]);
        assert!(plan(&RemoteCommand::Pointer { dx: 0.0, dy: 0.0, click: false }).is_empty());
    }

    #[test]
    fn acceleration_is_gentle_when_slow_and_fast_when_flicked() {
        assert_eq!(accelerate(2.0, 0.0), (3, 0));
        let (fast, _) = accelerate(100.0, 0.0);
        assert!(fast >= 300, "{fast}");
        assert_eq!(accelerate(-4.0, 3.0), (-6, 5)); // speed 5 → ×1.6
    }

    #[test]
    fn two_finger_scroll_is_natural_and_bounded() {
        assert_eq!(plan(&RemoteCommand::Scroll { dx: 0.0, dy: -36.0 }), vec![Action::Scroll(0, 3)]);
        assert_eq!(plan(&RemoteCommand::Scroll { dx: 60.0, dy: 0.0 }), vec![Action::Scroll(-5, 0)]);
        assert_eq!(plan(&RemoteCommand::Scroll { dx: 0.0, dy: 499.0 }), vec![Action::Scroll(0, -10)]);
        assert!(plan(&RemoteCommand::Scroll { dx: 2.0, dy: 2.0 }).is_empty());
    }

    #[test]
    fn mode_and_volume_are_not_injected() {
        assert!(plan(&RemoteCommand::Ping).is_empty());
        assert!(plan(&RemoteCommand::Text { value: "live".into(), submit: false }).is_empty(), "live mirroring isn't typed into other apps");
        assert_eq!(plan(&RemoteCommand::Text { value: "kalki".into(), submit: true }), vec![Action::Text("kalki".into()), Action::Tap(KeyName::Enter)]);
    }
}
