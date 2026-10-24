# MonitorOS Windows developer setup (Windows 10/11).
# Uses winget for user-approved installs. Does not change firewall, power or startup settings.
$ErrorActionPreference = "Stop"
winget install --id Rustlang.Rustup -e --accept-source-agreements
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install --id shinchiro.mpv -e   # native player; or place mpv.exe next to MonitorOS.exe
rustup default stable
Set-Location (Join-Path $PSScriptRoot "..\..")
npm install
Write-Host "Done. WebView2 ships with Windows 11; the installer bootstraps it on Windows 10."
