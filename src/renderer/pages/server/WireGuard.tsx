// Server › WireGuard: the WireGuard server switch and keys (GetProtoOptions "WireGuard" / SetProtoOptions) and the
// client public-key → hub user mappings (EnumWgk / AddWgk / DeleteWgk). SoftEther 5.x only.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Anchor, Button, Group, SegmentedControl, Textarea, TextInput } from "@mantine/core";
import { IconCopy, IconFileImport, IconKey, IconPlus, IconPower, IconTrash } from "@tabler/icons-react";
import { notifyError, notifySuccess, useRpc, useRpcMutation } from "../../lib/hooks";
import { serverBase } from "../../sections";
import { downloadText } from "../../lib/format";
import {
  CopyField, DataTable, FormRow, FormSection, Inspector, Mono, PageHeader, PropertyList, PropertySkeleton, Section, Sheet, StatusBadge, Tag,
  type ContextMenuItem, type RowKey,
} from "../../design";
import { HubSelect, HubUserInput, useHubNames } from "../../components/domain/HubPicker";
import { CSV_FILTERS, openText } from "../../components/domain/files";
import { decodeProtoOptions, encodeProtoOptions, optionMeta, type ProtoOptionsRaw } from "../../components/domain/proto";
import { Callout, HelpLabel, NotApplicable, SecretText } from "../../components/domain/ui";
import { b64ToBytes, bytesToB64 } from "../../components/domain/util";
import { CodeBlock, HubModeNotice, UdpPorts, Unreachable, safeName, useServerPage } from "./_server-protocols-security/shared";

interface WgkRaw { Key_str?: string[]; Hub_str?: string[]; User_str?: string[] }
interface WgKey { key: string; hub: string; user: string }

/** A WireGuard public key is 32 raw bytes, base64 encoded (44 characters ending with “=”). */
function isWgKey(k: string) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(k)) return false;
  try { return atob(k).length === 32; } catch { return false; }
}

function toRows(r: WgkRaw | undefined): WgKey[] {
  return (r?.Key_str ?? []).map((key, i) => ({ key, hub: r?.Hub_str?.[i] ?? "", user: r?.User_str?.[i] ?? "" }));
}

/**
 * Curve25519 public key of a WireGuard private key, computed locally with WebCrypto (X25519), so clients can be
 * given the server's [Peer] PublicKey without running `wg pubkey`. null when the key is malformed or unsupported.
 */
async function wgPublicKey(privateB64: string): Promise<string | null> {
  const raw = b64ToBytes(privateB64);
  if (raw.length !== 32) return null;
  try {
    const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20, ...raw]);
    const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, true, ["deriveBits"]);
    const jwk = await crypto.subtle.exportKey("jwk", key);
    if (!jwk.x) return null;
    return bytesToB64(b64ToBytes(jwk.x.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

function clientTemplate({ serverPub, psk, host, port, who }: { serverPub?: string | null; psk: boolean; host: string; port?: number; who?: string }) {
  return [
    ...(who ? [`# ${who}`] : []),
    "[Interface]",
    "PrivateKey = <client private key>",
    "Address = <address for this client, e.g. from the hub’s DHCP range>",
    "",
    "[Peer]",
    `PublicKey = ${serverPub ?? "<server public key>"}`,
    ...(psk ? ["PresharedKey = <server pre-shared key>"] : []),
    `Endpoint = ${host.includes(":") ? `[${host}]` : host}:${port ?? "<UDP port>"}`,
    "AllowedIPs = <networks reachable through the hub>",
    "PersistentKeepalive = 25",
  ].join("\n");
}

function RegisterSheet({ serverId, opened, onClose, existing }: { serverId: number; opened: boolean; onClose: () => void; existing: Set<string> }) {
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [key, setKey] = useState("");
  const [hub, setHub] = useState("");
  const [user, setUser] = useState("");
  const [bulk, setBulk] = useState("");
  const hubs = useHubNames(serverId);
  useEffect(() => { if (opened) { setKey(""); setUser(""); setBulk(""); } }, [opened]);
  const add = useRpcMutation(serverId, "AddWgk", { success: "WireGuard keys registered", onSuccess: () => onClose() });

  const k = key.trim();
  const keyError = k && !isWgKey(k) ? "This isn’t a WireGuard public key (44 base64 characters)." : k && existing.has(k) ? "This key is already registered." : undefined;
  const parsed = useMemo(() => {
    const rows: WgKey[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    const hubSet = new Set(hubs.names.map((h) => h.toLowerCase()));
    bulk.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      const [pk, h, u] = t.split(/[,;\t]/).map((x) => x.trim());
      if (!pk || !h || !u) { errors.push(`Line ${i + 1}: expected “publicKey,hub,user”.`); return; }
      if (!isWgKey(pk)) { errors.push(`Line ${i + 1}: not a WireGuard public key.`); return; }
      if (existing.has(pk) || seen.has(pk)) { errors.push(`Line ${i + 1}: duplicate key.`); return; }
      if (hubs.names.length && !hubSet.has(h.toLowerCase())) { errors.push(`Line ${i + 1}: there’s no hub “${h}”.`); return; }
      seen.add(pk);
      rows.push({ key: pk, hub: h, user: u });
    });
    return { rows, errors };
  }, [bulk, existing, hubs.names]);

  const singleOk = !!k && !keyError && !!hub && !!user.trim();
  const bulkOk = parsed.rows.length > 0 && parsed.errors.length === 0;
  const submit = () => {
    if (mode === "single") { if (singleOk) add.mutate({ Key_str: [k], Hub_str: [hub], User_str: [user.trim()] }); }
    else if (bulkOk) add.mutate({ Key_str: parsed.rows.map((r) => r.key), Hub_str: parsed.rows.map((r) => r.hub), User_str: parsed.rows.map((r) => r.user) });
  };
  const importFile = async () => {
    try {
      const f = await openText({ filters: CSV_FILTERS, title: "Import WireGuard Keys" });
      if (f) setBulk((b) => (b.trim() ? `${b.trimEnd()}\n${f.text}` : f.text));
    } catch (e) { notifyError(e, "Couldn’t read the file"); }
  };

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={add.isPending} size={620} testId="wgk-sheet"
      title="Register WireGuard Keys" subtitle="Each client public key signs in as a user of a Virtual Hub."
      icon={<IconKey size={19} stroke={1.5} />}
      footer={(
        <Group justify="space-between" gap={8} wrap="nowrap">
          <span className="sem-dim" style={{ fontSize: "var(--sem-fz-small)" }} data-testid="wgk-bulk-count">
            {mode === "bulk" && (parsed.errors.length ? `${parsed.errors.length} of ${parsed.errors.length + parsed.rows.length} lines rejected` : `${parsed.rows.length} valid ${parsed.rows.length === 1 ? "line" : "lines"}`)}
          </span>
          <Group gap={8} wrap="nowrap">
            <Button variant="default" onClick={onClose} disabled={add.isPending}>Cancel</Button>
            {mode === "single"
              ? <Button onClick={submit} loading={add.isPending} disabled={!singleOk} data-testid="wgk-submit">Register Key</Button>
              : <Button onClick={submit} loading={add.isPending} disabled={!bulkOk} data-testid="wgk-bulk-submit">Import {parsed.rows.length || ""} {parsed.rows.length === 1 ? "Key" : "Keys"}</Button>}
          </Group>
        </Group>
      )}
    >
      <div className="sem-stack" style={{ gap: "var(--sem-space-6)" }}>
        <SegmentedControl value={mode} onChange={(v) => setMode(v as "single" | "bulk")} style={{ alignSelf: "flex-start" }} data-testid="wgk-mode"
          data={[{ value: "single", label: "One Key" }, { value: "bulk", label: "Import List" }]} />
        {mode === "single" ? (
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <FormSection>
              <FormRow label="Client public key" description="The output of wg pubkey on the client. Never its private key." error={keyError}>
                {(id) => <TextInput id={id} value={key} onChange={(e) => setKey(e.currentTarget.value)} data-autofocus spellCheck={false} error={!!keyError}
                  styles={{ input: { fontFamily: "var(--sem-font-mono)" } }} placeholder="44 characters ending in =" data-testid="wgk-key" />}
              </FormRow>
              <FormRow label="Virtual Hub" description="The hub the client connects to.">
                {(id) => <HubSelect id={id} serverId={serverId} value={hub} onChange={(v) => { setHub(v); setUser(""); }} testId="wgk-hub" />}
              </FormRow>
              <FormRow label="User" description="Policies, group and logs of this user apply.">
                {(id) => <HubUserInput id={id} serverId={serverId} hub={hub} value={user} onChange={setUser} testId="wgk-user" />}
              </FormRow>
            </FormSection>
            <button type="submit" hidden aria-hidden tabIndex={-1} />
          </form>
        ) : (
          <FormSection>
            <FormRow stacked label="Keys to import"
              description={<>One key per line as <span className="sem-code-inline">publicKey,hub,user</span> (commas, semicolons or tabs). Lines starting with # are ignored.</>}>
              {(id) => (
                <div className="sem-stack" style={{ gap: "var(--sem-space-4)", width: "100%" }}>
                  <Textarea id={id} autosize minRows={6} maxRows={14} value={bulk} onChange={(e) => setBulk(e.currentTarget.value)} spellCheck={false}
                    styles={{ input: { fontFamily: "var(--sem-font-mono)", fontSize: "var(--sem-fz-small)" } }}
                    placeholder="xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=,DEFAULT,alice" data-testid="wgk-bulk" />
                  <Group gap={8}>
                    <Button size="xs" variant="default" leftSection={<IconFileImport size={13} />} onClick={importFile} data-testid="wgk-bulk-file">Import from File…</Button>
                  </Group>
                </div>
              )}
            </FormRow>
          </FormSection>
        )}
        {mode === "bulk" && parsed.errors.length > 0 && (
          <Callout tone="red" title={`${parsed.errors.length} ${parsed.errors.length === 1 ? "line needs" : "lines need"} fixing`} testId="wgk-bulk-errors">
            <ul style={{ margin: 0, paddingLeft: "var(--sem-space-7)" }}>
              {parsed.errors.slice(0, 8).map((e) => <li key={e}>{e}</li>)}
              {parsed.errors.length > 8 && <li>…and {parsed.errors.length - 8} more</li>}
            </ul>
          </Callout>
        )}
      </div>
    </Sheet>
  );
}

export default function WireGuardPage() {
  const { serverId, s, reachable, hubMode, ready } = useServerPage();
  const enabled = ready && !hubMode;
  const opts = useRpc<ProtoOptionsRaw>(serverId, "GetProtoOptions", { Protocol_str: "WireGuard" }, { enabled, retry: false });
  const udp = useRpc<{ Ports_u32?: number[] }>(serverId, "GetPortsUDP", {}, { enabled, retry: false });
  const keys = useRpc<WgkRaw>(serverId, "EnumWgk", {}, { enabled });
  const hubs = useHubNames(serverId);
  const decoded = useMemo(() => decodeProtoOptions(opts.data), [opts.data]);
  const get = (n: string) => decoded.find((o) => o.name === n);
  const on = get("Enabled");
  const privateKey = String(get("PrivateKey")?.value ?? "");
  const psk = String(get("PresharedKey")?.value ?? "");
  const [serverPub, setServerPub] = useState<string | null>(null);
  useEffect(() => { let live = true; setServerPub(null); if (privateKey) void wgPublicKey(privateKey).then((p) => { if (live) setServerPub(p); }); return () => { live = false; }; }, [privateKey]);

  const rows = useMemo(() => toRows(keys.data), [keys.data]);
  const existing = useMemo(() => new Set(rows.map((r) => r.key)), [rows]);
  const hubSet = new Set(hubs.names.map((h) => h.toLowerCase()));
  const [adding, setAdding] = useState(false);
  const [selection, setSelection] = useState<RowKey[]>([]);
  const [detail, setDetail] = useState<WgKey | null>(null);

  const toggle = useRpcMutation<ReturnType<typeof encodeProtoOptions>>(serverId, "SetProtoOptions", {
    success: on?.value ? "WireGuard turned off" : "WireGuard turned on",
    confirm: () => (on?.value
      ? { title: "Turn off WireGuard?", message: "Every connected WireGuard client is disconnected and new handshakes are ignored.", confirmLabel: "Turn Off", tone: "danger", testId: "wg-toggle" }
      : { title: "Turn on WireGuard?", message: "The server starts answering WireGuard handshakes on its UDP ports.", confirmLabel: "Turn On", tone: "default", testId: "wg-toggle" }),
  });
  const del = useRpcMutation<{ Key_str: string[] }>(serverId, "DeleteWgk", {
    success: "WireGuard keys removed",
    confirm: (p) => ({
      title: p.Key_str.length === 1 ? "Remove this WireGuard key?" : `Remove ${p.Key_str.length} WireGuard keys?`,
      message: p.Key_str.length === 1
        ? <>The client with this key can no longer connect{(() => { const r = rows.find((x) => x.key === p.Key_str[0]); return r ? <> as <b>{r.user}</b>@<b>{r.hub}</b></> : null; })()}.</>
        : "These clients can no longer connect. The hub users aren’t changed.",
      details: p.Key_str.length === 1 ? <Mono dim>{p.Key_str[0]}</Mono> : undefined,
      confirmLabel: p.Key_str.length === 1 ? "Remove Key" : "Remove Keys",
      testId: "wgk-remove",
    }),
  });
  const remove = async (list: WgKey[]) => {
    try {
      await del.mutateAsync({ Key_str: list.map((r) => r.key) });
      setSelection([]);
      setDetail((d) => (d && list.some((r) => r.key === d.key) ? null : d));
    } catch {
      // cancelled, or already toasted by the hook
    }
  };

  const firstPort = udp.data?.Ports_u32?.[0];
  const selected = rows.filter((r) => selection.includes(r.key));
  const menu = (r: WgKey, sel: WgKey[]): ContextMenuItem[] => {
    const many = sel.length > 1;
    return [
      ...(!many ? [
        { label: "Show Client Configuration", icon: <IconKey size={14} />, onClick: () => setDetail(r), testId: `wgk-open-${r.user}` },
        { label: "Copy Public Key", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(r.key) },
        "divider" as const,
      ] : []),
      { label: many ? `Remove ${sel.length} Keys…` : "Remove Key…", icon: <IconTrash size={14} />, danger: true, onClick: () => void remove(many ? sel : [r]), testId: `wgk-remove-${r.user}` },
    ];
  };

  if (!s) return null;
  const unsupported = !!opts.error;
  return (
    <>
      <PageHeader
        title="WireGuard"
        meta={enabled && on ? <StatusBadge status={on.value ? "ok" : "off"} testId="wg-enabled-state">{on.value ? "On" : "Off"}</StatusBadge> : undefined}
        description="Each WireGuard client is identified by its public key, which signs in as a user of a Virtual Hub."
        actions={enabled && !unsupported && (
          <>
            {on && (
              <Button variant="default" leftSection={<IconPower size={14} />} loading={toggle.isPending} data-testid="wg-toggle-enabled"
                c={on.value ? "var(--sem-red)" : undefined}
                onClick={() => toggle.mutate(encodeProtoOptions("WireGuard", decoded.map((o) => (o.name === "Enabled" ? { ...o, value: !on.value } : o))))}>
                {on.value ? "Turn Off WireGuard…" : "Turn On WireGuard…"}
              </Button>
            )}
            <Button leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)} data-testid="add-wgk">Register Keys…</Button>
          </>
        )}
      />
      {!reachable && <Unreachable serverId={serverId} name={s.name} error={s.state?.error} checkedAt={s.state?.checkedAt} />}
      {reachable && hubMode && <HubModeNotice hub={s.hub!} what="WireGuard settings aren’t available." />}
      {enabled && unsupported && (
        <NotApplicable error={opts.error} title="WireGuard isn’t available on this server" onRetry={() => void opts.refetch()} testId="wg-not-applicable">
          WireGuard support was added in SoftEther VPN 5. This server doesn’t report WireGuard options.
        </NotApplicable>
      )}
      {enabled && !unsupported && (
        <>
          <Section title="Server" variant="inset" testId="wg-server">
            {!opts.data ? <PropertySkeleton rows={4} /> : (
              <PropertyList labelWidth={170} items={[
                { label: "UDP ports", value: <UdpPorts serverId={serverId} enabled={enabled} testId="wg-udp-ports" /> },
                {
                  label: <HelpLabel label="Public key" doc="Clients enter this as [Peer] PublicKey. Computed on this computer from the server’s private key." />,
                  value: serverPub ? <CopyField value={serverPub} testId="wg-public-key" /> : <span className="sem-dim">{privateKey ? "Can’t be computed" : "No private key"}</span>,
                },
                { label: <HelpLabel label="Private key" doc={optionMeta("WireGuard", "PrivateKey").doc} />, value: <SecretText value={privateKey} testId="wg-private-key" /> },
                { label: <HelpLabel label="Pre-shared key" doc={optionMeta("WireGuard", "PresharedKey").doc} />, value: <SecretText value={psk} testId="wg-psk" /> },
                ...decoded.filter((o) => !["Enabled", "PrivateKey", "PresharedKey"].includes(o.name)).map((o) => ({ label: optionMeta("WireGuard", o.name).label, value: String(o.value) })),
              ]} />
            )}
          </Section>
          {udp.data && !udp.data.Ports_u32?.length && (
            <Callout tone="yellow" testId="wg-no-udp">The server has no UDP ports, so WireGuard clients can’t reach it. Add one on the Listeners & Ports page.</Callout>
          )}

          <Section title="Client keys" description={<>Registered client public keys and the hub user each one signs in as. To rotate the server keys, use Protocol options on the <Anchor component={Link} to={`${serverBase(serverId)}/protocols`} size="sm" data-testid="wg-rotate-link">OpenVPN & SSTP</Anchor> page.</>}>
            <DataTable
              testId="wgk-table" aria-label="WireGuard client keys"
              data={keys.data ? rows : undefined} loading={keys.isLoading} error={keys.error} onRetry={() => void keys.refetch()}
              rowKey={(r) => r.key} selectable="multi" selection={selection} onSelectionChange={setSelection}
              initialSort={{ key: "hub", dir: "asc" }} onRowOpen={(r) => setDetail(r)} contextMenu={menu} rowTestId={(r) => `wgk-row-${r.user}`}
              rowTone={(r) => (!isWgKey(r.key) ? "danger" : undefined)}
              toolbar={selected.length > 1 ? (
                <Button size="xs" variant="default" c="var(--sem-red)" leftSection={<IconTrash size={13} />} onClick={() => void remove(selected)} data-testid="wgk-remove-selected">
                  Remove {selected.length} Keys…
                </Button>
              ) : undefined}
              empty={{
                title: "No client keys", icon: <IconKey size={28} stroke={1.4} />,
                description: "Register a client’s public key to let it connect.",
                action: <Button size="xs" variant="default" onClick={() => setAdding(true)}>Register Keys…</Button>,
              }}
              columns={[
                { key: "user", title: "User", width: 160, render: (r) => <span className="sem-strong">{r.user}</span> },
                { key: "hub", title: "Virtual Hub", width: 190, render: (r) => (
                  <span className="sem-cell-title">{r.hub}{hubs.isSuccess && !hubSet.has(r.hub.toLowerCase()) && <Tag color="orange" title="There’s no hub with this name">Missing</Tag>}</span>
                ) },
                { key: "key", title: "Public key", mono: true, render: (r) => (
                  <span className="sem-cell-title"><Mono>{r.key}</Mono>{!isWgKey(r.key) && <Tag color="red">Malformed</Tag>}</span>
                ) },
              ]}
            />
          </Section>

          <Section title="Client configuration" description="Template for a client’s wg-quick file, filled in with this server’s public key and first UDP port.">
            <CodeBlock code={clientTemplate({ serverPub, psk: !!psk, host: s.host, port: firstPort })} testId="wg-template" label="Copy template" />
          </Section>
        </>
      )}
      <RegisterSheet serverId={serverId} opened={adding} onClose={() => setAdding(false)} existing={existing} />
      <Inspector opened={!!detail} onClose={() => setDetail(null)} title={detail ? `${detail.user}@${detail.hub}` : ""} subtitle="WireGuard client"
        icon={<IconKey size={18} stroke={1.5} />} width={420} testId="wgk-inspector"
        actions={detail && (
          <Group gap={8}>
            <Button size="xs" variant="default" onClick={() => void downloadText(`${safeName(detail.user)}-${safeName(s.name)}.conf`, clientTemplate({ serverPub, psk: !!psk, host: s.host, port: firstPort, who: `${detail.user}@${detail.hub}` }))
              .then((r) => { if (r.saved) notifySuccess("Client template saved"); }, (e) => notifyError(e, "Couldn’t save the template"))}
              data-testid="wgk-save-conf">Save Template…</Button>
            <Button size="xs" variant="default" c="var(--sem-red)" leftSection={<IconTrash size={13} />} onClick={() => void remove([detail])}>Remove…</Button>
          </Group>
        )}
      >
        {detail && (
          <div className="sem-stack" style={{ gap: "var(--sem-space-7)" }}>
            <PropertyList labelWidth={90} items={[
              { label: "User", value: detail.user },
              { label: "Virtual Hub", value: detail.hub },
              { label: "Public key", value: <CopyField value={detail.key} size="sm" /> },
            ]} />
            <CodeBlock code={clientTemplate({ serverPub, psk: !!psk, host: s.host, port: firstPort, who: `${detail.user}@${detail.hub}` })} testId="wgk-inspector-template" maxHeight={320} />
          </div>
        )}
      </Inspector>
    </>
  );
}
