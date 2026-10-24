import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedToItem, SEED, CATALOG_TTL } from "@monitoros/metadata";
import { cinemeta, useTagItems, useTypeItems } from "./catalog";
vi.mock("./bridge", () => ({ fetchJson: vi.fn(), loadState: async (_k: string, fallback: unknown) => fallback, saveState: async () => {} }));
const item = (id: string) => ({ ...seedToItem(SEED[0]!), id, title: id, ids: { provider: { test: id } } });
beforeEach(() => { vi.spyOn(cinemeta, "cachedCatalog").mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("catalog browsing", () => {
  it("appends pages, deduplicates overlapping titles, and stops on an empty page", async () => {
    const fetch = vi.spyOn(cinemeta, "catalog")
      .mockResolvedValueOnce({ items: [item("a"), item("b")], nextSkip: 50 })
      .mockResolvedValueOnce({ items: [item("b"), item("c")], nextSkip: 100 })
      .mockResolvedValueOnce({ items: [], nextSkip: null });
    const { result } = renderHook(() => useTypeItems("movie"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { result.current.loadMore(); result.current.loadMore(); });
    await waitFor(() => expect(result.current.items.map(i => i.id)).toEqual(["a", "b", "c"]));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0].skip).toBe(50);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.hasMore).toBe(false));
    expect(result.current.items).toHaveLength(3);
  });

  it("preserves loaded pages on failure and retries the same offset", async () => {
    const fetch = vi.spyOn(cinemeta, "catalog").mockResolvedValueOnce({ items: [item("a")], nextSkip: 50 }).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ items: [item("b")], nextSkip: 100 });
    const { result } = renderHook(() => useTypeItems("movie"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).toContain("Couldn't"));
    expect(result.current.items.map(i => i.id)).toEqual(["a"]);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(fetch.mock.calls[2]?.[0].skip).toBe(50);
  });

  it("ignores responses from a previous browse category", async () => {
    let resolve!: (v: { items: ReturnType<typeof item>[]; nextSkip: null }) => void;
    vi.spyOn(cinemeta, "catalog").mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValue({ items: [item("show")], nextSkip: null });
    const { result, rerender } = renderHook(({ kind }: { kind: "movie" | "series" }) => useTypeItems(kind), { initialProps: { kind: "movie" } });
    await waitFor(() => expect(resolve).toBeDefined());
    rerender({ kind: "series" });
    await waitFor(() => expect(result.current.items[0]?.id).toBe("show"));
    await act(async () => resolve({ items: [item("old movie")], nextSkip: null }));
    expect(result.current.items[0]?.id).toBe("show");
  });

  it("shows persistent cached titles while revalidation is pending", async () => {
    vi.mocked(cinemeta.cachedCatalog).mockResolvedValue({ items: [item("cached")], nextSkip: 50, stale: true });
    vi.spyOn(cinemeta, "catalog").mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useTypeItems("movie"));
    await waitFor(() => expect(result.current.items[0]?.id).toBe("cached"));
    expect(result.current.loading).toBe(true);
  });

  it("refreshes mounted catalogs when their TTL expires", async () => {
    vi.useFakeTimers();
    vi.spyOn(cinemeta, "catalog").mockResolvedValueOnce({ items: [item("old")], nextSkip: 50 }).mockResolvedValue({ items: [item("new")], nextSkip: 50 });
    const { result } = renderHook(() => useTypeItems("movie"));
    await act(async () => {});
    expect(result.current.items[0]?.id).toBe("old");
    await act(async () => { await vi.advanceTimersByTimeAsync(CATALOG_TTL); });
    expect(result.current.items[0]?.id).toBe("new");
  });

  it("interleaves current-year movies and series in the new releases row", async () => {
    const fetch = vi.spyOn(cinemeta, "catalog").mockImplementation(async q => ({ items: [item(q.type + "1"), item(q.type + "2")], nextSkip: 50 }));
    const { result } = renderHook(() => useTagItems("recent", 4));
    await waitFor(() => expect(result.current.map(i => i.id)).toEqual(["movie1", "series1", "movie2", "series2"]));
    expect(fetch.mock.calls[0]?.[0]).toMatchObject({ catalog: "year", year: new Date().getFullYear() });
  });
});
