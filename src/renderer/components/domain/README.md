# components/domain: shared SoftEther components and helpers

Components and helpers shared by the server, hub and deployment pages, built on the design system (`../../design`) and
`lib/`. Import from a module (`../../components/domain/util`) or from the barrel (`../../components/domain`). Both work.
From a page in `pages/<scope>/`, the prefix is `../../components/domain`.

Rules that apply to every module below:

* **No roles.** Whoever runs the app is the admin. The only limit is SoftEther's hub-admin mode (`server.data.hub`,
  exposed as `hubAdminMode` / `hubMode` / `serverWide` below).
* **No file inputs.** Anything that reads a file takes bytes, and a `pick…`/`open…` helper opens the native Open dialog
  (`files.ts`). Everything that saves a file is async and uses the native Save dialog.
* **Colours.** Every `color` in these modules is a design-system `TagColor` (`gray`, `accent`, `green`, `red`, `orange`,
  `yellow`, `purple`, `teal`), not a Mantine colour. Render it with `<Tag color=…>`.

The generic building blocks (`PageHeader`, `Section`, `QueryState`, `ErrorState`, `PropertyList`, `StatusBadge`,
`CopyField`, `ConfirmButton`, `EmptyState`, `DataTable`, `MetricGrid`/`Metric`, `Mono`) are in `../../design`.
`ConfirmButton`'s dialog buttons are `${testId}-confirm` / `${testId}-cancel`.

## RpcForm.tsx

| Export | Notes |
|---|---|
| `fieldLabel`, `defaultValue`, `emptyParams` | catalog field helpers |
| `RpcField({ field, catalog, value, onChange, readOnly })` | a whole `FormRow` (label + info tooltip, field name and kind as description, control). Put RpcFields inside a `FormSection`. JSON and binary fields are stacked. |
| `RpcFieldControl({ … , id? })` | just the control, for your own `FormRow` |
| `isWideField(field)` | true for array/object/binary (use `FormRow stacked`) |
| `RpcForm({ …, title?, testId? })` | a `FormSection` + submit button (`${testId}-submit`). Unknown type shows an inline `ErrorState`. |

Binary fields: "Load from File…" (`rpc-field-<Name>-load`) uses the native Open dialog. Inputs have
`data-testid="rpc-field-<FieldName>"`; rows `rpc-row-<FieldName>`. Password fields are `PasswordInput`.

## PolicyEditor.tsx

Exports `POLICY_GROUPS`, `ALL_POLICY_FIELDS`, `CASCADE_POLICY_FIELDS`, `POLICY_DEFAULTS`, `withPolicyDefaults`,
`hasPolicyFields`, `usePolicyDocs`, `policySummary`, `fmtBps` and `PolicyEditor({ value, onChange, fields?, readOnly?,
testId? })`. The editor renders one `FormSection` per group (test id `${testId}-<groupKey>`, e.g.
`policy-editor-limits`) with an "N changed" tag. Inputs have `data-testid="policy-<field>"`. Put it in a Sheet or page
body; pair it with `SaveBar`/`FormActions`.

## StatusView.tsx

| Export | Notes |
|---|---|
| `SESSION_STATUS` | entries are `{ label, status }` (a design `Status`) |
| `SessionStatusBadge({ value, testId? })` | a `StatusBadge` |
| `fmtVersion`, `fmtField`, `FieldGroup`, `CONNECTION_GROUPS` | `fmtField` booleans render "Yes"/"No" text; certificates get "Save PEM…" (native dialog) |
| `swap32`, `fmtReportedPort`, `fmtReportedVersion`, `NODE_INFO_KEYS`, `NODE_INFO_SWAPPED`, `isServerCreatedSession` | GetSessionStatus NODE_INFO integers arrive byte-swapped (Admin.c `OutRpcNodeInfo`); render them like vpnsmgr (SM.c `SmPrintNodeInfo`). Hide `NODE_INFO_KEYS` for cascade/SecureNAT/bridge/L3 sessions. |
| `StatusGroups({ data, groups, hide, labelWidth?, testId? })` | keys in `hide` are left out of the groups too; inset `Section` per group; "All other fields" (`status-other`) and "Effective security policy" (`status-policy`) are collapsed `Disclosure`s. Use `labelWidth={130}` inside an `Inspector`. |

## util.ts

Pure helpers: `b64ToBytes` (accepts whitespace), `bytesToB64`, `toHex(bytes, sep = ":")`, `isHex`, `b64ToHex(b64, sep = "")`,
`hexToB64` (null for invalid hex), `macFromB64`, `macToB64`, `isMac`, `isIPv4`, `ipToInt`, `intToIp`, `isMask`, `maskBits`,
`bitsToMask`, `MASK_OPTIONS`, `prefixToMask4`, `mask4ToPrefix`, `normalizeMask4`, `parseIPv6`, `isIPv6`, `formatIPv6`,
`ipv6FromB64`, `ipv6ToB64`, `prefixToMask6`, `mask6ToPrefix`, `normalizeMask6`, `derB64ToPem`, `certBytesToDerB64(bytes,
kind)`, `generatePassword`, `ZERO_DT`, `isoToLocalInput`, `localInputToIso`, `parseCsv`, `toCsv`, `runSequential`, `yesNo`,
`AUTH_TYPES` (`color` is a `TagColor`; render with `<AuthTag type={n} />`), `authLabel`, `HUB_TYPE_LABELS`.

`certBytesToDerB64` and `pickCertDerB64` (files.ts) throw a readable error for encrypted keys or files without the right
PEM block: catch it and `notifyError(e, "…")`.

`lib/format` also has an `isIPv4` (doesn't trim) and `isMac` exists in `lib/platform` (the OS!). Don't mix them up:
`util.isMac` is a MAC address check.

## x509.ts

| Export | Notes |
|---|---|
| `b64ToBytes`, `bytesToB64`, `toHex`, `derB64ToPem` | re-exported from util.ts. `b64ToBytes` doesn't throw: invalid input gives an empty array. |
| `certsFromFile(bytes)` | get bytes with `openBytes({ filters: CERT_FILTERS })` |
| `DName`, `dnToString`, `dnGet`, `parseCert(der) → CertSummary` | hub certificate / CRL pages: serial bytes, subject/issuer as DName lists |
| `sha(alg, data)`, `md5(data)` | CRL entry digests |
| `toPem`, `parsePem`, `PemBlock`, `readTlv`, `children`, `Tlv` | PEM and DER walking |
| `parseCertificate(der) → CertInfo`, `inspectPrivateKey`, `KeyInfo`, `KeyKind`, `readDerOrPem` | server certificate page; malformed validity dates become the epoch instead of an Invalid Date |
| `sha256`, `fingerprint256`, `normalizeFp` | `normalizeFp` = `normFp` from lib/format |

Both parsers share one DER walker (it handles OIDs ≥ 2.40) and decode non-UTF8 directory strings as Latin-1.
`fingerprint256` of a server certificate equals the fingerprint the connection pins.

## JsonResult.tsx

`JsonResult({ value, filename, testId? })`. Views: **JSON** (collapsible `JsonView`, `console-result-json`), **Text**
(plain, `console-result-text`; read raw text from here) and one table per record array (`console-result-table`).
`console-copy` copies, `console-download` is "Save JSON…" (native dialog). Also exports `RecordTable({ rows, name?,
testId? })`.

## HubPicker.tsx, ProtoOptionsEditor.tsx, Repin.tsx, proto.ts

| Export | Notes |
|---|---|
| `useHubNames` (also in `hooks`) | hub names of a server |
| `HubSelect` | control only: no default `label`. Put it in a `FormRow` and pass `id`: `<FormRow label="Virtual Hub">{(id) => <HubSelect id={id} … />}</FormRow>`. `label`/`description` still work outside a FormRow. `w?` (260). |
| `HubUserInput` | same as above; unknown-user error reads "There’s no user “x” on HUB." |
| `proto.ts` | encoding of per-protocol options (GetProtoOptions / SetProtoOptions) |
| `ProtoOptionsEditor({ serverId, protocol, readOnly?, only?, title?, description?, testId?, saveWarning? })` | One `FormSection` (title "<Protocol> options", `null` hides it) + Revert (`revert-proto-<P>`) / "Save <P> Options" (`save-proto-<P>`). The single `SetProtoOptions` confirmation lists every change (old → new) plus `saveWarning`; its buttons are `save-proto-<P>-confirm` / `-cancel`. Don't wrap it in another confirmation. |
| `RepinPanel({ serverId, expectedFp?, autoProbe? })` | uses `server.fingerprint` and `PUT /api/servers/:id { fingerprint }`. Test ids: `repin-panel`, `pinned-fp`, `probe-cert`, `presented-fp`, `probe-result`, `repin-confirm` (button "Trust This Certificate…"; dialog `repin-confirm-confirm`). Fingerprints are shown with `FingerprintField`. |

## hooks.ts

| Export | Notes |
|---|---|
| `useHubAccess()` | `{ serverId, hub, server, hubAdminMode, base }` |
| `useServerAccess(id)` | `{ server, hubMode, serverWide }` |
| `useDocs(type)`, `useEnumOptions(enum, fallback)` | catalog docs and enum options |
| `useHubNames` | see HubPicker |

`duration` is in `lib/format`; `enumLabel` and `fieldDoc` are in `lib/hooks`.

## ui.tsx

| Export | Notes |
|---|---|
| `SaveBar` | sticky bar that looks like `FormActions` (`note?`); test ids `${testId}` (Save) and `${testId}-reset` (Revert). Default label "Save". |
| `HelpTip`, `HelpLabel({ label, doc })` | info tooltips |
| `SecretText({ value, canReveal?, testId })` | reveal button `${testId}-reveal`; shows a CopyField once revealed; empty = "Not set" |
| `isUnsupported(e)` | true for "not supported" errors, including SoftEther error 147 (open-source edition) |
| `NotApplicable({ error, title, children, onRetry?, testId? = "not-applicable" })` | grey `Callout`; other errors fall back to `ErrorState inline` |
| `Callout({ tone, icon?, title?, children, action?, testId? })` | inline notice. Tones: `gray`, `accent`, `green`, `yellow`, `orange`, `red`, `purple`. Errors use `ErrorState`. |
| `Disclosure({ label, defaultOpen?, badge?, testId? })` | collapsible group |
| `AuthTag({ type, long? })`, `YesNo({ value })` | user auth type tag; boolean text |

## files.ts

| Export | Use |
|---|---|
| `openBytes`, `openB64`, `openText` | native Open dialog → `{ name, bytes \| b64 \| text } \| null` (null = cancelled) |
| `pickCertDerB64(kind)` → `{ name, derB64 } \| null`, `pickPemFile(kind)` → `{ name, pem } \| null`, `bytesToPem(bytes, kind)` | certificate / key imports |
| `CERT_FILTERS`, `KEY_FILTERS`, `CSV_FILTERS` | dialog filters |

## deploy.tsx

Types (`ProfileSettings`, `Profile`, `ClientPackage`, `PackageFile`, `MsiOptions`, `InstallerBuild`, `DeployStatus`,
`AuthType`, `ProxyType`, `CredentialMode`), constants (`KEEP`, `AUTH_LABEL`, `AUTH_COLOR`, `CRED_LABEL`, `NIC_RE`,
`NIC_OPTIONS`, `VERSION_RE`, `UUID_RE`), `deployKeys`, `useProfiles`, `usePackages`, `useInstallers`, `useDeployStatus`,
`pemSummary`, `bumpVersion`, `productCodeOf`, `AuthBadge` (a `Tag`), and `bytesToPem` / `pickPemFile` (re-exported from
`files.ts`).

## hubdeploy.tsx

Types (`PasswordPolicy`, `TemplateSettings`, `Template`, `HubProfile`, `HubBuild`, `HubUser`, `HubDetail`, `BuiltPackage`),
`POLICY_LABEL`, `PolicyBadge` (a `Tag` with the help text as its tooltip), `KIND_LABEL`, `useTemplates`.

* A `HubProfile` row for a server that couldn't be listed has `error` and may have `locked: true` (open the unlock
  prompt with `useShell().openUnlock(serverId)`).
* `downloadBuild(id)` returns `Promise<{ saved, filePath? }>` (native Save dialog).
* `BuildResultSheet({ result, onClose })`: a `Sheet` that can't be dismissed by clicking outside; "Save…"
  (`build-result-download`) then offers "Show in Finder/Explorer" (`build-result-reveal`). Test ids: `build-result`,
  `build-result-sheet`, `build-result-saved`, `issued-password`.
