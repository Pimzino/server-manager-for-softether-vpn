# SoftEther Manager Desktop: design system and page porting guide

This is the contract for everything drawn in `apps/desktop/src/renderer`. It covers the principles, the tokens,
the shared components, layout and state patterns, dangerous-action confirmations, copy, and a step-by-step guide
for porting a page from `apps/web`. Read it before you write or port a page.

Reference implementation: `pages/server/Overview.tsx` (a server page) and `pages/Fleet.tsx` (a global page).
Screenshots of every screen of the real app, in light and dark mode, are in `apps/desktop/design-screenshots/final/`.

---

## 1. Principles

1. **It's a Mac or Windows app, not a web page.** There's no page chrome, hero banner, card grid or footer.
   The window has a translucent source-list sidebar and a toolbar, and content sits on one plain surface.
   Text is 13 px and controls are 26 px tall.
2. **Structure comes from separators, not boxes.** Sections are separated by space and hairlines. Use a grouped
   box (`Section variant="inset"`, `FormSection`) only for related properties or settings, the way System
   Settings does. Never nest boxes.
3. **Dense but calm.** Tables use 26 px rows with alternating row tints and no cell borders. Numbers use tabular
   figures and are right-aligned. Show secondary facts in secondary colour, not smaller type.
4. **One accent, used sparingly.** The system blue marks selection, primary buttons and focus, and nothing else.
   Status colours (green, red, orange) always come with text or a label.
5. **Everything reachable by keyboard.** Every page appears in the scope navigation, the toolbar section menu and
   the quick switcher (⌘K). Tables work with arrow keys and Enter. Every dialog closes with Esc.
6. **Ask before you break things.** RBAC is gone. Every RPC the catalog marks `danger` is confirmed, and
   irreversible ones need the object's name typed first (§6).
7. **Say what happened and what to do next.** Errors show a plain title, the server's own message, the SoftEther
   error code and a next step (§7, §8).

---

## 2. Window and shell

```
┌──────────────┬───────────────────────────────────────────────────────────────┐
│ ● ● ●     ▯  │ ‹ ›  ▯  ● Tokyo HQ                               ⟳   ⌕   +    │  toolbar 52 px (44 on Windows), draggable
│ Overview     ├──────────────┬────────────────────────────────────────────────┤
│ Client Depl. │ SERVER       │ Overview                    [Edit Connection…] │
│ SERVERS    + │ ▸ Overview   │ ● Online · vpn-tokyo:443 · Version 4.44        │
│ ▾ ● Tokyo HQ │   Virtual Hub│ ┌ metrics ───────────────────────────────────┐ │
│     DEFAULT  │ NETWORK      │ Connection            Server                   │
│     SALES 12 │   Listeners  │ ┌──────────────┐     ┌──────────────┐          │
│ ▸ ● Frankfurt│ …            │ Virtual Hubs  (table)                          │
│ ⚙ Preferences│              │                                                │
└──────────────┴──────────────┴────────────────────────────────────────────────┘
   sidebar 248   scope nav 228   content (max 1120 wide, 28 px side padding)
```

* **Sidebar** (`design/Sidebar.tsx`). It lists global places (Overview, Client Deployment), then every saved
  connection sorted by name, then Preferences in the footer.
  * A server row shows a server glyph with a status dot, the name, the host (`:port` when it isn't 443), a `HUB`
    badge in hub-admin mode, and a lock when the password isn't saved (orange = locked, grey = unlocked for this
    session).
  * The disclosure triangle expands a server into its Virtual Hubs. Hub rows show a session count, or "Offline".
    The expanded state is remembered.
  * Right-clicking a server offers Open, Edit Connection…, Refresh Status, Unlock… or Lock, Copy Address and
    Delete Connection….
  * Hide the sidebar with ⌥⌘S or the toolbar button.
* **Toolbar** (`design/WindowToolbar.tsx`). It holds Back/Forward and the "Hide Sections" toggle. Its title names
  the *object* you're in (server with a status dot and `host:port`, hub with "Virtual Hub on …", or Client
  Deployment). On global pages the title is empty. On the right are Refresh (⌘R), Go to… (⌘K) and
  New Connection (⌘N).
* **Scope navigation** (`design/ScopeNav.tsx`). This is the second column: the pages of the current server, hub
  or Client Deployment, grouped under small headings, generated from `sections.tsx`. Hub-admin connections only
  list the `hubAdminOk` pages. When hidden, the toolbar title becomes a menu with the same entries, so every page
  stays reachable.
* **Content** (`pages/Scopes.tsx` → `ContentArea`). The scope layout already wraps each page in the scroll
  container and `<Page>` padding. **Pages render only their content**: a `PageHeader`, then sections. Don't add
  your own padding or outer scroll.
* **Platform.** `html[data-platform]` is set from `window.sem.info().platform`, and `html[data-shell]` is
  `electron` or `browser` (the dev mock).
  * macOS leaves 78 px for the traffic lights at (18, 18) in the sidebar header.
  * Windows uses a 44 px toolbar and leaves 140 px on the right for the `titleBarOverlay` caption buttons.
  * Header areas carry `.sem-drag`. Buttons, inputs, links and menus inside them are automatically `no-drag`.

**What the main process must set** (not owned by the renderer):

| Setting | macOS | Windows |
|---|---|---|
| `titleBarStyle` | `hiddenInset`, `trafficLightPosition {x:18,y:18}` | `hidden` |
| Material | `vibrancy: "sidebar"`, `visualEffectState: "active"` | `backgroundMaterial: "mica"` |
| `backgroundColor` | `#00000000` (the body is transparent; the content area paints itself) | `#00000000` |
| `titleBarOverlay` | – | `{ height: 44, color: "#ffffff", symbolColor: "#1d1d1f" }` light, `{ color: "#1e1e20", symbolColor: "#e6e6e8" }` dark (update on `nativeTheme` changes) |
| Menu → renderer actions | `new-server`, `edit-server`, `preferences`, `refresh`, `quick-open`, `toggle-sidebar`, `toggle-sections`, `bulk`, `find`, `back`, `forward`, `navigate:<hash path>` | same |

The renderer also binds ⌘/Ctrl + N , R K F [ ] and ⌥⌘S itself. If a native accelerator and the renderer both fire,
repeats within 300 ms are dropped.

`design-screenshots/electron/chrome-main.mjs` is a scratch main process with exactly these window options. It
loads the dev renderer (`?shell=electron`) and screenshots the real window, including traffic lights and vibrancy.

---

## 3. Tokens (`design/tokens.css`, mapped into Mantine by `design/theme.ts`)

Never hard-code a colour, size or duration in a page. Use a token (`var(--sem-…)`), a Mantine prop that maps to
one (`size="sm"`, `c="dimmed"`), or a design component.

### Colour (light / dark)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--sem-accent` | `#007aff` | `#0a84ff` | Focus ring, icons in selection, meters, small accents |
| `--sem-selection` | `#0060db` | `#0a5fd8` | Filled selection with white text (scope nav, table rows, menus). 5.7:1 |
| `--sem-accent-text` | `#0064d2` | `#4aa3ff` | Links, accent-coloured text |
| `--sem-accent-soft` | 11 % blue | 20 % blue | Chip / tag backgrounds |
| `--sem-text` | `#1d1d1f` | white 90 % | Body text |
| `--sem-text-2` | black 58 % | white 58 % | Secondary text, labels, descriptions. ≥ 5.2:1 |
| `--sem-text-3` | black 38 % | white 36 % | **Placeholders, disabled, decoration only.** Fails AA for text |
| `--sem-bg-content` | `#ffffff` | `#1e1e20` | Content, toolbar, tables |
| `--sem-bg-scope` | `#fafafb` | `#232326` | Scope navigation column |
| `--sem-bg-inset` | `#f6f6f8` | `#252528` | Grouped boxes, metric strips |
| `--sem-bg-elevated` | `#ffffff` | `#2a2a2d` | Dialogs, sheets, menus, inspector |
| `--sem-bg-sidebar` | 92 % grey | 94 % grey | Sidebar **only without vibrancy** (browser/Linux) |
| `--sem-bg-code` | `#f5f5f7` | `#28282b` | Code, JSON, fingerprints |
| `--sem-fill-hover` / `-pressed` / `-selected` | 4.5 / 8.5 / 7.5 % black | 5.5 / 10 / 9 % white | Row and button states |
| `--sem-row-alt` | 2.2 % | 2.8 % | Alternating table rows |
| `--sem-separator` / `-strong` | 8.5 / 14 % | 8.5 / 15 % | Hairlines (0.5 px) |
| `--sem-border-control` | 20 % | 13 % | Input and button borders |
| `--sem-{green,red,orange,yellow,purple,teal,gray}` | AA text colours (≥ 4.6:1 even on their own `-soft` tint over any surface) | lighter for dark (same rule) | Status *text*, `Tag` text |
| `--sem-{…}-dot` | system colours | system colours | Status dots, meters |
| `--sem-{…}-soft` | 11–18 % tints | 11–20 % tints | Callouts, tags, error panels |

Purple means hub-admin mode. Yellow/orange means locked or needs attention. Red means offline or failed.
Green means online or succeeded. Grey means off, disabled or unknown.

### Typography

System font stack: `-apple-system, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui`. Monospace:
`ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas`.

| Token | Size | Weight | Use |
|---|---|---|---|
| `--sem-fz-caption` | 11 | 500–600 | Group headings, tags, footnotes, metric labels |
| `--sem-fz-small` | 12 | 400 | Descriptions, table headers, secondary lines |
| `--sem-fz-body` | 13 | 400 / 600 | Everything else (Mantine `md`) |
| `--sem-fz-headline` | 15 | 600 | Dialog and sheet titles, toolbar title |
| metric value | 20 | 600 | `Metric` |
| `--sem-fz-title2` | 22 | 700 | Page title (`PageHeader`) |
| `--sem-fz-title1` | 28 | 700 | Welcome screen only |

Mantine's font sizes map to xs 11, sm 12, md 13, lg 15 and xl 17. Headings h1–h6 map to 22, 17, 15, 13, 12 and 11.

### Spacing, radii, elevation, motion

* **Spacing:** 4 px grid (`--sem-space-1…10` = 2, 4, 6, 8, 12, 16, 20, 24, 32, 48). Mantine spacing: xs 4, sm 8,
  md 12, lg 16, xl 24. Page padding: 20 px top, 28 px sides. Sections are 26 px apart.
* **Radii:** xs 3 (tags), sm 5 (rows, controls in lists), md 6 (buttons, inputs; Mantine default), lg 9
  (grouped boxes, tables, menus), xl 12 (dialogs, sheets).
* **Controls:** height 22 (`xs`), 26 (`sm`, default), 30 (`md`), 36 (`lg`). Buttons and inputs default to `sm`.
  Checkboxes and radios are `xs`.
* **Elevation:** `--sem-shadow-1` (controls), `-2` (menus, toasts, tooltips), `-3` (dialogs, sheets, quick switcher).
  Surfaces in the window are flat.
* **Motion:** 100 ms (hover), 180 ms (disclosure, collapse), 260 ms (sidebar and inspector slide), easing
  `cubic-bezier(.2,0,0,1)`. `prefers-reduced-motion` sets all durations to 0. Nothing animates on load.
* **High contrast:** `prefers-contrast: more` darkens separators and secondary text.

---

## 4. Components (`import { … } from "../../design"`)

All components live in `src/renderer/design/` and are re-exported from `design/index.ts`. Use Mantine inputs
(`TextInput`, `Select`, `NumberInput`, `Switch`, `Checkbox`, `SegmentedControl`, `Textarea`, `TagsInput`…) and
`Button`/`Menu`/`Tooltip` directly: the theme already makes them native-sized.

### Page structure

| Component | Props | Notes |
|---|---|---|
| `PageHeader` | `title`, `meta?`, `description?`, `actions?`, `badge?`, `icon?`, `testId?` | One per page. `title` = the section name ("Users"). `meta` = one line of facts. `actions` = buttons, primary last. |
| `Section` | `title?`, `description?`, `actions?`, `variant?: "plain" \| "inset"`, `flush?`, `testId?`, `id?` | `plain` = heading and content. `inset` = grouped box, for property lists. `flush` removes the box padding. |
| `SectionGrid` | `columns?: 2 \| 3` | Side-by-side sections; one column under 1080 px. |
| `PropertyList` | `items?: {label, value, hint?, mono?}[]` or `rows?: [label, value][]`, `labelWidth?` (200), `dense?`, `testId?` | Read-only key/value pairs. Empty values show "–". |
| `KeyValue` | `rows` | Web-compatible alias of `PropertyList`. |
| `MetricGrid` / `Metric` | grid: `min?` (column min width, 150); metric: `label`, `value`, `hint?`, `tone?: "red" \| "orange" \| "green"`, `onClick?`, `testId?` | Replaces the web's `StatCard`. A flat strip of numbers, not cards. |
| `Meter` | `value`, `max`, `label?`, `detail?` | Used / total. Turns orange above 75 % and red above 90 %. No bar when `max` is 0 (not reported); say so in `detail`. |
| `Mono`, `Dim`, `Shortcut` | `Mono dim?`; `Shortcut keys={["mod","N"]}` | Inline helpers. `Shortcut` renders ⌘N on a Mac and Ctrl+N on Windows. |

### Data

| Component | Key props | Notes |
|---|---|---|
| `DataTable<T>` | `data`, `columns: Column<T>[]`, `rowKey`, `loading?`, `error?`, `onRetry?`, `searchable?` (true), `searchPlaceholder?`, `filterFn?`, `filters?` (controls after the filter field), `toolbar?` (right-side actions), `empty?` (node, or `{title, description?, action?, icon?}`), `onRowOpen?` (double-click / Enter), `onRowClick?` (legacy single click), `initialSort?`, `maxHeight?` (inner scroll), `selectable?: "single" \| "multi"`, `selection?` + `onSelectionChange?(keys, rows)`, `contextMenu?(row, selectedRows) → ContextMenuItem[]`, `rowTestId?`, `rowTone?(row) → "dim" \| "danger" \| "warning"`, `footer?` (true), `testId?`, `aria-label?` | `Column<T>`: `key`, `title`, `render?`, `value?` (sorting and filtering), `sortable?` (true), `width?`, `align?`, `mono?`, `truncate?`, `wrap?`. Cells never wrap unless `wrap` is set. The header sticks to the page scroll, or to the table with `maxHeight`. The table scrolls sideways only when its columns don't fit. Keyboard: ↑↓ select, ⇧↑↓ extend, ⌘A select all, Space toggle, Enter open, Esc clear. Selection is filled blue while the table has focus and grey otherwise. |
| `useContextMenu()` | `{ open(e, items), menu, close }` | Right-click menus anywhere. Render `{cm.menu}`. Items: `{label, icon?, onClick, danger?, disabled?, shortcut?, testId?}` or `"divider"`. |
| `JsonView` | `value`, `defaultDepth?` (2), `maxHeight?` (480), `copy?` | Collapsible, coloured JSON with a Copy button. For raw RPC results. |
| `CopyField` | `value`, `display?`, `mono?` (true), `block?`, `size?` | Value plus a copy button. |
| `CopyButton` | `value`, `label?` | Icon only. |
| `FingerprintField` | `value`, `compare?`, `label?` | SHA-256 fingerprint in 4 rows of 8 byte pairs. Green when it equals `compare`, orange when it differs. |
| `Copyable` | `value`, `mono?` | Web-compatible alias of `CopyField`. |

### Status

| Component | Props | Notes |
|---|---|---|
| `StatusDot` | `status`, `label?`, `size?`, `tooltip?` | `status`: `ok`, `error`, `warning`, `off`, `unknown`, `locked`, `busy`. Always give it `label` (an accessible name) unless text sits next to it. |
| `StatusBadge` | `status`, `children`, `tooltip?`, `testId?` | Dot plus a word ("Online", "Stopped", "Failed"). Use it in table cells and headers. |
| `OnlineBadge` | `online`, `onLabel?`, `offLabel?` | Web-compatible. |
| `Tag` | `color?` (gray, accent, green, red, orange, yellow, purple, teal), `variant?` (soft, outline, solid), `icon?` | Replaces Mantine `Badge` for small labels: modes, auth types, tags. Mantine `Badge` still works; the theme makes it lowercase and quiet. |
| `serverStatus(server)` | → `{status, label, detail?}` | The single source of "Online", "Offline", "Locked", "Disabled" and "Connecting…". |

### Forms and overlays

| Component | Props | Notes |
|---|---|---|
| `FormSection` | `title?`, `description?`, `footer?`, `testId?` | Grouped settings box. |
| `FormRow` | `label`, `description?`, `stacked?`, `align?: "center" \| "start"`, `error?`, `children` (node, or `(id) => node` to wire the label's `htmlFor`) | Label on the left, control on the right. `stacked` puts the control under the label (textareas, lists). Give the control no label of its own. |
| `FormActions` | `dirty`, `valid?`, `saving?`, `onSave`, `onDiscard?`, `saveLabel?`, `note?`, `testId?` | Save bar. It sticks to the bottom of the page only while there are changes (`dirty`); otherwise it sits after the form. For pages that apply many fields in one RPC (hub properties, policies). Settings that map to one call each may apply immediately instead, as Preferences does. |
| `Sheet` | `opened`, `onClose`, `title`, `subtitle?`, `icon?`, `footer?`, `size?` (560), `busy?` (blocks closing), `closeOnClickOutside?` (false), `testId?` | Modal task dialog that slides from the toolbar. Use it for every create/edit form. The footer holds the buttons: secondary left of primary, primary rightmost. |
| `Inspector` | `opened`, `onClose`, `title`, `subtitle?`, `icon?`, `actions?`, `width?` (380), `testId?` | Non-modal detail panel on the right: session details, user properties preview. The table stays usable, and selecting another row swaps the content. Esc closes it, unless a dialog, sheet, menu or dropdown is showing (`overlayOpen()`, exported for custom Esc handlers): then that overlay gets the Esc first. Don't add page-level Esc workarounds. |
| `ConfirmButton` | `title`, `message?`, `onConfirm`, `typeToConfirm?`, `confirmLabel?`, `tone?`, `color?` ("red"), `variant?`, `size?`, `leftSection?`, `testId?` | Drop-in replacement for the web's `ConfirmButton`. The dialog buttons get `${testId}-confirm` and `${testId}-cancel`. |
| `confirmAction(opts)` / `useConfirm()` | `ConfirmOptions` → `Promise<boolean>` | Imperative confirmation. See §6. |

### States

| Component | Props | Use |
|---|---|---|
| `EmptyState` | `title`, `description?`, `action?`, `icon?`, `compact?`, `testId?` | Nothing to show yet. |
| `Empty` | children | Web alias (a compact `EmptyState`). |
| `LoadingState` | `label?`, `compact?` | Spinner, only when the shape is unknown. |
| `TableSkeleton`, `PropertySkeleton`, `MetricSkeleton` | counts | Prefer these: the layout doesn't jump when data arrives. |
| `ErrorState` | `error`, `onRetry?`, `inline?`, `serverId?`, `onTrust?`, `testId?` | Any thrown error; see §8. |
| `ErrorAlert` | `error` | Web alias (inline `ErrorState`). |
| `QueryState` | `query`, `skeleton?`, `inline?`, children | Loading, then error (with Try Again), then content. |

### Shell hooks

`useShell()` returns `{ openConnection(id?), openUnlock(id), openQuickSwitcher(), openBulk(ids?), toggleSidebar(),
scopeNavHidden, toggleScopeNav() }`. Use it to open the connection sheet or the unlock prompt from anywhere.

---

## 5. Layout patterns

* **Status page** (Overview, hub Status): `PageHeader` with a `meta` line, then `MetricGrid`, then
  `SectionGrid` of inset `PropertyList`s, then plain `Section`s with tables.
* **List page** (Users, Groups, Sessions, Access lists…): `PageHeader` with the primary action ("Add User…"),
  then a `DataTable`.
  * Put per-row actions in `contextMenu` and in an Inspector or edit sheet opened by `onRowOpen`, not as buttons
    in every row.
  * Keep at most one inline control per row, and only if it's the common task (e.g. an Online switch).
  * Put bulk actions in `toolbar`, enabled by `selection`.
* **Settings page** (hub Properties, Server settings, Protocols): `PageHeader`, then `FormSection`s of
  `FormRow`s, then `FormActions`.
* **Create/Edit**: always a `Sheet`, never a routed page.
  * Title "New User" / "Edit “alice”". The primary button names the verb ("Create User", "Save").
  * On success: close the sheet, show a toast, and select or open the new object.
* **Details**: `Inspector` for read-mostly details of a table row; a `Sheet` when the details are editable.
* **Two tables on one page**: one `Section` each, with a `title` and a one-line `description`.

---

## 6. Dangerous actions and confirmation

There are no roles any more: whoever runs the app is the administrator. Confirmation replaces permission.

1. **Automatic.** `useRpcMutation(serverId, method)` looks the method up in the catalog. When its risk is
   `danger` (`DeleteHub`, `SetConfig`, `RebootServer`, `SetServerCert`, `RegenerateServerCert`,
   `SetServerPassword`, `SetServerCipher`, `DeleteListener`, `SetPortsUDP`, `SetSpecialListener`, `SetFarmSetting`,
   `GetConfig`, `Flush`, `SetProtoOptions`, `SetHubAdminOptions`, `SetHubExtOptions`, license, VLAN and debug
   calls), it shows a built-in dialog before the call (`design/ConfirmDialog.tsx`, `DANGER_COPY`). If the user
   cancels, the mutation rejects with `ConfirmCancelled`, which is never toasted. Use `isConfirmCancelled(e)` if
   you `await mutateAsync`.
2. **Typed confirmation** is required for irreversible or connection-breaking operations:
   * `DeleteHub`: the hub name.
   * `SetConfig`, and `RebootServer` with reset: the connection name.
   * `DeleteListener` on the port this app uses: the port.
   * `Crash`: `CRASH`.
   * Bulk `danger` runs: the method name.
3. **Customise** with `useRpcMutation(id, "DeleteUser", { confirm: (p) => ({ title: <>Delete user “{p.Name_str}”?</>, message: "…", confirmLabel: "Delete User", typeToConfirm: p.Name_str }) })`.
   Passing options also confirms `write` methods, which is right for deleting users, groups, cascades,
   certificates and access lists.
4. **Avoid double prompts.** If the page already asked (e.g. through `ConfirmButton`), pass `confirm: false`.
5. **Dialog anatomy** (matches macOS alerts):
   * An icon in a tinted circle: red for danger, orange for warning.
   * The title is a question naming the object.
   * One or two sentences: what happens, what breaks, whether it can be undone.
   * Buttons: Cancel, then a destructive button that names the verb ("Delete Hub", never "OK" or "Yes").
   * Esc cancels. Danger dialogs don't close when you click outside them.
   * Focus starts on Cancel, or on the typing field when typing is required.

---

## 7. Copy and tone

(Reviewed with the `design:ux-copy` guidelines.)

* **Voice:** plain, calm and specific, in second person. "Can’t reach Lab Raspberry Pi", not
  "Error: connection failure".
* **Capitalisation:** Title Case for buttons, menu items, window, sheet and section titles in navigation
  ("Add Connection…", "Delete Hub"). Sentence case for everything else (headings inside pages, descriptions,
  labels, messages). Use typographic quotes “…” and apostrophes ’.
* **Ellipsis:** add "…" when an action needs more input before it happens ("Edit Connection…", "Unlock…").
* **Verbs:** buttons say what they do: Connect, Save, Create User, Delete Hub, Trust and Connect, Try Again.
  Cancel is always "Cancel".
* **Terminology:** "connection" (a saved server setting), "server" (the VPN Server), "Virtual Hub" (first use)
  or "hub", "session", "administrator password", "hub admin mode", "certificate", "fingerprint". Use SoftEther's
  own names for its features (SecureNAT, Cascade Connection, Local Bridge).
* **Errors:** a title stating the problem, then the server's message, then one sentence on what to check
  (`KIND_HELP`). Don't blame the user or use "invalid" alone.
* **Empty states:** title states the fact ("No Virtual Hubs"), description says what to do next, action optional.
* **Descriptions:** one sentence, and only when the label isn't self-explanatory.
* **Numbers:** `num()`, `bytes()` and `agoShort()` ("5 min ago") in tables, `ago()` in sentences, `dt()` in
  tooltips and details, "–" for no value, "Never" for SoftEther's zero date.

---

## 8. Loading, empty and error states

* **Loading.** Skeletons shaped like the content (`TableSkeleton`, `PropertySkeleton`, `MetricSkeleton`), or
  `DataTable loading`. Background refetches don't show a spinner: the table footer reads "Updating…" and the
  toolbar Refresh icon spins.
* **Empty.** `DataTable empty={{ title, description, action }}`. Filtered-empty is automatic
  ("No results for “x”" with Clear Filter).
* **Errors.** Use `ErrorState`, never a bare Mantine `Alert`.
  * SoftEther codes get friendly titles: 9 authentication failed, 12/52 access denied, 29 not found,
    33/147 not supported (grey, not red), 57/66/67/112 already exists, and so on. It shows
    "SoftEther error N" under the server's message.
  * Connection kinds (`network`, `timeout`, `auth`, `tls`, `tls-mismatch`, `http`, `protocol`) get an explanation.
    A `tls-mismatch` shows the presented fingerprint and, with `onTrust`, a "Trust New Certificate…" button.
  * 423 locked errors show an **Unlock…** button.
  * `inline` is for sections; the full size is for whole pages.
* **Server down.** When `server.state.ok === false`, a page shouldn't fire one failing RPC per section. Gate the
  queries on reachability and show one explanation with Try Again (see `pages/server/Overview.tsx`).
  `useRpc` doesn't retry connection failures.
* **Locked servers.** The scope layouts render the unlock form instead of the page, so pages never see a
  locked server.
* **Toasts.** `notifySuccess(msg)` / `notifyError(e, title)` appear bottom right: success for 3.5 s, errors
  for 8 s. `useRpcMutation` already toasts. Pass `success: false` for silent toggles.

---

## 9. Renderer infrastructure (`lib/`)

| Module | Exports |
|---|---|
| `lib/api.ts` | `api`, `get`, `post`, `put`, `patch`, `del`, `rpc`, `upload`, `download`, `saveFile`, `openFile`, `openExternal`, `revealPath`, `ApiError` (`status`, `body`, `softEtherCode`, `kind`, `presentedFingerprint`, `locked`), `onLocked` |
| `lib/hooks.ts` | `useCatalog`, `useMethod`, `useServers`, `useServer`, `useFleet`, `useScope`, `useRpc`, `useRpcMutation`, `useCaps`, `useRefreshServer`, `notifyError`, `notifySuccess`, `enumLabel`, `fieldDoc` |
| `lib/format.ts` | `bytes`, `num`, `dt`, `ago`, `agoShort`, `dateShort`, `isNever`, `duration`, `serverVersion`, `serverVersionShort`, `trafficOf`, `plural`, `b64ToText`, `textToB64`, `fileToB64`, `downloadText`, `downloadB64`, `isIPv4`, `normFp`, `colonFp`, `shortFp` |
| `lib/types.ts` | `Server` (`transport`, `fingerprint`, `passwordSaved`, `unlocked`), `ServerInput`, `ProbeResult`, `TestResult`, `FleetSummary`, `BulkResult`, `AppSettings`, catalog types |
| `lib/platform.ts` | `platform()`, `isMac()`, `secretStore()` (Keychain/DPAPI wording), `shortcutLabel()` |

**File transfer changed signatures** (the web versions used `<input type=file>` and `<a download>`):

* `upload<T>(path, { fields?, filters?, title? })` opens the native Open dialog itself and POSTs the chosen file
  as multipart field `file`. It resolves `null` when the user cancels and throws `ApiError` on HTTP errors.
  Replace a `FileInput` plus `upload(path, file, fields)` with one button:
  `const r = await upload("/api/…", { fields, filters: [{ name: "Certificates", extensions: ["cer","pem"] }] }); if (!r) return;`
* `download(path, { suggestedName? })` → `Promise<{ saved, filePath? }>`. It shows the native Save dialog, and
  the file name comes from `Content-Disposition`.
* `downloadText(name, text)` / `downloadB64(name, b64)` keep their names, but now open the Save dialog and
  return a promise.
* For certificate, key or config imports that the page parses itself, use
  `openFile({ filters, encoding: "utf8" | "base64" })` → `{ name, content } | null` instead of `fileToB64(File)`.
* `useServerRole`, `can()`, `ReadOnlyNotice`, `myRole`, `visibleHubs` and `hubRoles` are gone. Delete every role
  check. Hub-admin connections are handled by `hubAdminOk` in `sections.tsx` and by `server.hub`.

---

## 10. Page porting guide

### The route registry

`src/renderer/sections.tsx` lists every page: `serverSections`, `hubSections` and `deploySections`. Each entry
has `path`, `label` (Title Case), `group`, `icon` (a tabler icon *component*), `component`, `hubAdminOk?` and
`keywords?`.

Unported pages point to `pending("server/Hubs")`, which renders `pages/Pending.tsx`. To ship a page:

1. Create `src/renderer/pages/<scope>/<File>.tsx` with a default export.
2. Replace **only your line's** `component: pending("…")` with `component: lazy(() => import("./pages/<scope>/<File>"))`.
3. Don't change path, label, group or icon without updating this guide. Routes, scope navigation, toolbar menu
   and quick switcher are generated from these lists.

### Mechanical mapping

| apps/web | apps/desktop |
|---|---|
| `../../components/common` → `PageHeader`, `Section`, `KeyValue`, `QueryState`, `ErrorAlert`, `OnlineBadge`, `Copyable`, `ConfirmButton`, `Empty` | same names from `../../design` |
| `../../components/DataTable` | `DataTable` from `../../design` (same props, plus more) |
| `components/server-a/shared` `StatCard` + `SimpleGrid` | `MetricGrid` + `Metric` |
| `duration`, `enumLabel`, `fieldDoc` from `server-a/shared` | `duration` in `lib/format`, `enumLabel`/`fieldDoc` in `lib/hooks` |
| `Card withBorder` / `Paper withBorder` | `Section variant="inset"` or `FormSection`; no free-standing cards |
| `Modal` for create/edit | `Sheet` with a `footer` |
| `Alert color="red"` | `ErrorState inline` |
| informational `Alert` | `.sem-callouts > .sem-callout[data-tone]` (see `Fleet.tsx`) or a `Section` description |
| `Badge` | `Tag`, or `StatusBadge` for states |
| `Text fw={600}` in cells | `<span className="sem-strong">` |
| `Text c="dimmed"` | `<span className="sem-dim">`, or keep `c="dimmed"` |
| `ff="monospace"` | `Mono`, or `mono: true` on the column |
| `useServerRole` / `can(role, …)` / `isAdmin &&` | delete: always allowed |
| `ConfirmButton` + `useRpcMutation` for a danger method | keep `ConfirmButton` and pass `confirm: false` to the mutation, or drop the button and let the mutation confirm |
| per-row action buttons column | `contextMenu` + `onRowOpen` (+ a `toolbar` for selected rows) |
| `onRowClick={navigate}` | `onRowOpen={navigate}` plus `selectable="single"` (single click selects, double-click or Enter opens) |
| `upload(path, file, fields)` + `FileInput` | `upload(path, { fields, filters })` |
| `download(path)` / `downloadText` | same names, now async with native dialogs |
| `data-testid` values | keep them: E2E tests reuse them |

### Worked example: `server/Hubs.tsx`

Web version (abridged):

```tsx
<PageHeader title="Virtual Hubs" description="Each Virtual Hub is an isolated…"
  actions={isAdmin && <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>Create hub</Button>} />
<QueryState query={hubs}>
  <DataTable data={hubs.data?.HubList} rowKey={(h) => h.HubName_str} onRowClick={(h) => nav(…)} columns={[
    …,
    { key: "actions", title: "", render: (h) => can(role, "operator") && (<Group>
        <Switch … onChange={(e) => setOnline.mutate(…)} />
        {isAdmin && <ConfirmButton title={`Delete Virtual Hub ${h.HubName_str}?`} typeToConfirm={h.HubName_str}
          onConfirm={() => del.mutateAsync({ HubName_str: h.HubName_str })}>Delete</ConfirmButton>}
      </Group>) },
  ]} />
</QueryState>
<CreateHubModal … />   // Mantine Modal with a Stack of inputs
```

Desktop version:

```tsx
import { useState } from "react";
import { useNavigate } from "react-router";
import { Button, NumberInput, PasswordInput, Switch, TextInput } from "@mantine/core";
import { IconExternalLink, IconPlus, IconPower, IconStack2, IconTrash } from "@tabler/icons-react";
import { useRpc, useRpcMutation, useScope, useServer } from "../../lib/hooks";
import { agoShort, bytes, num, trafficOf } from "../../lib/format";
import type { HubListItem } from "../../lib/types";
import { hubBase } from "../../sections";
import { DataTable, FormRow, FormSection, PageHeader, Sheet, StatusBadge, Tag } from "../../design";

export default function HubsPage() {
  const { serverId } = useScope();
  const nav = useNavigate();
  const server = useServer(serverId);
  const hubs = useRpc<{ HubList?: HubListItem[] }>(serverId, "EnumHub");
  const [creating, setCreating] = useState(false);
  const setOnline = useRpcMutation(serverId, "SetHubOnline", { success: false });
  const del = useRpcMutation(serverId, "DeleteHub", { success: "Virtual Hub deleted" }); // "danger": confirms itself, typed name
  const hubMode = !!server.data?.hub;                                                     // roles are gone; only hub-admin mode limits

  return (
    <>
      <PageHeader
        title="Virtual Hubs"
        description="Each Virtual Hub is an isolated virtual Ethernet segment with its own users and policies."
        actions={!hubMode && <Button leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="hub-create">Create Hub…</Button>}
      />
      <DataTable
        testId="hubs-table" aria-label="Virtual Hubs"
        data={hubs.data?.HubList} loading={hubs.isLoading} error={hubs.error} onRetry={() => void hubs.refetch()}
        rowKey={(h) => h.HubName_str} selectable="single" initialSort={{ key: "HubName_str", dir: "asc" }}
        onRowOpen={(h) => nav(hubBase(serverId, h.HubName_str))}
        empty={{ title: "No Virtual Hubs", description: "Create a hub to start accepting VPN connections.", icon: <IconStack2 size={28} stroke={1.4} /> }}
        contextMenu={(h) => [
          { label: "Open", icon: <IconExternalLink size={14} />, onClick: () => nav(hubBase(serverId, h.HubName_str)) },
          { label: h.Online_bool ? "Take Offline" : "Bring Online", icon: <IconPower size={14} />,
            onClick: () => setOnline.mutate({ HubName_str: h.HubName_str, Online_bool: !h.Online_bool }) },
          "divider",
          { label: "Delete Hub…", icon: <IconTrash size={14} />, danger: true, disabled: hubMode,
            onClick: () => del.mutate({ HubName_str: h.HubName_str }) },
        ]}
        columns={[
          { key: "HubName_str", title: "Name", render: (h) => <span className="sem-strong">{h.HubName_str}</span> },
          { key: "Online_bool", title: "Status", width: 100, render: (h) => <StatusBadge status={h.Online_bool ? "ok" : "off"}>{h.Online_bool ? "Online" : "Offline"}</StatusBadge> },
          { key: "HubType_u32", title: "Type", width: 110, render: (h) => <Tag>{["Standalone", "Static", "Dynamic"][h.HubType_u32] ?? h.HubType_u32}</Tag> },
          { key: "NumUsers_u32", title: "Users", align: "right", width: 70, render: (h) => num(h.NumUsers_u32) },
          { key: "NumSessions_u32", title: "Sessions", align: "right", width: 80, render: (h) => num(h.NumSessions_u32) },
          { key: "traffic", title: "Traffic ↓ / ↑", align: "right", width: 150,
            value: (h) => { const t = trafficOf(h, "Ex."); return t.recv + t.send; },
            render: (h) => { const t = trafficOf(h, "Ex."); return <span className="sem-num">{bytes(t.recv)} / {bytes(t.send)}</span>; } },
          { key: "LastCommTime_dt", title: "Last activity", width: 110, render: (h) => <span className="sem-dim">{agoShort(h.LastCommTime_dt)}</span> },
        ]}
      />
      <CreateHubSheet serverId={serverId} opened={creating} onClose={() => setCreating(false)}
        onCreated={(name) => nav(hubBase(serverId, name))} />
    </>
  );
}

function CreateHubSheet({ serverId, opened, onClose, onCreated }: { serverId: number; opened: boolean; onClose: () => void; onCreated: (n: string) => void }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [maxSession, setMaxSession] = useState(0);
  const [online, setOnline] = useState(true);
  const create = useRpcMutation(serverId, "CreateHub", { success: "Virtual Hub created", onSuccess: () => { onClose(); onCreated(name); } });
  const submit = () => create.mutate({ HubName_str: name.trim(), AdminPasswordPlainText_str: password, Online_bool: online, MaxSession_u32: maxSession, NoEnum_bool: false, HubType_u32: 0 });
  return (
    <Sheet opened={opened} onClose={onClose} busy={create.isPending} title="New Virtual Hub" icon={<IconStack2 size={19} stroke={1.5} />}
      footer={<div className="sem-row-inline" style={{ justifyContent: "flex-end", width: "100%" }}>
        <Button variant="default" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} loading={create.isPending} disabled={!name.trim()} data-testid="hub-create-submit">Create Hub</Button>
      </div>}>
      <FormSection>
        <FormRow label="Name" description="Letters, digits, - and _. Not case-sensitive.">{(id) =>
          <TextInput id={id} value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />}</FormRow>
        <FormRow label="Hub admin password" description="Optional. Lets someone manage just this hub.">{(id) =>
          <PasswordInput id={id} value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="new-password" />}</FormRow>
        <FormRow label="Maximum sessions" description="0 means no limit.">{(id) =>
          <NumberInput id={id} w={120} min={0} value={maxSession} onChange={(v) => setMaxSession(Number(v) || 0)} />}</FormRow>
        <FormRow label="Online"><Switch checked={online} onChange={(e) => setOnline(e.currentTarget.checked)} aria-label="Online" /></FormRow>
      </FormSection>
    </Sheet>
  );
}
```

What changed and why:

* **Roles.** `can(role, …)` and `isAdmin` are gone. Only hub-admin mode hides server-wide actions.
* **Deleting.** It moved to a context menu and relies on the automatic `DeleteHub` confirmation, which requires
  typing the hub name. There's no action column.
* **Navigation.** A single click now selects the row; double-click or Enter opens the hub (`onRowOpen`).
* **States.** `QueryState` became the table's own `loading`/`error`/`empty` props, which gives skeleton rows and
  an empty state with guidance.
* **Create.** The `Modal` became a `Sheet` with `FormRow`s. The button names the verb ("Create Hub") and the
  sheet can't close while the call runs (`busy`).
* **Formatting.** `Badge`, `Text fw` and `ago` became `Tag`, `sem-strong` and `agoShort`. Traffic uses
  `trafficOf`.

### Checklist before you register a page

* [ ] Nothing hard-coded: no hex colours, px font sizes or `withBorder` cards. Use tokens or components only.
* [ ] One `PageHeader`; its title equals the `sections.tsx` label.
* [ ] Every query shows skeleton, error (with Try Again), empty or content.
* [ ] Every dangerous call is confirmed exactly once (automatically, or `confirm: false` + `ConfirmButton`).
* [ ] Create/edit happen in a `Sheet`, and the primary button names the verb.
* [ ] Tables: `aria-label`, `rowKey`, sensible `initialSort`, numbers right-aligned, `onRowOpen` for drill-down.
* [ ] File import/export goes through `upload`/`download`/`openFile`/`saveFile`, never `<input type=file>` or `<a download>`.
* [ ] The page works in light and dark mode at 1100 px wide and does both jobs by keyboard alone.
* [ ] `data-testid`s from the web page are preserved.

---

## 11. Development and verification

* **Mock bridge** (`src/renderer/dev/mockBridge.ts`). When `window.sem` is missing (a plain browser on the vite
  dev server), `main.tsx` installs a fake bridge.
  * It has five servers: two online, one offline, one locked (password `acme`), and one hub-admin connection.
  * It serves hubs, sessions, users, groups, listeners, connections, caps, settings, fleet summary and bulk RPC,
    and the real catalog from `@sem/api-catalog`.
  * URL switches: `?empty=1` (first run), `?platform=win32`, `?slow=1`, `?shell=electron`.
    `window.__semMenu("preferences")` simulates a native menu action.
  * It's excluded from production builds (`import.meta.env.DEV`).
* **Run:** `pnpm exec vite --config apps/desktop/vite.config.ts --port 5291 --host 127.0.0.1`
* **Real-app screenshots and design checks:** `node apps/desktop/tools/design-polish/run.mjs` builds the app into a
  scratch dir, starts a throwaway vpnserver (port 16011, `~/se-desk-polish`, DDNS off) with realistic data, launches
  the real app with Playwright `_electron`, captures every page, sheet, dialog and inspector in light and dark
  (`design-screenshots/final/`, 1360×880), runs the checks above and the accessibility scan, captures the real
  window with `screencapture -l` (vibrancy included), writes `final/report.json` and kills the server's process
  group. `ROUND=n` also keeps a copy in `final/round-n/`; `ONLY=<regex>` limits the captures.
* **Screenshots** (36, light and dark, 1360×880): `node apps/desktop/design-screenshots/capture.mjs`. Fails on
  any console error.
* **Interaction checks** (13 flows against the mock): `node apps/desktop/design-screenshots/flows.mjs` writes
  `flows-report.json`.
* **Real window chrome** (macOS vibrancy and traffic lights):
  `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/desktop/design-screenshots/electron/chrome-main.mjs "http://127.0.0.1:5291/?shell=electron#/servers/1" out.png light`

### Accessibility notes (WCAG 2.1 AA review)

* **Contrast.** Body text 16:1. Secondary text 5.2–6.4:1. Status and tag colours are at least 4.6:1 as plain text
  and as `Tag` text on their own tint, over every surface (content, inset, elevated, alternate rows), in both
  schemes. Accent links 5.9 (light) / 6.1 (dark). White on filled selection (`--sem-selection`) 5.7. Primary
  buttons use Mantine shade 7 (`#0066d6`, 5.4:1). Destructive menu items use `--sem-red`, not Mantine's red 6
  (3.5:1). `--sem-text-3` (2.7:1) is only for placeholders, disabled controls and decoration; de-emphasised table
  rows (`rowTone="dim"`) use `--sem-text-2`.
* **Disabled buttons.** Grey label (`--sem-text-3`, overriding any inline `c=` colour), no shadow, lighter bezel;
  subtle buttons lose their fill. Mantine's own disabled style lives in a cascade layer and loses to the unlayered
  default-variant rule, which is why components.css restates it.
* **Automated scan.** `tools/design-polish/run.mjs` checks every captured screen in both schemes: contrast of every
  visible text run against its composited background (1.4.3), accessible names of buttons and links (4.1.2),
  labels of form fields (1.3.1/3.3.2) and image alt text (1.1.1). Results are in `design-screenshots/final/report.json`.
* **Known deviation.** Input borders are 20 % black (about 2:1). This matches macOS controls, which are also
  identified by their white fill on grouped backgrounds. The focus ring is a 3 px accent ring (3:1+).
* **Keyboard.** Tab reaches sidebar rows, toolbar, scope navigation, page actions and tables (single tab stop;
  arrows inside). Esc closes sheets, dialogs, menus and the inspector. ⌘K works even inside text fields.
* **Screen readers.**
  * Landmarks: `nav` (sidebar, sections), `header` (toolbar), `main`.
  * Status dots carry `aria-label`. Selectable tables expose `role="grid"` with `aria-selected`,
    `aria-multiselectable` and `aria-sort`.
  * Errors are `role="alert"`, loading is `role="status"`, and the connection progress is `aria-live`.
* **Motion.** `prefers-reduced-motion` removes transitions. The only permanent animation is the busy dot pulse.

### Design iterations (self-critique log)

1. **First pass.**
   * Fleet table rows wrapped to three lines (version strings, tags, "a few seconds ago").
   * Toolbar and page both said "Overview".
   * Sheets overlapped the toolbar (a Mantine `inner` padding override).
   * An offline server showed endless skeletons.
   * The Mantine 9 switch had a ring-in-thumb indicator.
   * The Save-password explanation sat in the label column.
   * Preferences needed a Save button; system settings windows apply immediately.
2. **Fixes.**
   * Cells don't wrap by default; the table scrolls sideways only when needed.
   * Compact version "4.44 (9807)" and `agoShort`.
   * The toolbar names the object and the page header names the section.
   * Scope-column headers were removed (triple naming).
   * The sheet `yOffset` sits under the toolbar.
   * Pages gate RPCs on reachability and show one "Can’t reach …" state with Try Again.
   * `withThumbIndicator={false}`; the checkbox carries its description; Preferences auto-apply.
   * Clearer callout copy.
3. **Real Electron window.** The page scrollbar takes width, which pushed the fleet table into horizontal scroll,
   so the "Checked" column moved into the status tooltip. The dark callout tints were too heavy and were
   lightened.
4. **Accessibility pass.** Added the `--sem-selection` token, darkened the primary shade, moved informational
   text from `text-3` to `text-2`, darkened the grey tag and sidebar headings, and put grid semantics on
   selectable tables.
5. **Polish pass on the real app** (Playwright `_electron` against a real vpnserver with hubs, users, groups,
   access lists, SecureNAT and live cascades; `design-screenshots/final/`, rounds in `final/round-N/`).
   * Inspector Esc was dead on every page that had shown a Sheet or confirmation (Mantine keeps closed Modal
     roots mounted): it now checks for a *visible* overlay (`overlayOpen()`); the Connections workaround is gone.
   * Disabled default buttons looked enabled (see Disabled buttons above).
   * Sheets: the first grouped box sits 4 px under the header however it is wrapped; an empty `.sem-callouts`
     no longer adds a gap; callouts get 10–14 px from neighbouring boxes and tables.
   * Session details: NODE_INFO integers (reported client port and version, server port, proxy port) are
     byte-swapped like Server Manager does (SM.c `SmPrintNodeInfo`, `Endian32`); cascade, SecureNAT, bridge and L3
     sessions hide the client report and "Authenticated as", and proxy rows appear only with a proxy
     (`StatusView`: `swap32`, `fmtReportedPort`, `fmtReportedVersion`, `isServerCreatedSession`, `NODE_INFO_KEYS`).
   * Real window, dark: the vibrancy material is dark (screencapture of the real window, sidebar luminance
     73/255). But choosing Light or Dark in Preferences against the system appearance left the material in the
     system's brightness (white text on a light sidebar). `design/material.ts` sets `html[data-material="none"]`
     in that case and the sidebar paints `--sem-bg-sidebar` itself.
   * Consistency sweep: right-aligned table headers sat 1 px high; rows are 26 px again (inline switches and
     tags no longer stretch them) and switches centre on the row; grouped-box titles were indented 2 px from
     section titles; tag and multi-select fields and segmented controls are 26 px like every control; the scope
     column is 228 px so no label truncates; a collapsed server row stays selected while you are in one of its
     hubs; Preferences is left-aligned like every page; the empty memory meter no longer draws a bar;
     sentence case for in-page headings (Server Settings, Preferences); Fleet error callouts punctuate the
     server message; "Delete 1…" reads "Delete User…".
   * Known, left to page owners (their controls carry E2E test ids): hub Status, Sessions and Connections use
     three different auto-refresh controls (menu button, switch + segmented control, select); status next to
     the title is a badge on SecureNAT but a meta line on WireGuard.
