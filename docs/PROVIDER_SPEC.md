# Provider specification

MonitorOS supports two kinds of providers.

## 1. Built-in providers (TypeScript)

Implement `ContentProvider` from `@monitoros/contracts`:

```ts
interface ContentProvider {
  id: string; name: string;
  category: "subscription" | "free-avod" | "public-broadcast" | "public-domain" | "user-source" | "addon";
  capabilities: ProviderCapabilities;
  catalog?(req: CatalogRequest): Promise<MediaItem[]>;
  search(query: string): Promise<MediaItem[]>;
  getMetadata(id: string, type: MediaType): Promise<MediaItem>;
  getStreams(item: MediaItem, episode?: EpisodeReference): Promise<PlaybackSource[]>;
  healthCheck(): Promise<ProviderHealth>;
}
```

Rules:

- **Network:** all requests go through the injected `JsonFetcher`, never `fetch` directly. In the desktop app that is the Rust `provider_fetch_json` command:
  - https only
  - every resolved IP is checked and the connection pinned
  - no redirects
  - 5 MiB and 20 s caps
- **Provenance:** every `PlaybackSource` declares `provenance` (`official-provider`, `public-domain`, `creative-commons`, `user-provided`, `third-party-addon`, `unverified`) and `access` (`free`, `free-with-ads`, `subscription`, `rent-or-buy`, `local`, `unknown`).
  - Never upgrade a claim you can't verify.
  - Internet Archive re-checks the item licence before returning streams.
- **Metadata ≠ availability:** a provider that only knows metadata returns `availability: []`.
- **Identifiers:** prefer IMDb or TMDB ids. `canonicalId()` builds `imdb:tt…`, `tmdb:movie:123`, `local:<hash>`, or `<provider>:<id>`.

Example: `packages/metadata/src/internet-archive.ts`.

## 2. Stremio-compatible add-ons (remote, declarative)

Install a manifest URL in Settings › Add-ons. Accepted inputs:

- `stremio://…`
- `https://…/manifest.json`
- a bare base URL

Supported resources:

- `catalog` (with `search`, `genre`, `skip` extras)
- `meta`
- `stream`
- `subtitles` (listed in capabilities; ingestion planned)

Validation (`validateManifest`):

- `id` matches `[A-Za-z0-9._-]{1,128}`; `version` is semver; `name`, `resources` and `types` are required.
- At most 100 catalogs. Unknown fields are **dropped**.
- `behaviorHints.adult` add-ons are refused.

Stream normalization (`normalizeStreams`):

| Add-on field | Result |
|---|---|
| `url` (https, public) | `direct` / `hls` (`.m3u8`) / `dash` (`.mpd`) |
| `ytId` (11 chars) | `external-browser` → youtube.com |
| `externalUrl` (https) | `external-browser` |
| `infoHash` | **dropped** (no P2P) |
| anything failing the URL guard | **dropped** |

Subtitles must be https and public. At most 50 subtitles and 200 streams are kept.

Add-on streams default to `provenance: "third-party-addon"`. They are **hidden** unless the user enables "Show unverified add-on sources", and even then they are never auto-selected.

## Writing a new add-on

Any server implementing the Stremio add-on protocol works. The official SDK is at <https://github.com/Stremio/stremio-addon-sdk>. Serve it over https, return CORS headers, and don't redirect.
