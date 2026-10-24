// Injected into the in-app service window (Netflix, Prime, YouTube, ...).
// Lets the iPhone remote drive a website that was never built for a remote.
//
// The native shell calls window.__monitorosRemote(<RemoteCommand JSON>).
// This script has no MonitorOS IPC: it can only act on the page it lives in,
// and to "go back to MonitorOS" it navigates to the sentinel close URL.
(() => {
  if (window.top !== window || window.__monitorosRemote) return;

  const CLOSE_URL = "https://monitoros.invalid/close";
  // The page the service opened on. Back from here returns to MonitorOS
  // instead of walking into sign-in redirects or a blank initial page.
  const ENTRY_KEY = "__monitoros_entry";
  const stripHash = (u) => u.split("#")[0];
  try {
    if (!sessionStorage.getItem(ENTRY_KEY)) sessionStorage.setItem(ENTRY_KEY, stripHash(location.href));
  } catch (_) {}
  const atEntry = () => {
    try {
      return stripHash(location.href) === sessionStorage.getItem(ENTRY_KEY);
    } catch (_) {
      return true;
    }
  };
  const FOCUSABLE =
    'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [tabindex]:not([tabindex="-1"])';
  const KEYS = {
    up: ["ArrowUp", 38],
    down: ["ArrowDown", 40],
    left: ["ArrowLeft", 37],
    right: ["ArrowRight", 39],
    ok: ["Enter", 13],
    back: ["Escape", 27],
    space: [" ", 32],
  };

  // ---------- visuals ----------
  const style = document.createElement("style");
  style.textContent = `
    .__mo-focus { outline: 4px solid #fff !important; outline-offset: 3px !important; border-radius: 6px; box-shadow: 0 0 0 8px rgba(124,108,255,.55) !important; }
    #__mo_cursor { position: fixed; z-index: 2147483647; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%;
      background: rgba(255,255,255,.9); box-shadow: 0 0 0 3px rgba(124,108,255,.9), 0 4px 18px rgba(0,0,0,.5); pointer-events: none; transition: opacity .3s; }
    #__mo_hint { position: fixed; z-index: 2147483647; left: 50%; bottom: 36px; transform: translateX(-50%); padding: 10px 18px; border-radius: 999px;
      background: rgba(10,10,20,.8); color: #fff; font: 600 15px -apple-system, system-ui, sans-serif; pointer-events: none; transition: opacity .4s; }`;
  const mount = () => document.head && !style.isConnected && document.head.appendChild(style);

  let cursor = null;
  let cx = innerWidth / 2;
  let cy = innerHeight / 2;
  let cursorTimer;
  function showCursor() {
    mount();
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.id = "__mo_cursor";
      document.documentElement.appendChild(cursor);
    }
    cursor.style.left = cx + "px";
    cursor.style.top = cy + "px";
    cursor.style.opacity = "1";
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => cursor && (cursor.style.opacity = "0"), 4000);
  }
  const cursorVisible = () => cursor && cursor.style.opacity === "1";

  function hint(text) {
    let h = document.getElementById("__mo_hint");
    if (!h) {
      h = document.createElement("div");
      h.id = "__mo_hint";
      document.documentElement.appendChild(h);
    }
    h.textContent = text;
    h.style.opacity = "1";
    clearTimeout(h.__t);
    h.__t = setTimeout(() => (h.style.opacity = "0"), 1600);
  }

  // ---------- helpers ----------
  // Rendered and interactable. `reach` widens the area beyond the viewport so
  // the next row/tile just off-screen is a valid target (it scrolls into view).
  function visible(el, reach = 0) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const mx = innerWidth * reach, my = innerHeight * reach;
    if (r.bottom < -my || r.right < -mx || r.top > innerHeight + my || r.left > innerWidth + mx) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0" && !el.closest("[aria-hidden='true']");
  }

  // The video the user is *watching*, not a browse-page trailer. Netflix,
  // Prime and Hotstar autoplay large hero trailers on their home pages; those
  // must not capture the D-pad, or the arrows only scroll and nothing can be
  // selected. A watched video fills (nearly) the whole screen.
  function activeVideo() {
    const fs = document.fullscreenElement;
    const vids = [...document.querySelectorAll("video")].filter((v) => {
      if (!(v.currentTime > 0 || !v.paused)) return false;
      if (fs && (fs === v || fs.contains(v))) return true;
      const r = v.getBoundingClientRect();
      const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      return w > 0 && h > 0 && w >= innerWidth * 0.9 && h >= innerHeight * 0.85;
    });
    return vids[0] || null;
  }

  function sendKey(name, target) {
    const [key, code] = KEYS[name];
    const el = target || document.activeElement || document.body;
    for (const type of ["keydown", "keyup"]) {
      const ev = new KeyboardEvent(type, { key, code: key === " " ? "Space" : key, bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(ev, "keyCode", { get: () => code });
      Object.defineProperty(ev, "which", { get: () => code });
      el.dispatchEvent(ev);
    }
  }

  function clickEl(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window };
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"]) el.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, opts));
    el.click();
  }

  // ---------- spatial navigation over the page's own links/buttons ----------
  let current = null;
  function setFocus(el) {
    if (current) current.classList.remove("__mo-focus");
    current = el;
    mount();
    el.classList.add("__mo-focus");
    try {
      el.focus({ preventScroll: true });
    } catch (_) {}
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }

  function navigate(dir) {
    const candidates = [...document.querySelectorAll(FOCUSABLE)].filter((e) => e !== current && visible(e, 1.5));
    if (!candidates.length) return false;
    if (!current || !current.isConnected || !visible(current, 0.5)) {
      // Start nearest the top-left of the content area.
      candidates.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return ra.top - rb.top || ra.left - rb.left;
      });
      setFocus(candidates[0]);
      return true;
    }
    const from = current.getBoundingClientRect();
    const fx = from.left + from.width / 2, fy = from.top + from.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of candidates) {
      if (current.contains(el) || el.contains(current)) continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const dx = x - fx, dy = y - fy;
      const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
      const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
      if (along <= 4) continue;
      // Left/right stay in the same row: the target must overlap vertically.
      if ((dir === "left" || dir === "right") && Math.abs(dy) > Math.max(from.height, r.height) * 0.6 + 12) continue;
      const score = along + across * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) {
      setFocus(best);
      return true;
    }
    // Nothing further that way: scroll the page so more items come into view.
    if (dir === "down" || dir === "up") scrollBy({ top: (dir === "down" ? 1 : -1) * innerHeight * 0.6, behavior: "smooth" });
    if (dir === "left" || dir === "right") (current.closest("[class*='row'],[class*='slider'],[class*='carousel']") || document.scrollingElement).scrollBy({ left: (dir === "right" ? 1 : -1) * innerWidth * 0.5, behavior: "smooth" });
    return false;
  }

  // ---------- command handler ----------
  window.__monitorosRemote = (cmd) => {
    const video = activeVideo();
    switch (cmd && cmd.type) {
      case "nav": {
        const k = cmd.key;
        if (k === "back") {
          if (document.fullscreenElement) return document.exitFullscreen();
          if (atEntry() || history.length <= 1) {
            location.href = CLOSE_URL;
            return;
          }
          return history.back();
        }
        if (k === "ok") {
          if (cursorVisible()) return clickEl(document.elementFromPoint(cx, cy));
          if (video && !current) return sendKey("space", video);
          if (current && current.isConnected) return clickEl(current);
          return sendKey("ok");
        }
        if (k === "search") {
          const s = document.querySelector('input[type="search"], input[name*="search" i], [aria-label*="search" i], [data-uia*="search" i]');
          if (s) return clickEl(s), s.focus();
          return;
        }
        // During playback the arrows belong to the player (seek / volume).
        if (video) {
          current && current.classList.remove("__mo-focus");
          current = null;
          return sendKey(k, video);
        }
        navigate(k);
        return;
      }
      case "media":
        if (cmd.action === "play-pause") {
          if (video) {
            sendKey("space", video);
            hint(video.paused ? "Paused" : "Playing");
          }
        } else if (cmd.action === "stop") {
          location.href = CLOSE_URL;
        }
        return;
      case "seek": {
        if (!video) return;
        const steps = Math.max(1, Math.min(12, Math.round(Math.abs(cmd.deltaSec) / 10)));
        for (let i = 0; i < steps; i++) sendKey(cmd.deltaSec < 0 ? "left" : "right", video);
        hint(`${cmd.deltaSec < 0 ? "−" : "+"}${Math.abs(cmd.deltaSec)}s`);
        return;
      }
      case "pointer":
        cx = Math.max(0, Math.min(innerWidth - 1, cx + cmd.dx * 1.6));
        cy = Math.max(0, Math.min(innerHeight - 1, cy + cmd.dy * 1.6));
        showCursor();
        if (cmd.click) clickEl(document.elementFromPoint(cx, cy));
        return;
      case "scroll": {
        // Scroll whatever is under the cursor (rows scroll sideways), else the page.
        let el = cursorVisible() ? document.elementFromPoint(cx, cy) : current;
        const canScroll = (n, axis) => {
          const st = getComputedStyle(n);
          const ov = axis === "x" ? st.overflowX : st.overflowY;
          return /(auto|scroll)/.test(ov) && (axis === "x" ? n.scrollWidth > n.clientWidth : n.scrollHeight > n.clientHeight);
        };
        const axis = Math.abs(cmd.dx) > Math.abs(cmd.dy) ? "x" : "y";
        while (el && el !== document.body && !canScroll(el, axis)) el = el.parentElement;
        (el && el !== document.body ? el : document.scrollingElement).scrollBy({ left: -cmd.dx * 3, top: -cmd.dy * 3 });
        return;
      }
      case "text": {
        const el = document.activeElement;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
          // Use the native setter so React/Vue-controlled inputs notice the change.
          const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(el, el.value + cmd.value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return;
      }
    }
  };
})();
