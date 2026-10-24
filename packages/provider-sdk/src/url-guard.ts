/**
 * Syntactic URL safety checks for anything a provider or add-on hands us.
 *
 * This is the first line of defence. The Rust `provider-runtime` crate is the
 * second: it re-checks after DNS resolution (DNS-rebinding) and refuses
 * redirects. Never rely on this function alone for network egress.
 */

export type UrlPurpose = "addon" | "stream" | "subtitle" | "artwork" | "external";

export class UnsafeUrlError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", "metadata.google.internal"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

export function isPrivateIPv4(host: string): boolean {
  const o = ipv4Octets(host);
  if (!o) return false;
  const [a, b] = o as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved + broadcast
  );
}

export function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  if (h === "::" || h === "::1") return true;
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULA
  if (h.startsWith("ff")) return true; // multicast
  const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);
  // WHATWG URL serialises ::ffff:a.b.c.d as ::ffff:xxxx:xxxx — block the whole mapped range.
  if (h.startsWith("::ffff:")) return true;
  return false;
}

/** Non-dotted numeric hosts (e.g. http://2130706433) are normalised by URL(); catch leftovers. */
function looksNumeric(host: string): boolean {
  return /^[0-9x.]+$/i.test(host) && !ipv4Octets(host);
}

export interface GuardOptions {
  /** Plain http is only permitted where the user explicitly opted in (e.g. their own NAS). */
  allowHttp?: boolean;
  /** Allow private-network hosts: only for user-provided sources, never add-ons. */
  allowPrivateNetwork?: boolean;
}

export function assertSafeUrl(raw: string, purpose: UrlPurpose, opts: GuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError("not a valid absolute URL", raw);
  }

  const httpOk = opts.allowHttp === true;
  if (url.protocol !== "https:" && !(httpOk && url.protocol === "http:")) {
    throw new UnsafeUrlError(`scheme ${url.protocol} is not allowed for ${purpose}`, raw);
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("credentials in URLs are not allowed", raw);
  }

  const host = url.hostname.toLowerCase();
  if (!host) throw new UnsafeUrlError("missing host", raw);

  if (!opts.allowPrivateNetwork) {
    if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
      throw new UnsafeUrlError("local hostnames are not allowed", raw);
    }
    if (isPrivateIPv4(host) || isPrivateIPv6(host) || looksNumeric(host)) {
      throw new UnsafeUrlError("private or reserved addresses are not allowed", raw);
    }
    if (!host.includes(".") && !host.includes(":")) {
      throw new UnsafeUrlError("single-label hostnames are not allowed", raw);
    }
  }
  return url;
}

export function isSafeUrl(raw: string, purpose: UrlPurpose, opts?: GuardOptions): boolean {
  try {
    assertSafeUrl(raw, purpose, opts);
    return true;
  } catch {
    return false;
  }
}
