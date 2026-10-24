import { describe, expect, it } from "vitest";
import { assertSafeUrl, isSafeUrl } from "@monitoros/provider-sdk";

describe("SSRF / unsafe URL guard", () => {
  const blocked = [
    "http://example.com/x.mp4", // plain http
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>",
    "ftp://example.com/x",
    "https://localhost/manifest.json",
    "https://foo.localhost/",
    "https://printer.local/",
    "https://127.0.0.1/",
    "https://127.1/", // shorthand → 127.0.0.1
    "https://2130706433/", // decimal 127.0.0.1
    "https://0x7f000001/", // hex 127.0.0.1
    "https://10.0.0.5/",
    "https://172.20.1.1/",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://100.64.0.1/",
    "https://0.0.0.0/",
    "https://[::1]/",
    "https://[fd00::1]/",
    "https://[fe80::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://user:pass@example.com/",
    "https://intranet/",
    "https://metadata.google.internal/",
  ];

  it.each(blocked)("blocks %s", (u) => {
    expect(isSafeUrl(u, "stream")).toBe(false);
  });

  it("allows public https", () => {
    expect(isSafeUrl("https://archive.org/download/x/x.mp4", "stream")).toBe(true);
    expect(isSafeUrl("https://v3-cinemeta.strem.io/manifest.json", "addon")).toBe(true);
  });

  it("allows user-opted private sources only with explicit flags", () => {
    expect(isSafeUrl("http://192.168.1.20:8096/Videos/1/stream", "stream")).toBe(false);
    expect(isSafeUrl("http://192.168.1.20:8096/Videos/1/stream", "stream", { allowHttp: true, allowPrivateNetwork: true })).toBe(true);
  });

  it("gives an explanatory error", () => {
    expect(() => assertSafeUrl("https://10.1.1.1", "addon")).toThrow(/private/);
  });
});
