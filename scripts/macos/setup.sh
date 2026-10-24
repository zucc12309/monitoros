#!/usr/bin/env bash
# MonitorOS macOS developer setup. Installs only user-level tools via Homebrew.
# Nothing here changes system settings, login items or security preferences.
set -euo pipefail
command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh"; exit 1; }
brew list rustup >/dev/null 2>&1 || brew install rustup
brew list mpv >/dev/null 2>&1 || brew install mpv          # native player
brew list node >/dev/null 2>&1 || command -v node >/dev/null || brew install node
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
rustup show active-toolchain >/dev/null 2>&1 || rustup default stable
cd "$(dirname "$0")/../.."
npm install
echo "Done. Optional: brew install switchaudio-osx (lets MonitorOS change the system audio output)."
