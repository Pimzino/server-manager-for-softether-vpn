# SoftEther Manager Desktop: architecture and contracts

Cross-platform (macOS + Windows) desktop app, built with Electron 44 (Node 24.21, Chromium 152). It replaces the
multi-user web server in `apps/server` + `apps/web`. Those remain in the repo only as the reference source that
the desktop app was ported from. **Never edit `apps/server` or `apps/web`.**

## Product rules

* Works like SoftEther's own **Server Manager** (vpnsmgr): the user adds a *connection setting* with a name,
  host, port (default 443), optional Virtual Hub (hub-admin mode) and the administrator password. There are no
  local accounts, logins, roles, MFA, setup tokens, API tokens or audit log. Whoever runs the app is the admin.
* Many servers side by side. The sidebar lists every saved connection and its live status.
* Passwords are stored only if "Save password" is ticked. They are encrypted with Electron `safeStorage`
  (macOS Keychain / Windows DPAPI). An unsaved password is asked for on connect and held in memory only.
* Transport per server:
  * `native` (default): SoftEther's binary PACK admin RPC over TLS, exactly what vpnsmgr and `vpncmd /SERVER` use.
    It works even when the JSON-RPC web API is disabled.
  * `jsonrpc`: the `/api/` JSON-RPC endpoint.
  Both take and return **the same JSON shapes** (JSON-RPC field names with `_str`, `_u32`, `_bin`… suffixes), so
  the UI and the catalog don't care which transport is used.
* TLS: TOFU fingerprint pinning (confirm on first connect, refuse mismatches), with `ca` and `insecure` as options.
* All existing functionality is kept: every server/hub page, API console, config backups (scheduled +
  on-demand, diff, restore), client deployment (packages, templates, hub profiles, custom profiles, `.vpn`,
  MSI, setup.exe, branding).

## Layout

```
apps/desktop/
  package.json            electron, electron-builder, esbuild, vite, react, mantine, fastify, ...
  scripts/build.mjs       esbuild main (ESM → dist/main/main.mjs) + preload (CJS → dist/preload/preload.cjs) + vite renderer
  scripts/dist.mjs        packaging (electron-builder dmg/zip for mac, win-unpacked/zip/nsis, + wixl MSI of the app)
  scripts/smoke-packaged.mjs  E2E check of the packaged macOS app over CDP against a real vpnserver (pnpm run smoke:packaged)
  vite.config.ts          renderer root = src/renderer, base "./", out dist/renderer
  src/shared/ipc.ts       types shared by main, preload and renderer (the bridge contract below)
  src/main/main.ts        app lifecycle, BrowserWindow, native menu, single instance
  src/main/ipc.ts         IPC handlers → in-process Fastify (app.inject, never listens on a port)
  src/main/core/**        ported from apps/server/src with auth/users/setup/audit/rate-limit/cookie removed
  src/main/softether/client.ts   transport dispatcher + JSON-RPC transport + certificate probe
  src/main/softether/pack.ts     PACK binary codec + JSON⇄PACK conversion (port of Mayaqua/Pack.c)
  src/main/softether/native.ts   native admin connection + RPC (port of Protocol.c / Admin.c / Remote.c client side)
  src/preload/preload.ts  contextBridge.exposeInMainWorld("sem", bridge)
  src/renderer/**         the new React UI
  build/                  icons (icon.icns, icon.ico, icon.png), entitlements
e2e-desktop/              Playwright `_electron` E2E suite against real SoftEther servers
```

Data lives in `app.getPath("userData")` (`SEM_DATA_DIR` overrides it; E2E uses this): `sem.db` (node:sqlite),
`files/` (client packages, built installers), `master.key.sealed` (32-byte key sealed with safeStorage; used for the
existing AES-GCM `seal/unseal` of stored secrets). If `safeStorage` is unavailable (Linux without keyring, tests
with `SEM_INSECURE_KEYSTORE=1`), the key is stored as plain hex with mode 600.

## Bridge contract (`src/shared/ipc.ts`)

```ts
export interface ApiRequest { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown }
export interface ApiResponse { status: number; body: unknown }
export interface FileFilter { name: string; extensions: string[] }
export interface SemBridge {
  /** REST-style call into the in-process API (same paths as apps/server, minus auth/admin/setup). */
  api(req: ApiRequest): Promise<ApiResponse>;
  /** GET `path` and save the response through a native Save dialog. The filename comes from Content-Disposition. */
  download(path: string, opts?: { suggestedName?: string }): Promise<{ saved: boolean; filePath?: string }>;
  /** Native Open dialog, then multipart POST of the chosen file to `path` (field "file", plus `fields`). null = cancelled. */
  upload(path: string, opts?: { fields?: Record<string, string>; filters?: FileFilter[]; title?: string }): Promise<ApiResponse | null>;
  /** Native Save dialog for text or base64 content produced in the renderer. */
  saveFile(opts: { suggestedName: string; content: string; encoding?: "utf8" | "base64"; filters?: FileFilter[] }): Promise<{ saved: boolean; filePath?: string }>;
  /** Native Open dialog returning a file's content (for certificate/key/config imports done in the renderer). */
  openFile(opts?: { filters?: FileFilter[]; title?: string; encoding?: "utf8" | "base64" }): Promise<{ name: string; content: string } | null>;
  openExternal(url: string): Promise<void>;
  revealPath(filePath: string): Promise<void>;
  info(): Promise<{ version: string; platform: string; arch: string; electron: string; node: string; dataDir: string }>;
  /** Native menu actions ("new-server", "preferences", "refresh", "navigate:<path>" …). Returns an unsubscribe fn. */
  onMenu(cb: (action: string) => void): () => void;
}
declare global { interface Window { sem: SemBridge } }
```

Main-process IPC channel names: `sem:api`, `sem:download`, `sem:upload`, `sem:saveFile`, `sem:openFile`,
`sem:openExternal`, `sem:revealPath`, `sem:info`, and the event `sem:menu` (main → renderer).
`openExternal` only allows `https:`/`http:`/`mailto:` URLs. The renderer runs with `contextIsolation: true`,
`sandbox: true` and `nodeIntegration: false`, under a strict CSP, and navigation away from the app is blocked.

## In-process API (Fastify, `app.inject`)

Same routes and JSON shapes as `apps/server/src/routes/*`, except:

* Removed: `/api/auth/*`, `/api/setup*`, `/api/admin/users*`, `/api/admin/audit*`, api tokens, `/metrics`,
  `/api/me`, and all role/grant/hub-scope checks. `publicServer()` no longer has `myRole`.
* Kept: `/api/catalog`, `/api/servers*` (CRUD, probe, test, `rpc/:method`, refresh), `/api/fleet*` (overview + bulk),
  `/api/servers/:id/backups*`, `/api/deploy/*`, hub deployment routes, and `/api/settings` (backup schedule,
  retention, poll interval; this was the admin settings page).
* Server record (`GET /api/servers/:id`):
  `{ id, name, host, port, hub, transport: "native"|"jsonrpc", tlsMode, fingerprint, passwordSaved: boolean,
     unlocked: boolean, tags, notes, enabled, state: { ok, error, latencyMs, checkedAt, info, status, hubs } }`
* New: `POST /api/servers/:id/unlock { password }` (session-only password when not saved) and
  `POST /api/servers/:id/lock`. An RPC against a server that is locked returns 423 `{ error, locked: true }`.
* `POST /api/servers` / `PUT /api/servers/:id` body:
  `{ name, host, port, hub?, password, savePassword, transport, tlsMode, fingerprint?, caPem?, tags?, notes? }`.
* `POST /api/servers/probe { host, port }` → certificate `{ fingerprint, subject, issuer, validFrom, validTo, selfSigned }`.
* `POST /api/servers/test { host, port, hub?, password, transport, tlsMode, fingerprint?, caPem? }` → `{ ok, info?, error?, kind? }`.
* Errors: `{ error: string, softEtherCode?: number, kind?: string, issues?: [...] }` with HTTP-style status codes.
* Uploads use multipart (`@fastify/multipart`); the bridge builds the multipart body in main.
* Downloads set `Content-Disposition: attachment; filename="..."`.

## Transport contract (`src/main/softether/client.ts`)

```ts
export type Transport = "native" | "jsonrpc";
export interface Endpoint { host; port; hub?; password; tlsMode; fingerprint?; caPem?; transport: Transport }
export async function callRpc<T>(ep: Endpoint, method: string, params?: object, timeoutMs?: number, opts?: { ephemeral?: boolean }): Promise<T>
// native.ts exports:
export async function callNativeRpc<T>(ep: Endpoint, method: string, params: Record<string, unknown>, timeoutMs: number, opts?: { ephemeral?: boolean }): Promise<T>
export function closeNativeSessions(): void
```
Errors thrown are the existing `SoftEtherError(code)` and `ConnectionError(kind)` classes, whichever transport is used.

## Renderer

React 19, Mantine 9, TanStack Query, react-router 8 using a **hash router** (file:// in production).
`src/renderer/lib/api.ts` keeps the old `api/get/post/put/del/rpc/upload/download` helpers, implemented over
`window.sem`, so ported pages keep their data logic. `useServerRole`/`can()` are gone: everything is allowed, and
dangerous RPCs get a confirmation dialog instead.

Design system: `src/renderer/design/` holds tokens, the theme, the app shell and shared components. It is
documented in `docs/desktop-design.md`. Pages must use those components rather than ad-hoc styling.
