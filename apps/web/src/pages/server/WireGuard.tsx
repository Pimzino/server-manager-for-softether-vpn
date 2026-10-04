import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Alert, Anchor, Badge, Button, Code, Group, List, Modal, SegmentedControl, Stack, Text, TextInput, Textarea } from "@mantine/core";
import { IconFileImport, IconInfoCircle, IconPlus, IconTrash } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, Copyable, KeyValue, OnlineBadge, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { HubSelect, HubUserInput, useHubNames } from "../../components/server-b/HubUserPicker";
import { HelpLabel, NotApplicable, SecretText, useServerAccess } from "../../components/server-b/ui";
import { decodeProtoOptions, encodeProtoOptions, optionMeta, type ProtoOptionsRaw } from "../../components/server-b/proto";
import { useRpc, useRpcMutation, useScope } from "../../lib/hooks";

interface WgkRaw { Key_str?: string[]; Hub_str?: string[]; User_str?: string[] }
interface WgKey { key: string; hub: string; user: string }

/** A WireGuard public key is 32 raw bytes, base64 encoded (44 chars ending with '='). */
function isWgKey(k: string) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(k)) return false;
  try { return atob(k).length === 32; } catch { return false; }
}

function toRows(r: WgkRaw | undefined): WgKey[] {
  const keys = r?.Key_str ?? [];
  return keys.map((key, i) => ({ key, hub: r?.Hub_str?.[i] ?? "", user: r?.User_str?.[i] ?? "" }));
}

function AddKeyModal({ serverId, opened, onClose, existing }: { serverId: number; opened: boolean; onClose: () => void; existing: Set<string> }) {
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [key, setKey] = useState("");
  const [hub, setHub] = useState("");
  const [user, setUser] = useState("");
  const [bulk, setBulk] = useState("");
  const hubs = useHubNames(serverId);
  const add = useRpcMutation(serverId, "AddWgk", {
    success: "WireGuard key(s) registered",
    onSuccess: () => { setKey(""); setUser(""); setBulk(""); onClose(); },
  });

  const k = key.trim();
  const keyError = k && !isWgKey(k) ? "Not a WireGuard public key (44-character base64 of 32 bytes)" : k && existing.has(k) ? "This key is already registered" : undefined;

  const parsed = useMemo(() => {
    const rows: WgKey[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    const hubSet = new Set(hubs.names.map((h) => h.toLowerCase()));
    bulk.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      const [pk, h, u] = t.split(/[,;\t]/).map((x) => x.trim());
      if (!pk || !h || !u) { errors.push(`Line ${i + 1}: expected "publicKey,hub,user"`); return; }
      if (!isWgKey(pk)) { errors.push(`Line ${i + 1}: invalid public key`); return; }
      if (existing.has(pk) || seen.has(pk)) { errors.push(`Line ${i + 1}: duplicate key`); return; }
      if (hubs.names.length && !hubSet.has(h.toLowerCase())) { errors.push(`Line ${i + 1}: hub "${h}" does not exist`); return; }
      seen.add(pk);
      rows.push({ key: pk, hub: h, user: u });
    });
    return { rows, errors };
  }, [bulk, existing, hubs.names]);

  const submitSingle = () => add.mutate({ Key_str: [k], Hub_str: [hub], User_str: [user.trim()] });
  const submitBulk = () => add.mutate({ Key_str: parsed.rows.map((r) => r.key), Hub_str: parsed.rows.map((r) => r.hub), User_str: parsed.rows.map((r) => r.user) });

  return (
    <Modal opened={opened} onClose={onClose} title="Register WireGuard client key" centered size="lg">
      <Stack>
        <SegmentedControl value={mode} onChange={(v) => setMode(v as "single" | "bulk")} data={[{ value: "single", label: "Single key" }, { value: "bulk", label: "Bulk import" }]} />
        {mode === "single" ? (
          <form onSubmit={(e) => { e.preventDefault(); submitSingle(); }}>
            <Stack>
              <TextInput label="Client public key" required value={key} onChange={(e) => setKey(e.currentTarget.value)} ff="monospace" data-autofocus
                description="The client's public key (output of `wg pubkey`), never its private key." error={keyError} data-testid="wgk-key" />
              <HubSelect serverId={serverId} value={hub} onChange={(v) => { setHub(v); setUser(""); }} required testId="wgk-hub"
                description="Virtual Hub the client is connected to." />
              <HubUserInput serverId={serverId} hub={hub} value={user} onChange={setUser} required testId="wgk-user"
                description="The client is treated as this user of the hub (policies, group, logs)." />
              <Group justify="flex-end">
                <Button variant="default" onClick={onClose}>Cancel</Button>
                <Button type="submit" loading={add.isPending} disabled={!k || !!keyError || !hub || !user.trim()} data-testid="wgk-submit">Register key</Button>
              </Group>
            </Stack>
          </form>
        ) : (
          <Stack>
            <Textarea label="Keys to import" autosize minRows={6} maxRows={16} ff="monospace" value={bulk} onChange={(e) => setBulk(e.currentTarget.value)}
              description={<>One mapping per line: <Code>publicKey,hub,user</Code> (comma, semicolon or tab separated). Lines starting with # are ignored.</>}
              placeholder={"xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=,DEFAULT,alice"} data-testid="wgk-bulk" />
            {parsed.errors.length > 0 && (
              <Alert color="red" variant="light" title={`${parsed.errors.length} line(s) rejected`}>
                <List size="xs">{parsed.errors.slice(0, 10).map((e) => <List.Item key={e}>{e}</List.Item>)}</List>
              </Alert>
            )}
            <Group justify="space-between">
              <Text size="sm" c="dimmed">{parsed.rows.length} valid mapping(s)</Text>
              <Group>
                <Button variant="default" onClick={onClose}>Cancel</Button>
                <Button loading={add.isPending} disabled={parsed.rows.length === 0 || parsed.errors.length > 0} onClick={submitBulk} data-testid="wgk-bulk-submit">Import {parsed.rows.length}</Button>
              </Group>
            </Group>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}

function ServerSettings({ serverId, isAdmin }: { serverId: number; isAdmin: boolean }) {
  const q = useRpc<ProtoOptionsRaw>(serverId, "GetProtoOptions", { Protocol_str: "WireGuard" });
  const udp = useRpc<{ Ports_u32?: number[] }>(serverId, "GetPortsUDP", {}, { retry: false });
  const opts = useMemo(() => decodeProtoOptions(q.data), [q.data]);
  const save = useRpcMutation(serverId, "SetProtoOptions", { success: "WireGuard setting saved" });
  const get = (n: string) => opts.find((o) => o.name === n);
  const enabled = get("Enabled");
  const known = new Set(["Enabled", "PrivateKey", "PresharedKey"]);

  if (q.error) {
    return (
      <Section title="WireGuard server">
        <NotApplicable error={q.error} title="WireGuard is not available on this server">
          WireGuard support was added in SoftEther VPN 5.x. This server does not report WireGuard protocol options.
        </NotApplicable>
      </Section>
    );
  }

  const toggle = (v: boolean) => save.mutateAsync(encodeProtoOptions("WireGuard", opts.map((o) => (o.name === "Enabled" ? { ...o, value: v } : o))));

  return (
    <Section
      title="WireGuard server"
      description="WireGuard clients connect over the server's UDP listener ports. Each client public key must be mapped to a Virtual Hub user below."
      actions={isAdmin && enabled && (
        <ConfirmButton
          title={enabled.value ? "Disable WireGuard?" : "Enable WireGuard?"}
          color={enabled.value ? "red" : "blue"} variant={enabled.value ? "light" : "filled"} size="xs"
          confirmLabel={enabled.value ? "Disable" : "Enable"}
          message={enabled.value
            ? "All connected WireGuard clients will be disconnected and new WireGuard handshakes will be ignored."
            : "The server will start answering WireGuard handshakes on its UDP listener ports."}
          onConfirm={() => toggle(!enabled.value)}
        >
          <span data-testid="wg-toggle-enabled">{enabled.value ? "Disable WireGuard" : "Enable WireGuard"}</span>
        </ConfirmButton>
      )}
    >
      <QueryState query={q}>
        <KeyValue rows={[
          [<HelpLabel label="Status" doc={optionMeta("WireGuard", "Enabled").doc} />, <span data-testid="wg-enabled-state"><OnlineBadge online={enabled ? !!enabled.value : null} onLabel="Enabled" offLabel="Disabled" /></span>],
          ["UDP ports", udp.data?.Ports_u32?.length
            ? <Group gap={4}>{udp.data.Ports_u32.map((p) => <Badge key={p} variant="outline">{p}</Badge>)}<Anchor component={Link} to={`/servers/${serverId}/listeners`} size="xs">manage</Anchor></Group>
            : <Text size="sm" c="dimmed">{udp.error ? "Unavailable" : "None configured"}</Text>],
          [<HelpLabel label="Server private key" doc={optionMeta("WireGuard", "PrivateKey").doc} />, <SecretText value={String(get("PrivateKey")?.value ?? "")} canReveal={isAdmin} testId="wg-private-key" />],
          [<HelpLabel label="Pre-shared key" doc={optionMeta("WireGuard", "PresharedKey").doc} />, <SecretText value={String(get("PresharedKey")?.value ?? "")} canReveal={isAdmin} testId="wg-psk" />],
          ...opts.filter((o) => !known.has(o.name)).map((o) => [o.name, String(o.value)] as [string, string]),
        ]} />
        <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />} mt="sm">
          <Text size="sm">
            Clients need the server's <b>public</b> key as their <Code>[Peer] PublicKey</Code>. Derive it on a trusted machine with{" "}
            <Code>echo &lt;server private key&gt; | wg pubkey</Code>; the manager never derives or stores keys. If a pre-shared key is set, clients must use it as <Code>PresharedKey</Code>.
            Key rotation and other advanced options are on the <Anchor component={Link} to={`/servers/${serverId}/protocols`} size="sm">OpenVPN / SSTP → Protocol options</Anchor> page.
          </Text>
        </Alert>
      </QueryState>
    </Section>
  );
}

export default function WireGuardPage() {
  const { serverId } = useScope();
  const { role, isOperator, isAdmin } = useServerAccess(serverId);
  const q = useRpc<WgkRaw>(serverId, "EnumWgk");
  const rows = useMemo(() => toRows(q.data), [q.data]);
  const del = useRpcMutation(serverId, "DeleteWgk", { success: "WireGuard key removed" });
  const [adding, setAdding] = useState(false);
  const existing = useMemo(() => new Set(rows.map((r) => r.key)), [rows]);
  const hubs = useHubNames(serverId);
  const hubSet = new Set(hubs.names.map((h) => h.toLowerCase()));

  return (
    <>
      <PageHeader title="WireGuard" description="Native WireGuard support (SoftEther 5.x). Each WireGuard client is identified by its public key, which is mapped to a user of a Virtual Hub." />
      {!isOperator && <ReadOnlyNotice role={role} />}
      <ServerSettings serverId={serverId} isAdmin={isAdmin} />
      <Section
        title="Client key mappings"
        description="Registered client public keys and the hub / user each one logs in as."
        actions={isOperator && (
          <Group gap="xs">
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)} data-testid="add-wgk">Register key</Button>
          </Group>
        )}
      >
        <QueryState query={q}>
          <DataTable
            testId="wgk-table"
            data={rows}
            rowKey={(r) => r.key}
            initialSort={{ key: "hub", dir: "asc" }}
            empty="No WireGuard client keys registered"
            columns={[
              { key: "key", title: "Client public key", render: (r) => <Group gap={6} wrap="nowrap"><Copyable value={r.key} />{!isWgKey(r.key) && <Badge color="red" variant="light" size="xs">malformed</Badge>}</Group> },
              { key: "hub", title: "Virtual Hub", render: (r) => <Group gap={6}><Text size="sm">{r.hub}</Text>{hubs.isSuccess && !hubSet.has(r.hub.toLowerCase()) && <Badge color="orange" variant="light" size="xs">hub missing</Badge>}</Group> },
              { key: "user", title: "User" },
              {
                key: "actions", title: "", sortable: false, align: "right", value: () => "",
                render: (r) => isOperator && (
                  <ConfirmButton
                    title="Remove WireGuard key?"
                    message={<Stack gap={4}><Text size="sm">The client with this key will no longer be able to connect as <b>{r.user}</b>@<b>{r.hub}</b>.</Text><Code>{r.key}</Code></Stack>}
                    confirmLabel="Remove"
                    leftSection={<IconTrash size={14} />}
                    onConfirm={() => del.mutateAsync({ Key_str: [r.key] })}
                  >Remove</ConfirmButton>
                ),
              },
            ]}
          />
        </QueryState>
      </Section>
      <Section title="Client configuration hints" description="Template for a client's wg-quick configuration.">
        <Code block>{`[Interface]
PrivateKey = <client private key>
Address = <IP assigned for this client, e.g. from the hub's DHCP range>

[Peer]
PublicKey = <server public key>
PresharedKey = <server pre-shared key, if set>
Endpoint = <server host>:<one of the UDP ports>
AllowedIPs = <networks reachable through the hub>
PersistentKeepalive = 25`}</Code>
        <Group mt="xs"><IconFileImport size={14} /><Text size="xs" c="dimmed">Tip: use "Register key → Bulk import" to onboard many devices at once.</Text></Group>
      </Section>
      <AddKeyModal serverId={serverId} opened={adding} onClose={() => setAdding(false)} existing={existing} />
    </>
  );
}
