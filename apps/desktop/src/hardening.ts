/**
 * Prototype-pollution hardening for MonitorOS's own UI.
 *
 * Tauri's `security.freezePrototype` would do this, but it injects the
 * freeze into *every* webview, including the in-app streaming window, where
 * it breaks real sites (YouTube renders blank, Netflix throws "Attempted to
 * assign to readonly property"). So it is off in tauri.conf.json and applied
 * here, to the main window only. Imported first in main.tsx.
 */
if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  Object.freeze(Object.prototype);
}
export {};
