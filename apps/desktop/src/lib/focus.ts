/**
 * Deterministic spatial navigation for remote/keyboard control.
 *
 * Every focusable element carries `data-nav-row="<rowId>"`. Rows are ordered
 * by DOM order; items within a row by DOM order. Left/Right move within a
 * row (no wrap). Up/Down move to the adjacent row, landing on that row's
 * remembered index, else the item horizontally closest to the current one,
 * else index 0. Focus per page is remembered so returning from playback or
 * another page restores it.
 *
 * A row marked `data-nav-axis="y"` (the left rail) is a vertical side column:
 * Up/Down move within it, Left from the first item of any row enters it, and
 * Right leaves it back to the last content position.
 */

export type Direction = "up" | "down" | "left" | "right";

const rowMemory = new Map<string, number>(); // `${page}|${row}` -> index
const pageMemory = new Map<string, { row: string; index: number }>();
const SIDE_KEY = "__side__";
let currentPage = "home";

export function setFocusPage(page: string) {
  currentPage = page;
}

type Row = { id: string; items: HTMLElement[]; vertical: boolean };

export function rows(root: ParentNode = document): Row[] {
  const out: Row[] = [];
  const byId = new Map<string, HTMLElement[]>();
  root.querySelectorAll<HTMLElement>("[data-nav-row]").forEach((el) => {
    if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") return;
    const id = el.dataset.navRow!;
    let list = byId.get(id);
    if (!list) {
      list = [];
      byId.set(id, list);
      out.push({ id, items: list, vertical: el.dataset.navAxis === "y" });
    }
    list.push(el);
  });
  return out;
}

function locate(el: Element | null, all: ReturnType<typeof rows>) {
  if (!el) return null;
  for (let r = 0; r < all.length; r++) {
    const i = all[r]!.items.indexOf(el as HTMLElement);
    if (i >= 0) return { r, i };
  }
  return null;
}

function centerX(el: HTMLElement) {
  const b = el.getBoundingClientRect();
  return b.left + b.width / 2;
}

function focusEl(el: HTMLElement, rowId: string, index: number, side = false) {
  rowMemory.set(`${currentPage}|${rowId}`, index);
  if (!side) pageMemory.set(currentPage, { row: rowId, index });
  el.focus({ preventScroll: true });
  el.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

/** Returns the element that received focus, or null if movement was blocked. */
export function move(dir: Direction, root: ParentNode = document): HTMLElement | null {
  const everything = rows(root);
  const side = everything.find((r) => r.vertical);
  const all = everything.filter((r) => !r.vertical);
  if (!everything.length) return null;

  if (side && side.items.includes(document.activeElement as HTMLElement)) {
    const i = side.items.indexOf(document.activeElement as HTMLElement);
    if (dir === "up" || dir === "down") {
      const ni = i + (dir === "up" ? -1 : 1);
      const el = side.items[ni];
      if (!el) return null;
      focusEl(el, side.id, ni, true);
      return el;
    }
    return dir === "right" ? restoreFocus(root) : null;
  }

  const pos = locate(document.activeElement, all);
  if (!pos) return restoreFocus(root);

  const row = all[pos.r]!;
  if (dir === "left" && pos.i === 0 && side) {
    const ni = Math.min(rowMemory.get(`${currentPage}|${side.id}`) ?? 0, side.items.length - 1);
    focusEl(side.items[ni]!, side.id, ni, true);
    return side.items[ni]!;
  }
  if (dir === "left" || dir === "right") {
    const ni = pos.i + (dir === "left" ? -1 : 1);
    const el = row.items[ni];
    if (!el) return null;
    focusEl(el, row.id, ni);
    return el;
  }

  const target = all[pos.r + (dir === "up" ? -1 : 1)];
  if (!target) return null;
  const remembered = rowMemory.get(`${currentPage}|${target.id}`);
  let ni: number;
  if (remembered !== undefined && remembered < target.items.length) ni = remembered;
  else {
    const x = centerX(row.items[pos.i]!);
    ni = 0;
    let best = Infinity;
    target.items.forEach((el, i) => {
      const d = Math.abs(centerX(el) - x);
      if (d < best) {
        best = d;
        ni = i;
      }
    });
  }
  const el = target.items[ni]!;
  focusEl(el, target.id, ni);
  return el;
}

/** Restore the last focus for the current page, falling back to the first item. */
export function restoreFocus(root: ParentNode = document): HTMLElement | null {
  const all = rows(root).filter((r) => !r.vertical);
  if (!all.length) return null;
  const mem = pageMemory.get(currentPage);
  if (!mem) {
    // First visit: a page may nominate its primary action (e.g. hero "Watch Now").
    const preferred = (root as ParentNode).querySelector<HTMLElement>("[data-nav-default]");
    const prow = preferred && all.find((r) => r.items.includes(preferred));
    if (preferred && prow) {
      focusEl(preferred, prow.id, prow.items.indexOf(preferred));
      return preferred;
    }
  }
  const row = (mem && all.find((r) => r.id === mem.row)) || all[0]!;
  const index = mem && row.id === mem.row ? Math.min(mem.index, row.items.length - 1) : 0;
  const el = row.items[index]!;
  focusEl(el, row.id, index);
  return el;
}

/** Record focus that arrived by mouse, autoFocus or code, so restore is accurate. */
export function rememberElement(el: Element | null, root: ParentNode = document) {
  if (!(el instanceof HTMLElement) || !el.dataset.navRow) return;
  const all = rows(root);
  const row = all.find((r) => r.items.includes(el));
  if (!row) return;
  const index = row.items.indexOf(el);
  rowMemory.set(`${currentPage}|${row.id}`, index);
  if (!row.vertical) pageMemory.set(currentPage, { row: row.id, index });
}

if (typeof document !== "undefined") {
  document.addEventListener("focusin", (e) => rememberElement(e.target as Element));
}

export function resetFocusMemory() {
  rowMemory.clear();
  pageMemory.clear();
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
