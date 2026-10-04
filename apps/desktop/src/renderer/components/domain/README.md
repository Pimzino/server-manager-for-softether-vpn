# components/domain: shared SoftEther components for ported pages

Ports of every shared component and helper that `apps/web/src/pages/**` import from `apps/web/src/components`, restyled with
the desktop design system (`../../design`) and the desktop `lib/` (native file dialogs, no roles).

Import from a module (`../../components/domain/util`) or from the barrel (`../../components/domain`). Both work.
From a page in `pages/<scope>/`, the prefix is `../../components/domain`.

Global rules that apply to every row below:

* **No roles.** `can()`, `useServerRole`, `myRole`, `role`, `canWrite`, `canAdmin`, `canEdit`, `canReveal`, `isOperator` and
  `isAdmin` are gone. Delete the checks: everything is allowed. The only remaining limit is SoftEther's hub-admin mode
  (`server.data.hub`, exposed as `hubAdminMode` / `hubMode` / `serverWide` below).
* **No file inputs.** Anything that took a `File` now takes bytes, and a `pick…`/`open…` helper opens the native Open
  dialog (`files.ts`). Everything that saved a file is async and uses the native Save dialog.
* **Colours.** Every `color` in these tables is a design-system `TagColor` (`gray`, `accent`, `green`, `red`, `orange`,
  `yellow`, `purple`, `teal`), not a Mantine colour. Render it with `<Tag color=…>`.

## components/common.tsx

Everything in it is covered by the design system; nothing is re-implemented here.

| Old (`../../components/common`) | New | Differences |
|---|---|---|
| `PageHeader` | `PageHeader` from `../../design` | adds `meta`, `icon`, `testId` |
| `Section` | `Section` from `../../design` | not a card any more; `variant="inset"` for a grouped box |
| `QueryState` | `QueryState` from `../../design` | adds `skeleton`, `inline`; error has Try Again |
| `ErrorAlert` | `ErrorAlert` (alias) or `ErrorState inline` from `../../design` | friendly titles per SoftEther code / connection kind |
| `KeyValue` | `KeyValue` (alias) or `PropertyList` from `../../design` | |
| `OnlineBadge` | `OnlineBadge` from `../../design` | renders a `StatusBadge` |
| `Copyable` | `Copyable` (alias) or `CopyField` from `../../design` | |
| `ConfirmButton` | `ConfirmButton` from `../../design` | `title` may be a node; dialog buttons are `${testId}-confirm` / `${testId}-cancel` (was `confirm-action` without testId); default variant `default` |
| `Empty` | `Empty` (alias) or `EmptyState` from `../../design` | |
| `ReadOnlyNotice` | – | delete (no roles) |
| `../../components/DataTable` | `DataTable` from `../../design` | superset; prefer `onRowOpen` + `contextMenu` |

## components/RpcForm.tsx → `domain/RpcForm.tsx`

| Old | New | Differences |
|---|---|---|
| `fieldLabel`, `defaultValue`, `emptyParams` | same | unchanged |
| `RpcField({field, catalog, value, onChange, readOnly})` | `RpcField` (same props) | renders a whole `FormRow` (label + info tooltip, field name and kind as description, control). Put RpcFields inside a `FormSection`. JSON and binary fields are stacked. |
| – | `RpcFieldControl({… , id?})` | just the control, for your own `FormRow` |
| – | `isWideField(field)` | true for array/object/binary (use `FormRow stacked`) |
| `RpcForm` | `RpcForm` (same props + `title?`, `testId?`) | a `FormSection` + submit button (`${testId}-submit`). Unknown type shows an inline `ErrorState`. |

Binary fields: "Load from File…" (`rpc-field-<Name>-load`) uses the native Open dialog. Inputs have
`data-testid="rpc-field-<FieldName>"`; rows `rpc-row-<FieldName>`. Password fields are `PasswordInput`.

## components/hub/PolicyEditor.tsx → `domain/PolicyEditor.tsx`

Same exports: `POLICY_GROUPS`, `ALL_POLICY_FIELDS`, `CASCADE_POLICY_FIELDS`, `POLICY_DEFAULTS`, `withPolicyDefaults`,
`hasPolicyFields`, `usePolicyDocs`, `policySummary`, `PolicyEditor`; new `fmtBps`.
`PolicyEditor({ value, onChange, fields?, readOnly?, testId? })` is unchanged. It renders one `FormSection` per group
(test id `${testId}-<groupKey>`, e.g. `policy-editor-limits`) with a "N changed" tag instead of an Accordion.
Inputs keep `data-testid="policy-<field>"`. Put it in a Sheet or page body; pair it with `SaveBar`/`FormActions`.

## components/hub/StatusView.tsx → `domain/StatusView.tsx`

| Old | New | Differences |
|---|---|---|
| `SESSION_STATUS` | same keys | entries are `{ label, status }` (a design `Status`), not `{ label, color }` |
| `SessionStatusBadge({value})` | same (+ `testId?`) | a `StatusBadge` |
| `fmtVersion`, `fmtField`, `FieldGroup`, `CONNECTION_GROUPS` | same | `fmtField` booleans render "Yes"/"No" text; certificates get "Save PEM…" (native dialog) |
| `swap32`, `fmtReportedPort`, `fmtReportedVersion`, `NODE_INFO_KEYS`, `NODE_INFO_SWAPPED`, `isServerCreatedSession` | new | GetSessionStatus NODE_INFO integers arrive byte-swapped (Admin.c `OutRpcNodeInfo`); render them like vpnsmgr (SM.c `SmPrintNodeInfo`). Hide `NODE_INFO_KEYS` for cascade/SecureNAT/bridge/L3 sessions. |
| `StatusGroups({data, groups, hide})` | same + `labelWidth?` (180), `testId?` | keys in `hide` are left out of the groups too; inset `Section` per group; "All other fields" (`status-other`) and "Effective security policy" (`status-policy`) are collapsed `Disclosure`s. Use `labelWidth={130}` inside an `Inspector`. |

## components/hub/util.ts → `domain/util.ts`

All exports keep their names and behaviour: `b64ToBytes`, `bytesToB64`, `b64ToHex`, `hexToB64`, `macFromB64`, `macToB64`,
`isMac`, `isIPv4`, `prefixToMask4`, `mask4ToPrefix`, `normalizeMask4`, `parseIPv6`, `isIPv6`, `formatIPv6`, `ipv6FromB64`,
`ipv6ToB64`, `prefixToMask6`, `mask6ToPrefix`, `normalizeMask6`, `derB64ToPem`, `generatePassword`, `ZERO_DT`,
`isoToLocalInput`, `localInputToIso`, `parseCsv`, `toCsv`, `runSequential`, `yesNo`, `AUTH_TYPES`, `authLabel`.

Changes:

* `certFileToDerB64(file: File, kind)` → `certBytesToDerB64(bytes: Uint8Array, kind)` (sync), or
  `await pickCertDerB64(kind)` from `files.ts` → `{ name, derB64 } | null` (null = cancelled). Both throw a readable
  error for encrypted keys or files without the right PEM block: catch it and `notifyError(e, "…")`.
* `AUTH_TYPES[].color` is a `TagColor`. Use `<AuthTag type={n} />` (ui.tsx) instead of a `Badge`.
* `b64ToBytes` also accepts whitespace in the input.
* New: `toHex(bytes, sep = ":")`, `isHex`, `ipToInt`, `intToIp`, `isMask`, `maskBits`, `bitsToMask`, `MASK_OPTIONS`,
  `HUB_TYPE_LABELS` (moved here from the files below).

`lib/format` also has an `isIPv4` (doesn't trim) and `isMac` exists in `lib/platform` (the OS!). Don't mix them up:
`util.isMac` is a MAC address check.

## components/hub-a/shared.tsx

| Old | New | Differences |
|---|---|---|
| `useHubAccess()` | `domain/hooks` `useHubAccess()` | returns `{ serverId, hub, server, hubAdminMode, base }`. `role`, `canWrite`, `canAdmin` are gone: delete those checks. |
| `useDocs(type)` | `domain/hooks` `useDocs` | unchanged |
| `useEnumOptions(enum, fallback)` | `domain/hooks` `useEnumOptions` | unchanged |
| `StatCard` | `MetricGrid` + `Metric` from `../../design` | `sub` → `hint`; no icon |
| `SaveBar` | `domain/ui` `SaveBar` | same props (+ `note?`). Sticky bar that looks like `FormActions`; keeps test ids `${testId}` (Save) and `${testId}-reset` (now labelled Revert). Default label "Save". |
| `HUB_TYPE_LABELS` | `domain/util` | unchanged |
| `hexToB64(hex): string` | `domain/util` `hexToB64(hex): string \| null` | returns null for invalid hex. Pages that validated with `isHex` first: write `hexToB64(x) ?? ""`. |
| `b64ToHex(b64, sep = " ")` | `domain/util` `b64ToHex(b64, sep = "")` | **default separator changed**: pass `" "` explicitly to keep "01 A3 FF". |
| `isHex(s, bytes?)` | `domain/util` `isHex` | unchanged |

## components/hub-a/x509.ts + components/server-b/x509.ts → `domain/x509.ts`

One module with both APIs. Name clash resolved: **hub-a's `CertInfo` type is now `CertSummary`** (returned by
`parseCert`); `CertInfo` is server-b's type (returned by `parseCertificate`).

| Export | From | Notes |
|---|---|---|
| `b64ToBytes`, `bytesToB64`, `toHex`, `derB64ToPem` | both | re-exported from util.ts (same functions). `b64ToBytes` no longer throws: invalid input gives an empty array. |
| `certsFromFile(bytes)` | hub-a | get bytes with `openBytes({ filters: CERT_FILTERS })` instead of `file.arrayBuffer()` |
| `DName`, `dnToString`, `dnGet`, `parseCert(der) → CertSummary` | hub-a | unchanged shape |
| `sha(alg, data)`, `md5(data)` | hub-a | unchanged |
| `toPem`, `parsePem`, `PemBlock`, `readTlv`, `children`, `Tlv` | server-b | unchanged |
| `parseCertificate(der) → CertInfo`, `inspectPrivateKey`, `KeyInfo`, `KeyKind`, `readDerOrPem` | server-b | unchanged; malformed validity dates become the epoch instead of an Invalid Date |
| `sha256`, `fingerprint256`, `normalizeFp` | server-b | `normalizeFp` = `normFp` from lib/format |

Both parsers now share one DER walker (server-b's, which also handles OIDs ≥ 2.40) and decode non-UTF8 directory strings as
Latin-1. Verified against the real server certificate: both agree on serial, subject and validity, and
`fingerprint256` equals the fingerprint the connection pinned.

## components/server-a/JsonResult.tsx → `domain/JsonResult.tsx`

`JsonResult({ value, filename, testId? })` unchanged. Views: **JSON** (collapsible `JsonView`, `console-result-json`),
**Text** (plain, `console-result-text`; the web's `console-result-json` was plain text, so tests that read the raw text
should switch to `console-result-text`), and one table per record array (`console-result-table`). `console-copy` copies,
`console-download` is "Save JSON…" (native dialog). New export `RecordTable({ rows, name?, testId? })`.

## components/server-a/shared.tsx

| Old | New |
|---|---|
| `StatCard` | `MetricGrid` + `Metric` from `../../design` |
| `duration` | `lib/format` |
| `enumLabel`, `fieldDoc` | `lib/hooks` |
| `isMask`, `ipToInt`, `maskBits`, `bitsToMask`, `MASK_OPTIONS` | `domain/util` (same behaviour; `ipToInt` trims) |
| `Mono` | `Mono` from `../../design` (adds `dim`) |
| `HelpTip` | `domain/ui` `HelpTip` (unchanged) |

## components/server-b/*

| Old | New | Differences |
|---|---|---|
| `HubUserPicker` `useHubNames` | `domain/hooks` or `domain/HubPicker` `useHubNames` | unchanged |
| `HubSelect` | `domain/HubPicker` `HubSelect` | control only: no default `label`. Put it in a `FormRow` and pass `id`: `<FormRow label="Virtual Hub">{(id) => <HubSelect id={id} … />}</FormRow>`. `label`/`description` still work outside a FormRow. New `w?` (260). |
| `HubUserInput` | `domain/HubPicker` `HubUserInput` | same as above; unknown-user error reads "There’s no user “x” on HUB." |
| `proto.ts` (all exports) | `domain/proto` | unchanged |
| `ProtoOptionsEditor({serverId, protocol, canEdit, canReveal, only, testId, saveWarning})` | `domain/ProtoOptionsEditor` `({ serverId, protocol, readOnly?, only?, title?, description?, testId?, saveWarning? })` | `canEdit`/`canReveal` → `readOnly` (default editable). One `FormSection` (title "<Protocol> options", `null` hides it) + Revert (`revert-proto-<P>`) / "Save <P> Options" (`save-proto-<P>`). The single `SetProtoOptions` confirmation lists every change (old → new) plus `saveWarning`; its buttons are `save-proto-<P>-confirm` / `-cancel`. Don't wrap it in another confirmation. |
| `RepinPanel({serverId, expectedFp, canEdit, autoProbe})` | `domain/Repin` `RepinPanel({ serverId, expectedFp?, autoProbe? })` | uses `server.fingerprint` (was `tlsFingerprint`) and `PUT /api/servers/:id { fingerprint }`. Test ids kept: `repin-panel`, `pinned-fp`, `probe-cert`, `presented-fp`, `repin-confirm` (button "Trust This Certificate…"; dialog `repin-confirm-confirm`). New: `probe-result`. Fingerprints are shown with `FingerprintField`. |
| `ui.tsx` `useServerAccess(id)` | `domain/hooks` `useServerAccess(id)` | returns `{ server, hubMode, serverWide }`. Replace `isOperator`/`isAdmin` with `serverWide` where the check was about hub-admin mode, otherwise delete it. |
| `HelpLabel({label, doc})` | `domain/ui` `HelpLabel` | unchanged API |
| `SecretText({value, canReveal, testId})` | `domain/ui` `SecretText` | `canReveal` optional (default true); reveal button `${testId}-reveal`; shows a CopyField once revealed; empty = "Not set" |
| `isUnsupported(e)` | `domain/ui` `isUnsupported` | also true for SoftEther error 147 (open-source edition) |
| `NotApplicable({error, title, children})` | `domain/ui` `NotApplicable` (+ `onRetry?`, `testId?` = `not-applicable`) | grey `Callout`; other errors fall back to `ErrorState inline` |
| `x509.ts` | `domain/x509` | see above |

## components/deploy/shared.tsx → `domain/deploy.tsx`

All types (`ProfileSettings`, `Profile`, `ClientPackage`, `PackageFile`, `MsiOptions`, `InstallerBuild`, `DeployStatus`,
`AuthType`, `ProxyType`, `CredentialMode`), constants (`KEEP`, `AUTH_LABEL`, `CRED_LABEL`, `NIC_RE`, `NIC_OPTIONS`,
`VERSION_RE`, `UUID_RE`), `deployKeys`, `useProfiles`, `usePackages`, `useInstallers`, `useDeployStatus`, `pemSummary`,
`bumpVersion` and `productCodeOf` are unchanged.

* `useGlobalRole` is gone: delete every check.
* `AUTH_COLOR` values are `TagColor`s; `AuthBadge` renders a `Tag`.
* `fileToPem(file, kind)` → `bytesToPem(bytes, kind)` (sync) or `await pickPemFile(kind)` → `{ name, pem } | null`
  (both re-exported from `files.ts`).

## components/deploy/hubdeploy.tsx → `domain/hubdeploy.tsx`

Types (`PasswordPolicy`, `TemplateSettings`, `Template`, `HubProfile`, `HubBuild`, `HubUser`, `HubDetail`, `BuiltPackage`),
`POLICY_LABEL`, `PolicyBadge`, `KIND_LABEL`, `useTemplates` keep their names.

* `HubProfile.myRole` is gone; a row for a server that couldn't be listed has `error` and may have `locked: true`
  (open the unlock prompt with `useShell().openUnlock(serverId)`).
* `POLICY_LABEL[].color` is a `TagColor`; `PolicyBadge` is a `Tag` with the help text as its tooltip.
* `downloadBuild(id)` returns `Promise<{ saved, filePath? }>` (native Save dialog).
* `BuildResultModal` → **`BuildResultSheet`** (same props `{ result, onClose }`). A `Sheet` that can't be dismissed by
  clicking outside; "Save…" (`build-result-download`) then offers "Show in Finder/Explorer" (`build-result-reveal`).
  Kept test ids: `build-result`, `issued-password`. New: `build-result-sheet`, `build-result-saved`.

## New helpers (no web equivalent)

| Module | Export | Use |
|---|---|---|
| `files.ts` | `openBytes`, `openB64`, `openText` | native Open dialog → `{ name, bytes \| b64 \| text } \| null` |
| `files.ts` | `pickCertDerB64`, `pickPemFile`, `bytesToPem`, `CERT_FILTERS`, `KEY_FILTERS`, `CSV_FILTERS` | certificate / key / CSV imports |
| `ui.tsx` | `Callout({ tone, icon?, title?, children, action?, testId? })` | inline notice replacing non-error Mantine `Alert`s. Tones: `gray`, `accent`, `green`, `yellow`, `orange`, `red`, `purple`. Errors still use `ErrorState`. |
| `ui.tsx` | `Disclosure({ label, defaultOpen?, badge?, testId? })` | collapsible group (replaces single-item `Accordion`s) |
| `ui.tsx` | `AuthTag({ type, long? })`, `YesNo({ value })` | user auth type tag; boolean text |
| `hooks.ts` | `useHubAccess`, `useServerAccess`, `useDocs`, `useEnumOptions`, `useHubNames` | see above |

## Dropped

* `components/account/*` (QR code for MFA): MFA is gone.
* `components/fleet/*` (AddServerWizard, EditServerModal, BulkPanel, tls): replaced by `components/ConnectionSheet.tsx`
  and `components/BulkRunSheet.tsx` (open them with `useShell().openConnection(id?)` / `openBulk(ids?)`).
  `fleet/tls` `shortFp` → `lib/format` `shortFp`.
* `components/Layout.tsx`, `components/ScopeLayout.tsx`: replaced by the design system shell.

## Verification

E2E lab (real SoftEther VPN Server 5.02 + the real Electron app, Playwright `_electron`): a scratch route renders every
component above, drives them (policy saved via SetUser, CreateHub through RpcForm with a binary field loaded from a
native Open dialog, OpenVPN option saved through the confirmation, JSON saved through the Save dialog, certificate
re-check) and checks the helpers against the server's real certificate. 42/42 checks passed, no console errors or CSP
violations. The harness is not kept in the tree; see the task report for its location.
