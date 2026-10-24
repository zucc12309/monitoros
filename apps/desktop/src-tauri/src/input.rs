//! System-level input for services MonitorOS opened *outside* its own
//! windows (Chrome/Edge app window, default browser). The remote's commands
//! become real keystrokes / mouse movement in the frontmost app.
//!
//! Only active between "MonitorOS opened an external service" and "MonitorOS
//! regained focus", so the phone can't type into arbitrary apps at other
//! times. On macOS this needs Accessibility permission; the first use shows
//! the system prompt (MonitorOS never changes the setting itself).

use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use monitoros_core::remote::{MediaAction, NavKey, RemoteCommand};
use std::sync::mpsc;
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Tap(KeyName),
    MoveMouse(i32, i32),
    Click,
    Text(String),
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
        }
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
            let (x, y) = ((dx * 1.6).round() as i32, (dy * 1.6).round() as i32);
            if x != 0 || y != 0 {
                v.push(MoveMouse(x, y));
            }
            if *click {
                v.push(Click);
            }
            v
        }
        RemoteCommand::Text { value } if !value.is_empty() => vec![Text(value.clone())],
        _ => vec![],
    }
}

fn run(enigo: &mut Enigo, actions: Vec<Action>) -> Result<(), String> {
    for a in actions {
        match a {
            Action::Tap(k) => enigo.key(k.into(), Direction::Click),
            Action::MoveMouse(x, y) => enigo.move_mouse(x, y, Coordinate::Rel),
            Action::Click => enigo.button(Button::Left, Direction::Click),
            Action::Text(t) => enigo.text(&t),
        }
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Owns enigo on a dedicated thread (its macOS event source isn't Send).
pub struct SystemInput {
    tx: Mutex<Option<mpsc::Sender<Vec<Action>>>>,
}

impl Default for SystemInput {
    fn default() -> Self {
        Self { tx: Mutex::new(None) }
    }
}

impl SystemInput {
    fn sender(&self) -> mpsc::Sender<Vec<Action>> {
        let mut guard = self.tx.lock().unwrap();
        if let Some(tx) = guard.as_ref() {
            return tx.clone();
        }
        let (tx, rx) = mpsc::channel::<Vec<Action>>();
        std::thread::Builder::new()
            .name("monitoros-input".into())
            .spawn(move || {
                // Prompts for Accessibility on macOS the first time.
                let settings = Settings { open_prompt_to_get_permissions: true, ..Default::default() };
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
        let actions = plan(cmd);
        if actions.is_empty() {
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
    }

    #[test]
    fn seek_becomes_bounded_arrow_taps() {
        assert_eq!(plan(&RemoteCommand::Seek { delta_sec: -10.0 }), vec![Action::Tap(KeyName::Left)]);
        assert_eq!(plan(&RemoteCommand::Seek { delta_sec: 30.0 }).len(), 3);
        assert_eq!(plan(&RemoteCommand::Seek { delta_sec: 3600.0 }).len(), 12);
    }

    #[test]
    fn pointer_moves_and_clicks() {
        assert_eq!(plan(&RemoteCommand::Pointer { dx: 10.0, dy: -5.0, click: true }), vec![Action::MoveMouse(16, -8), Action::Click]);
        assert!(plan(&RemoteCommand::Pointer { dx: 0.0, dy: 0.0, click: false }).is_empty());
    }

    #[test]
    fn mode_and_volume_are_not_injected() {
        assert!(plan(&RemoteCommand::Ping).is_empty());
        assert!(plan(&RemoteCommand::Text { value: String::new() }).is_empty());
    }
}
