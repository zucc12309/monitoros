//! Decides where each remote command goes, based on what is in front.
//!
//!   MonitorOS in front        → MonitorOS's TV interface (the WebView)
//!   streaming page in front   → that page (injected handler, no OS input)
//!   any other app in front    → real keyboard/mouse input (if allowed)
//!
//! Mode, volume, Home and Full screen are handled natively everywhere, so
//! the phone can always get back to MonitorOS.

use monitoros_core::remote::{ModeTarget, NavKey, RemoteCommand, VolumeAction};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Front {
    MonitorOs,
    ServicePage,
    OtherApp,
}

impl Front {
    pub fn as_str(self) -> &'static str {
        match self {
            Front::MonitorOs => "monitoros",
            Front::ServicePage => "page",
            Front::OtherApp => "system",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Native {
    Mode(ModeTarget),
    Volume(VolumeAction),
    /// Return to MonitorOS (close the service page / bring MonitorOS forward).
    Home,
    /// Toggle full screen on whatever is in front.
    Fullscreen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Native(Native),
    /// Emit to MonitorOS's own UI.
    Ui,
    /// Forward into the in-app service page.
    Page,
    /// Real OS keyboard/mouse input.
    System,
    /// Nothing sensible to do (e.g. other-app control switched off).
    Drop,
}

pub fn route(cmd: &RemoteCommand, front: Front, other_apps_allowed: bool) -> Route {
    match cmd {
        RemoteCommand::Mode { target } => Route::Native(Native::Mode(*target)),
        RemoteCommand::Volume { action } => Route::Native(Native::Volume(*action)),
        RemoteCommand::Fullscreen => Route::Native(Native::Fullscreen),
        RemoteCommand::Ping => Route::Drop,
        // Home in MonitorOS is just "go to the Home page" in the UI.
        RemoteCommand::Nav { key: NavKey::Home } if front != Front::MonitorOs => Route::Native(Native::Home),
        // The touchpad is the computer's mouse wherever you are (trusted
        // clicks work on every site). The page cursor is the fallback when
        // OS input isn't available.
        RemoteCommand::Pointer { .. } | RemoteCommand::Scroll { .. } => match front {
            Front::OtherApp if !other_apps_allowed => Route::Drop,
            _ => Route::System,
        },
        _ => match front {
            Front::MonitorOs => Route::Ui,
            Front::ServicePage => Route::Page,
            Front::OtherApp if other_apps_allowed => Route::System,
            Front::OtherApp => Route::Drop,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use monitoros_core::remote::MediaAction;

    const NAV_OK: RemoteCommand = RemoteCommand::Nav { key: NavKey::Ok };

    #[test]
    fn follows_whatever_is_in_front() {
        assert_eq!(route(&NAV_OK, Front::MonitorOs, true), Route::Ui);
        assert_eq!(route(&NAV_OK, Front::ServicePage, true), Route::Page);
        assert_eq!(route(&NAV_OK, Front::OtherApp, true), Route::System);
        let play = RemoteCommand::Media { action: MediaAction::PlayPause };
        assert_eq!(route(&play, Front::OtherApp, true), Route::System);
    }

    #[test]
    fn home_mode_volume_fullscreen_always_work() {
        for front in [Front::ServicePage, Front::OtherApp] {
            for allowed in [true, false] {
                assert_eq!(route(&RemoteCommand::Nav { key: NavKey::Home }, front, allowed), Route::Native(Native::Home));
                assert_eq!(route(&RemoteCommand::Fullscreen, front, allowed), Route::Native(Native::Fullscreen));
                assert_eq!(route(&RemoteCommand::Mode { target: ModeTarget::Tv }, front, allowed), Route::Native(Native::Mode(ModeTarget::Tv)));
            }
        }
        assert_eq!(route(&RemoteCommand::Nav { key: NavKey::Home }, Front::MonitorOs, true), Route::Ui);
    }

    #[test]
    fn touchpad_is_the_mouse_everywhere() {
        let p = RemoteCommand::Pointer { dx: 1.0, dy: 1.0, click: false };
        assert_eq!(route(&p, Front::MonitorOs, true), Route::System);
        assert_eq!(route(&p, Front::ServicePage, false), Route::System);
        assert_eq!(route(&p, Front::OtherApp, true), Route::System);
    }

    #[test]
    fn other_app_control_can_be_switched_off() {
        assert_eq!(route(&NAV_OK, Front::OtherApp, false), Route::Drop);
        assert_eq!(route(&RemoteCommand::Pointer { dx: 1.0, dy: 0.0, click: true }, Front::OtherApp, false), Route::Drop);
        // ...but never strands the user: Home still brings MonitorOS back.
        assert_eq!(route(&RemoteCommand::Nav { key: NavKey::Home }, Front::OtherApp, false), Route::Native(Native::Home));
    }
}
