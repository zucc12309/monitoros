import { beforeEach, describe, expect, it } from "vitest";
import { keyToIntent, move, resetFocusMemory, restoreFocus, setFocusPage } from "./focus";

function build() {
  document.body.innerHTML = `
    <aside><button data-nav-row="rail" data-nav-axis="y" id="a0">H</button><button data-nav-row="rail" data-nav-axis="y" id="a1">L</button></aside>
    <nav><button data-nav-row="nav" id="n0">Home</button><button data-nav-row="nav" id="n1">Movies</button><button data-nav-row="nav" id="n2">Series</button></nav>
    <section><button data-nav-row="hero" id="h0">Watch</button><button data-nav-row="hero" id="h1">Watchlist</button></section>
    <section>${Array.from({ length: 6 }, (_, i) => `<button data-nav-row="row1" id="r${i}">${i}</button>`).join("")}</section>
    <section><button data-nav-row="row2" id="s0">a</button><button data-nav-row="row2" id="s1" disabled>b</button><button data-nav-row="row2" id="s2">c</button></section>`;
}

const active = () => document.activeElement?.id;

describe("spatial focus engine", () => {
  beforeEach(() => {
    resetFocusMemory();
    setFocusPage("home");
    build();
  });

  it("starts on the first focusable when nothing is focused", () => {
    move("down");
    expect(active()).toBe("n0");
  });

  it("moves within and between rows without wrapping", () => {
    restoreFocus();
    move("left"); // row start → side rail
    expect(active()).toBe("a0");
    move("right"); // back to where we were
    expect(active()).toBe("n0");
    move("right");
    move("right");
    expect(active()).toBe("n2");
    expect(move("right")).toBeNull();
    move("down");
    expect(active()).toMatch(/^h/);
    move("up");
    expect(active()).toBe("n2");
    expect(move("up")).toBeNull();
  });

  it("remembers the column per row", () => {
    restoreFocus();
    move("down"); // hero
    move("down"); // row1
    move("right");
    move("right");
    move("right");
    expect(active()).toBe("r3");
    move("up");
    move("down");
    expect(active()).toBe("r3");
  });

  it("skips disabled items", () => {
    restoreFocus();
    move("down");
    move("down");
    move("down");
    expect(active()).toBe("s0");
    move("right");
    expect(active()).toBe("s2");
  });

  it("restores focus per page after navigation away and back", () => {
    restoreFocus();
    move("down");
    move("down");
    move("right");
    move("right");
    setFocusPage("detail");
    build();
    restoreFocus();
    expect(active()).toBe("n0");
    setFocusPage("home");
    build();
    restoreFocus();
    expect(active()).toBe("r2");
  });

  it("treats the rail as a vertical side column", () => {
    restoreFocus();
    move("down");
    move("right");
    expect(active()).toBe("h1");
    move("left");
    move("left");
    expect(active()).toBe("a0");
    move("down");
    expect(active()).toBe("a1");
    expect(move("down")).toBeNull();
    move("right");
    expect(active()).toBe("h0");
  });

  it("remembers focus that arrived without the engine (mouse/autoFocus)", () => {
    (document.getElementById("r4") as HTMLElement).focus();
    setFocusPage("player");
    build();
    setFocusPage("home");
    build();
    restoreFocus();
    expect(active()).toBe("r4");
  });

  it("lands on a page's nominated default on first visit", () => {
    document.getElementById("h1")!.setAttribute("data-nav-default", "");
    restoreFocus();
    expect(active()).toBe("h1");
  });

  it("maps keys and TV remote codes", () => {
    expect(keyToIntent({ key: "ArrowUp", keyCode: 38 })).toBe("up");
    expect(keyToIntent({ key: "Escape", keyCode: 27 })).toBe("back");
    expect(keyToIntent({ key: "Unidentified", keyCode: 10009 })).toBe("back");
    expect(keyToIntent({ key: "MediaPlayPause", keyCode: 179 })).toBe("play-pause");
    expect(keyToIntent({ key: "a", keyCode: 65 })).toBeNull();
  });
});
