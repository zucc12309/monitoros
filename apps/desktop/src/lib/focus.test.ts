import { beforeEach, describe, expect, it } from "vitest";
import { keyToIntent, move, resetFocusMemory, restoreFocus, setFocusPage } from "./focus";

// jsdom has no layout engine: give every element an explicit on-screen box.
type Box = [x: number, y: number, w: number, h: number];

function place(id: string, [x, y, w, h]: Box) {
  const el = document.getElementById(id)!;
  el.getBoundingClientRect = () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y, toJSON() {} }) as DOMRect;
}

function btn(id: string, row: string, extra = "") {
  return `<button id="${id}" data-nav-row="${row}" ${extra}>${id}</button>`;
}

/** A 1920×1080 home screen: rail, top nav, hero, two carousels. */
function home() {
  document.body.innerHTML = `
    <aside>${btn("a0", "rail", 'data-nav-axis="y"')}${btn("a1", "rail", 'data-nav-axis="y"')}</aside>
    <nav data-nav-region="top">${["n0", "n1", "n2"].map((id) => btn(id, "nav")).join("")}</nav>
    <main data-nav-region="main">
    <section>${btn("h0", "hero", "data-nav-default")}${btn("h1", "hero")}</section>
    <section style="overflow-x:auto">${Array.from({ length: 6 }, (_, i) => btn(`r${i}`, "row1")).join("")}</section>
    <section>${btn("s0", "row2")}${btn("s1", "row2", "disabled")}${btn("s2", "row2")}</section></main>`;
  place("a0", [10, 150, 80, 70]);
  place("a1", [10, 240, 80, 70]);
  ["n0", "n1", "n2"].forEach((id, i) => place(id, [300 + i * 120, 20, 100, 44]));
  place("h0", [180, 300, 200, 60]);
  place("h1", [400, 300, 200, 60]);
  for (let i = 0; i < 6; i++) place(`r${i}`, [150 + i * 310, 500, 290, 180]);
  place("s0", [150, 750, 290, 180]);
  place("s1", [460, 750, 290, 180]);
  place("s2", [770, 750, 290, 180]);
}

const active = () => document.activeElement?.id;

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1920, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 1080, configurable: true });
  resetFocusMemory();
  setFocusPage("home");
});

describe("spatial navigation", () => {
  it("lands on the page's nominated default first", () => {
    home();
    restoreFocus();
    expect(active()).toBe("h0");
  });

  it("moves by what's on screen: up to the nav, down into carousels, along rows", () => {
    home();
    restoreFocus();
    move("up");
    expect(active()).toBe("n0");
    expect(move("up")).toBeNull();
    move("right");
    move("right");
    expect(active()).toBe("n2");
    expect(move("right")).toBeNull();
    move("down");
    expect(active()).toBe("h1"); // nearest below n2
    move("down");
    expect(active()).toMatch(/^r/);
  });

  it("keeps the column on Down/Up and restores a carousel position", () => {
    home();
    restoreFocus();
    move("down"); // r0/r1 under the hero
    for (let i = 0; i < 6; i++) move("right");
    expect(active()).toBe("r5");
    move("up"); // hero
    move("down");
    expect(active()).toBe("r5");
  });

  it("skips disabled items", () => {
    home();
    restoreFocus();
    move("down");
    move("down");
    expect(active()).toBe("s0");
    move("right");
    expect(active()).toBe("s2");
  });

  it("treats the rail as a side column", () => {
    home();
    restoreFocus();
    move("left"); // h0 is the content's left edge
    expect(active()).toBe("a0");
    move("down");
    expect(active()).toBe("a1");
    expect(move("down")).toBeNull();
    move("right");
    expect(active()).toBe("h0");
  });

  it("crosses a two-column layout (Settings: menu left, options right) without escaping to the top bar", () => {
    document.body.innerHTML = `
      <nav data-nav-region="top">${btn("home", "topnav")}</nav>
      <main data-nav-region="main">
      <div data-nav-region="settings-menu">${["m0", "m1", "m2"].map((id) => btn(id, `menu-${id}`)).join("")}</div>
      <div data-nav-region="settings-content">${btn("o0", "subs-0")}${btn("o1", "subs-0")}${btn("o2", "subs-1")}${btn("t0", "toggle")}</div></main>`;
    // Real measurements: the top-bar pill is nearer than the first option.
    place("home", [420, 22, 100, 44]);
    ["m0", "m1", "m2"].forEach((id, i) => place(id, [140, 120 + i * 60, 250, 50]));
    place("o0", [450, 130, 200, 60]);
    place("o1", [670, 130, 200, 60]);
    place("o2", [450, 210, 200, 60]);
    place("t0", [450, 300, 700, 70]);
    document.getElementById("m0")!.focus();
    move("right");
    expect(active()).toBe("o0");
    move("down");
    expect(active()).toBe("o2");
    move("down");
    expect(active()).toBe("t0");
    expect(move("down")).toBeNull(); // last option: doesn't drop into the menu (it would switch section)
    document.getElementById("m2")!.focus(); // a low menu item: options start higher up
    move("right");
    expect(active()).toMatch(/^[ot]/);
    document.getElementById("t0")!.focus();
    move("left");
    expect(active()).toMatch(/^m/);
    move("up");
    move("up");
    move("up");
    expect(active()).toBe("home"); // the top bar is still reachable with Up
  });

  it("never jumps to another row on Left/Right", () => {
    // Apps grid at 1280×800: hoichoi alone on the last line.
    document.body.innerHTML = btn("sun", "apps-1") + btn("aha", "apps-2") + btn("hoichoi", "apps-2");
    place("sun", [523, 502, 338, 72]);
    place("aha", [900, 502, 338, 72]);
    place("hoichoi", [146, 646, 338, 72]);
    document.getElementById("hoichoi")!.focus();
    expect(move("right")).toBeNull();
    expect(active()).toBe("hoichoi");
  });

  it("walks a wrapping grid by rows and columns", () => {
    // 3 columns × 3 rows of posters
    document.body.innerHTML = Array.from({ length: 9 }, (_, i) => btn(`g${i}`, `grid-${Math.floor(i / 8)}`)).join("");
    for (let i = 0; i < 9; i++) place(`g${i}`, [100 + (i % 3) * 220, 100 + Math.floor(i / 3) * 320, 180, 290]);
    document.getElementById("g0")!.focus();
    move("down");
    expect(active()).toBe("g3");
    move("right");
    expect(active()).toBe("g4");
    move("down");
    expect(active()).toBe("g7");
    move("up");
    move("up");
    expect(active()).toBe("g1");
  });

  it("traps focus inside an open dialog", () => {
    home();
    document.body.insertAdjacentHTML("beforeend", `<div aria-modal="true">${btn("ok", "pair")}${btn("deny", "pair")}</div>`);
    place("ok", [800, 500, 150, 60]);
    place("deny", [970, 500, 150, 60]);
    restoreFocus();
    expect(active()).toBe("ok");
    move("right");
    expect(active()).toBe("deny");
    expect(move("up")).toBeNull(); // can't escape to the page behind
  });

  it("restores focus per page after navigating away and back", () => {
    home();
    restoreFocus();
    move("down");
    move("right");
    const there = active();
    setFocusPage("detail");
    home();
    restoreFocus();
    expect(active()).toBe("h0");
    setFocusPage("home");
    home();
    restoreFocus();
    expect(active()).toBe(there);
  });

  it("remembers focus that arrived by mouse/autoFocus", () => {
    home();
    document.getElementById("r4")!.focus();
    setFocusPage("player");
    home();
    setFocusPage("home");
    home();
    restoreFocus();
    expect(active()).toBe("r4");
  });

  it("maps keys and TV remote codes", () => {
    expect(keyToIntent({ key: "ArrowUp", keyCode: 38 })).toBe("up");
    expect(keyToIntent({ key: "Escape", keyCode: 27 })).toBe("back");
    expect(keyToIntent({ key: "Unidentified", keyCode: 10009 })).toBe("back");
    expect(keyToIntent({ key: "MediaPlayPause", keyCode: 179 })).toBe("play-pause");
    expect(keyToIntent({ key: "a", keyCode: 65 })).toBeNull();
  });
});
