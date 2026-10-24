/**
 * Spatial navigation for remote/keyboard control.
 *
 * Every focusable element carries `data-nav-row="<group>"`. Movement is
 * decided by on-screen geometry (like Android TV's FocusFinder), so any
 * layout works: carousels, wrapping grids, two-column Settings, dialogs.
 *
 *  - Candidates must lie in the pressed direction. Those overlapping the
 *    current item across that axis ("in the beam") win; otherwise the
 *    nearest item in that general direction is used.
 *  - Up/Down keep a sticky column (x), so Down-Down-Up-Up returns to the
 *    same place; landing in a carousel you visited restores its position.
 *  - Zones (`data-nav-region`, nestable): the current zone is searched
 *    first. Left/Right may then try sibling zones (Settings menu ↔ options)
 *    but never jump to the top bar; Up/Down may leave a zone only to an
 *    item lined up with it, except between the top bar and the page.
 *  - A group marked `data-nav-axis="y"` (the left rail) is a side column:
 *    Up/Down move within it, Left from the content's left edge enters it,
 *    Right returns to the last content position.
 *  - An open `[aria-modal="true"]` dialog traps focus.
 *  - Focus per page is remembered so returning from playback restores it.
 */

export type Direction = "up" | "down" | "left" | "right";

const rowMemory = new Map<string, number>(); // `${page}|${group}` -> index in group
const pageMemory = new Map<string, { row: string; index: number }>();
let currentPage = "home";
let anchorX: number | null = null; // sticky column for vertical moves

export function setFocusPage(page: string) {
  currentPage = page;
  anchorX = null;
}

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

const rectOf = (el: Element): Rect => el.getBoundingClientRect();
const cx = (r: Rect) => r.left + r.width / 2;
const cy = (r: Rect) => r.top + r.height / 2;

function scopeRoot(root: ParentNode): ParentNode {
  // An open dialog (pairing, errors) owns the D-pad until it closes.
  const modals = root.querySelectorAll<HTMLElement>('[aria-modal="true"]');
  return modals.length ? modals[modals.length - 1]! : root;
}

function navigable(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled") || el.closest('[aria-hidden="true"]')) return false;
  const r = rectOf(el);
  return r.width > 0 && r.height > 0;
}

export function focusables(root: ParentNode = document): HTMLElement[] {
  return [...scopeRoot(root).querySelectorAll<HTMLElement>("[data-nav-row]")].filter(navigable);
}

const isSide = (el: HTMLElement) => el.dataset.navAxis === "y";
const regionOf = (el: HTMLElement) => el.closest("[data-nav-region]");
const parentRegion = (z: Element | null) => z?.parentElement?.closest("[data-nav-region]") ?? null;
const isRootRegion = (z: Element | null) => !!z && !parentRegion(z);
/** Top-level zone containing `z` (top bar or page). */
function rootRegion(z: Element | null): Element | null {
  let cur = z;
  while (cur && parentRegion(cur)) cur = parentRegion(cur);
  return cur;
}

function overlaps(a: Rect, b: Rect, vertical: boolean) {
  return vertical ? Math.min(a.right, b.right) > Math.max(a.left, b.left) : Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
}

/** Item lives in a horizontally scrolling row (Netflix-style carousel). */
function inCarousel(el: HTMLElement): boolean {
  const p = el.parentElement;
  if (!p || typeof getComputedStyle === "undefined") return false;
  const o = getComputedStyle(p).overflowX;
  return o === "auto" || o === "scroll";
}

/** Index of `el` within its group, in DOM order (stable across re-renders). */
function groupIndex(el: HTMLElement, all: HTMLElement[]) {
  const group = all.filter((e) => e.dataset.navRow === el.dataset.navRow);
  return { group, index: group.indexOf(el) };
}

function focusEl(el: HTMLElement, all: HTMLElement[]) {
  const { index } = groupIndex(el, all);
  const row = el.dataset.navRow!;
  rowMemory.set(`${currentPage}|${row}`, index);
  if (!isSide(el)) pageMemory.set(currentPage, { row, index });
  el.focus({ preventScroll: true });
  el.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

/**
 * Picks the best candidate from `from` in `dir`, or null. Exported for tests.
 * Follows Android's FocusFinder: candidates overlapping the source across the
 * direction ("in the beam") beat others (always, for Left/Right; for Up/Down
 * unless the other is clearly nearer), then 13·major² + minor² decides.
 * `column` is the sticky x used as the minor-axis reference on Up/Down.
 */
export function findInDirection(from: Rect, dir: Direction, candidates: { el: HTMLElement; r: Rect }[], column: number | null = null, sameRowOnly = true) {
  const vertical = dir === "up" || dir === "down";
  const major = (r: Rect) =>
    Math.max(0, dir === "down" ? r.top - from.bottom : dir === "up" ? from.top - r.bottom : dir === "right" ? r.left - from.right : from.left - r.right);
  const majorFar = (r: Rect) =>
    Math.max(1, dir === "down" ? r.bottom - from.bottom : dir === "up" ? from.top - r.top : dir === "right" ? r.right - from.right : from.left - r.left);
  const gap = (r: Rect) =>
    vertical
      ? Math.max(0, Math.max(r.left, from.left) - Math.min(r.right, from.right))
      : Math.max(0, Math.max(r.top, from.top) - Math.min(r.bottom, from.bottom));
  const minor = (r: Rect) => (vertical ? Math.abs(cx(r) - (column ?? cx(from))) : Math.abs(cy(r) - cy(from)));

  const valid = candidates.filter(({ r }) => {
    // On the correct side (small tolerance for touching/overlapping edges)...
    const edge = dir === "down" ? r.top - from.bottom : dir === "up" ? from.top - r.bottom : dir === "right" ? r.left - from.right : from.left - r.right;
    const tol = (vertical ? Math.min(from.height, r.height) : Math.min(from.width, r.width)) * 0.3;
    if (edge < -tol) return false;
    // ...with its centre moving the right way...
    if (dir === "down" ? cy(r) <= cy(from) : dir === "up" ? cy(r) >= cy(from) : dir === "right" ? cx(r) <= cx(from) : cx(r) >= cx(from)) return false;
    // ...and Left/Right never leap to another row (at most a slight offset).
    if (sameRowOnly && !vertical && gap(r) > Math.min(from.height, r.height) * 0.5) return false;
    return true;
  });

  const beats = (a: Rect, b: Rect) => {
    const aBeam = gap(a) === 0;
    const bBeam = gap(b) === 0;
    if (aBeam !== bBeam) {
      if (!vertical) return aBeam; // same row always wins sideways
      // Up/Down: in-line wins unless the other is clearly nearer.
      if (aBeam) return major(a) < majorFar(b);
      return !(major(b) < majorFar(a));
    }
    const score = (r: Rect) => 13 * major(r) ** 2 + minor(r) ** 2;
    return score(a) < score(b);
  };

  let best: { el: HTMLElement; r: Rect } | null = null;
  for (const c of valid) if (!best || beats(c.r, best.r)) best = c;
  return best?.el ?? null;
}

/** Returns the element that received focus, or null if movement was blocked. */
export function move(dir: Direction, root: ParentNode = document): HTMLElement | null {
  const all = focusables(root);
  if (!all.length) return null;
  const side = all.filter(isSide);
  const content = all.filter((e) => !isSide(e));
  const active = document.activeElement as HTMLElement | null;

  // In the side rail.
  if (active && side.includes(active)) {
    if (dir === "up" || dir === "down") {
      const el = side[side.indexOf(active) + (dir === "up" ? -1 : 1)];
      if (!el) return null;
      focusEl(el, all);
      return el;
    }
    return dir === "right" ? restoreFocus(root) : null;
  }

  if (!active || !content.includes(active)) return restoreFocus(root);

  const from = rectOf(active);
  if (dir === "left" || dir === "right") anchorX = null;
  const column = dir === "up" || dir === "down" ? (anchorX ??= cx(from)) : null;
  const vertical = dir === "up" || dir === "down";
  const region = regionOf(active);
  const others = content.filter((e) => e !== active).map((el) => ({ el, r: rectOf(el), z: regionOf(el) }));
  // 1) the current zone
  let target = findInDirection(from, dir, others.filter((c) => c.z === region), column);
  // 2) other zones
  if (!target) {
    const reachable = others.filter((c) => {
      if (c.z === region) return false;
      // Up/Down between top bar and page: always. Within the page, between
      // nested zones (Settings menu ↔ options): only to something lined up.
      if (vertical) return rootRegion(c.z) !== rootRegion(region) || overlaps(from, c.r, true);
      return parentRegion(c.z) === parentRegion(region) && !(isRootRegion(c.z) && isRootRegion(region));
    });
    // Hopping to a neighbouring column (Settings menu → options) may land on
    // a different height; within one zone, sideways moves stay in the row.
    target = findInDirection(from, dir, reachable, column, vertical);
  }

  if (!target && dir === "left" && side.length) {
    // Content's left edge: hop into the rail at its remembered position.
    const remembered = rowMemory.get(`${currentPage}|${side[0]!.dataset.navRow}`) ?? 0;
    target = side[Math.min(remembered, side.length - 1)]!;
  }
  if (!target) return null;

  // Entering a scrolling carousel we've visited before: restore where we
  // were in it, as long as that item is still on screen horizontally.
  if ((dir === "up" || dir === "down") && target.dataset.navRow !== active.dataset.navRow && inCarousel(target)) {
    const remembered = rowMemory.get(`${currentPage}|${target.dataset.navRow}`);
    const { group } = groupIndex(target, all);
    const prev = remembered !== undefined ? group[remembered] : undefined;
    if (prev && prev !== target) {
      const pr = rectOf(prev);
      const tr = rectOf(target);
      const sameLine = Math.abs(cy(pr) - cy(tr)) < tr.height / 2;
      const vw = typeof window !== "undefined" ? window.innerWidth : Infinity;
      if (sameLine && pr.right > 0 && pr.left < vw) {
        target = prev;
        anchorX = cx(pr);
      }
    }
  }

  focusEl(target, all);
  return target;
}

/** Restore the last focus for the current page, falling back to the first item. */
export function restoreFocus(root: ParentNode = document): HTMLElement | null {
  const all = focusables(root);
  const content = all.filter((e) => !isSide(e));
  if (!content.length) return null;
  const mem = pageMemory.get(currentPage);
  let el: HTMLElement | undefined;
  if (mem) {
    const group = content.filter((e) => e.dataset.navRow === mem.row);
    el = group[Math.min(mem.index, group.length - 1)];
  }
  // First visit: a page may nominate its primary action (e.g. hero "Watch Now").
  el ??= content.find((e) => e.hasAttribute("data-nav-default"));
  // Otherwise the top-left item in reading order.
  el ??= [...content].sort((a, b) => {
    const ra = rectOf(a), rb = rectOf(b);
    return Math.abs(ra.top - rb.top) > 4 ? ra.top - rb.top : ra.left - rb.left;
  })[0]!;
  focusEl(el, all);
  return el;
}

/** Record focus that arrived by mouse, autoFocus or code, so restore is accurate. */
export function rememberElement(el: Element | null, root: ParentNode = document) {
  if (!(el instanceof HTMLElement) || !el.dataset.navRow) return;
  const all = focusables(root);
  const { index } = groupIndex(el, all);
  if (index < 0) return;
  rowMemory.set(`${currentPage}|${el.dataset.navRow}`, index);
  if (!isSide(el)) pageMemory.set(currentPage, { row: el.dataset.navRow, index });
}

if (typeof document !== "undefined") {
  document.addEventListener("focusin", (e) => rememberElement(e.target as Element));
}

export function resetFocusMemory() {
  rowMemory.clear();
  pageMemory.clear();
  anchorX = null;
}

export type NavIntent = Direction | "ok" | "back" | "home" | "search" | "play-pause";

/** Maps keyboard / media keys / TV-remote keycodes to intents. */
export function keyToIntent(e: Pick<KeyboardEvent, "key" | "keyCode">): NavIntent | null {
  switch (e.key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "Enter":
    case "Select":
      return "ok";
    case "Escape":
    case "Backspace":
    case "BrowserBack":
    case "GoBack":
      return "back";
    case "Home":
    case "BrowserHome":
      return "home";
    case "/":
    case "BrowserSearch":
      return "search";
    case "MediaPlayPause":
    case " ":
      return "play-pause";
  }
  // Some TV/BT remotes send keyCode 10009 (Tizen back) or 461 (webOS back)
  if (e.keyCode === 10009 || e.keyCode === 461) return "back";
  return null;
}
