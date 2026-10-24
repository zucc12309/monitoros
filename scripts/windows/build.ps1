# Builds the MSI and NSIS (.exe) installers into target\release\bundle\.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
npm --prefix apps/desktop run tauri -- build --bundles msi,nsis
Get-ChildItem target\release\bundle -Recurse -Include *.msi,*.exe | Select-Object FullName, Length
