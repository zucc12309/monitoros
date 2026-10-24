#!/usr/bin/env bash
# Builds MonitorOS.app and a DMG into target/release/bundle/.
# Unsigned by default. To sign + notarize, see docs/ARCHITECTURE.md#packaging.
set -euo pipefail
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
cd "$(dirname "$0")/../.."
npm --prefix apps/desktop run tauri -- build --bundles app
APP=target/release/bundle/macos/MonitorOS.app
DMG=target/release/bundle/dmg/MonitorOS_$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")_$(uname -m).dmg
mkdir -p "$(dirname "$DMG")"
# Plain hdiutil DMG: the styled Tauri DMG needs Finder automation permission.
hdiutil create -volname MonitorOS -srcfolder "$APP" -ov -format UDZO "$DMG"
echo "Built $APP and $DMG"
