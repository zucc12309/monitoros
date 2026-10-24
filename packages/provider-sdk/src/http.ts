/**
 * Fetch abstraction for providers. In the Tauri build this is backed by the
 * Rust `provider_fetch` command (DNS-checked, no redirects, size-capped). In
 * the browser/dev build it falls back to window.fetch with the same limits
 * enforced client-side where possible.
 */
import { assertSafeUrl, type UrlPurpose } from "./url-guard";

export type JsonFetcher = (url: string, purpose: UrlPurpose, timeoutMs: number) => Promise<unknown>;

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class ProviderTimeoutError extends Error {
  override name = "ProviderTimeoutError";
}

export const browserJsonFetcher: JsonFetcher = async (url, purpose, timeoutMs) => {
  assertSafeUrl(url, purpose);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_RESPONSE_BYTES) throw new Error("response too large");
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error("response too large");
    return JSON.parse(text) as unknown;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new ProviderTimeoutError(`timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderTimeoutError(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
