// Security policy editor shared by Users, Groups and Cascade connections.
// Field list and descriptions come from the API catalog (type VpnRpcSetUser, fields "policy:*").
import { Accordion, Badge, Group, NumberInput, SimpleGrid, Stack, Switch, Text } from "@mantine/core";
import { useCatalog } from "../../lib/hooks";

type Struct = Record<string, unknown>;

interface PolicyGroupDef { key: string; title: string; description: string; fields: string[] }

/** Grouping of every policy:* field (Ver3 is internal and always true). */
export const POLICY_GROUPS: PolicyGroupDef[] = [
  {
    key: "access", title: "Access & session behaviour", description: "Whether the user may connect and what the session is allowed to do.",
    fields: ["policy:Access_bool", "policy:MonitorPort_bool", "policy:NoBridge_bool", "policy:NoRouting_bool", "policy:NoQoS_bool",
      "policy:FixPassword_bool", "policy:NoSavePassword_bool"],
  },
  {
    key: "security", title: "Security filters", description: "Anti-spoofing and isolation filters applied to packets of the session.",
    fields: ["policy:PrivacyFilter_bool", "policy:CheckMac_bool", "policy:CheckIP_bool", "policy:ArpDhcpOnly_bool",
      "policy:NoServer_bool", "policy:NoBroadcastLimiter_bool"],
  },
  {
    key: "limits", title: "Limits", description: "Connection, address and bandwidth limits. 0 means unlimited / not set.",
    fields: ["policy:MaxConnection_u32", "policy:TimeOut_u32", "policy:MultiLogins_u32", "policy:AutoDisconnect_u32",
      "policy:MaxMac_u32", "policy:MaxIP_u32", "policy:MaxIPv6_u32", "policy:MaxUpload_u32", "policy:MaxDownload_u32"],
  },
  {
    key: "dhcp", title: "DHCP & routing (IPv4)", description: "Control of DHCP and IPv4 routing for the session.",
    fields: ["policy:DHCPFilter_bool", "policy:DHCPNoServer_bool", "policy:DHCPForce_bool"],
  },
  {
    key: "ipv6", title: "IPv6", description: "IPv6 router advertisement, DHCPv6, routing and duplicate-address filters.",
    fields: ["policy:RSandRAFilter_bool", "policy:RAFilter_bool", "policy:DHCPv6Filter_bool", "policy:DHCPv6NoServer_bool",
      "policy:NoRoutingV6_bool", "policy:CheckIPv6_bool", "policy:NoServerV6_bool",
      "policy:NoIPv6DefaultRouterInRA_bool", "policy:NoIPv6DefaultRouterInRAWhenIPv6_bool"],
  },
  {
    key: "filters", title: "Protocol filters & VLAN", description: "Drop whole protocol families or tag the session into a VLAN.",
    fields: ["policy:FilterIPv4_bool", "policy:FilterIPv6_bool", "policy:FilterNonIP_bool", "policy:VLanId_u32"],
  },
];

export const ALL_POLICY_FIELDS = POLICY_GROUPS.flatMap((g) => g.fields);

/** Policy fields that are meaningful for a cascade connection (per catalog VpnRpcCreateLink). */
export const CASCADE_POLICY_FIELDS = [
  "policy:DHCPFilter_bool", "policy:DHCPNoServer_bool", "policy:DHCPForce_bool", "policy:CheckMac_bool", "policy:CheckIP_bool",
  "policy:ArpDhcpOnly_bool", "policy:PrivacyFilter_bool", "policy:NoServer_bool", "policy:NoBroadcastLimiter_bool",
  "policy:MaxMac_u32", "policy:MaxIP_u32", "policy:MaxUpload_u32", "policy:MaxDownload_u32", "policy:RSandRAFilter_bool",
  "policy:RAFilter_bool", "policy:DHCPv6Filter_bool", "policy:DHCPv6NoServer_bool", "policy:CheckIPv6_bool",
  "policy:NoServerV6_bool", "policy:MaxIPv6_u32", "policy:FilterIPv4_bool", "policy:FilterIPv6_bool", "policy:FilterNonIP_bool",
  "policy:NoIPv6DefaultRouterInRA_bool", "policy:VLanId_u32",
];

/** SoftEther's default policy (ClientDefaultPolicy): access allowed, 32 TCP connections, 20 s timeout. */
export const POLICY_DEFAULTS: Struct = Object.fromEntries([
  ...ALL_POLICY_FIELDS.map((f) => [f, f.endsWith("_bool") ? false : 0]),
  ["policy:Access_bool", true],
  ["policy:MaxConnection_u32", 32],
  ["policy:TimeOut_u32", 20],
  ["policy:Ver3_bool", true],
]);

/** Ensure every policy field exists (servers omit them when UsePolicy is off). */
export function withPolicyDefaults(s: Struct): Struct {
  const out: Struct = { ...s };
  for (const [k, v] of Object.entries(POLICY_DEFAULTS)) if (out[k] === undefined) out[k] = v;
  out["policy:Ver3_bool"] = true;
  return out;
}

export function hasPolicyFields(s: Struct) {
  return Object.keys(s).some((k) => k.startsWith("policy:"));
}

const UNITS: Record<string, { suffix?: string; max?: number; hint?: string }> = {
  "policy:MaxConnection_u32": { max: 32, hint: "1–32 TCP connections" },
  "policy:TimeOut_u32": { suffix: " s", hint: "Seconds" },
  "policy:AutoDisconnect_u32": { suffix: " s", hint: "Seconds; 0 = never" },
  "policy:MaxUpload_u32": { suffix: " bps", hint: "Bits per second; 0 = unlimited" },
  "policy:MaxDownload_u32": { suffix: " bps", hint: "Bits per second; 0 = unlimited" },
  "policy:VLanId_u32": { max: 4095, hint: "1–4095; 0 = no VLAN tag" },
  "policy:MultiLogins_u32": { hint: "0 = unlimited" },
  "policy:MaxMac_u32": { hint: "0 = unlimited" },
  "policy:MaxIP_u32": { hint: "0 = unlimited" },
  "policy:MaxIPv6_u32": { hint: "0 = unlimited" },
};

function fallbackTitle(name: string) {
  return name.replace(/^policy:/, "").replace(/_(bool|u32)$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/** Split "Security policy: Allow Access. The users…" into title and description. */
export function usePolicyDocs() {
  const cat = useCatalog();
  const fields = cat.data?.types["VpnRpcSetUser"]?.fields ?? [];
  const map = new Map<string, { title: string; doc: string }>();
  for (const f of fields) {
    if (!f.name.startsWith("policy:")) continue;
    const d = f.doc.replace(/^Security policy:\s*/, "");
    const i = d.indexOf(". ");
    map.set(f.name, i > 0 ? { title: d.slice(0, i), doc: d.slice(i + 2) } : { title: d.replace(/\.$/, "") || fallbackTitle(f.name), doc: "" });
  }
  return (name: string) => map.get(name) ?? { title: fallbackTitle(name), doc: "" };
}

function fmtBps(n: number) {
  if (!n) return "unlimited";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} Gbps`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} Mbps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kbps`;
  return `${n} bps`;
}

/** Short human summary of the non-default policy values (for tables/badges). */
export function policySummary(s: Struct): string[] {
  const out: string[] = [];
  if (s["policy:Access_bool"] === false) out.push("Access denied");
  if (s["policy:MaxUpload_u32"]) out.push(`Up ${fmtBps(Number(s["policy:MaxUpload_u32"]))}`);
  if (s["policy:MaxDownload_u32"]) out.push(`Down ${fmtBps(Number(s["policy:MaxDownload_u32"]))}`);
  if (s["policy:VLanId_u32"]) out.push(`VLAN ${s["policy:VLanId_u32"]}`);
  if (s["policy:MultiLogins_u32"]) out.push(`Max ${s["policy:MultiLogins_u32"]} logins`);
  if (s["policy:PrivacyFilter_bool"]) out.push("Privacy filter");
  if (s["policy:MonitorPort_bool"]) out.push("Monitoring allowed");
  return out;
}

export function PolicyEditor({
  value, onChange, fields, readOnly, testId = "policy-editor",
}: {
  value: Struct;
  onChange: (patch: Struct) => void;
  /** Restrict to a subset of policy fields (e.g. CASCADE_POLICY_FIELDS). */
  fields?: string[];
  readOnly?: boolean;
  testId?: string;
}) {
  const docs = usePolicyDocs();
  const allowed = new Set(fields ?? ALL_POLICY_FIELDS);
  const groups = POLICY_GROUPS.map((g) => ({ ...g, fields: g.fields.filter((f) => allowed.has(f)) })).filter((g) => g.fields.length);
  const changed = (g: PolicyGroupDef) => g.fields.filter((f) => value[f] !== undefined && value[f] !== POLICY_DEFAULTS[f]).length;

  return (
    <Accordion multiple defaultValue={groups.map((g) => g.key)} variant="separated" data-testid={testId}>
      {groups.map((g) => (
        <Accordion.Item key={g.key} value={g.key}>
          <Accordion.Control>
            <Group gap="xs">
              <Text fw={600} size="sm">{g.title}</Text>
              {changed(g) > 0 && <Badge size="xs" variant="light">{changed(g)} customised</Badge>}
            </Group>
            <Text size="xs" c="dimmed">{g.description}</Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              {g.fields.filter((f) => f.endsWith("_bool")).map((f) => {
                const d = docs(f);
                return (
                  <Switch key={f} label={d.title} description={d.doc} checked={!!(value[f] ?? POLICY_DEFAULTS[f])}
                    disabled={readOnly} onChange={(e) => onChange({ [f]: e.currentTarget.checked })} data-testid={`policy-${f}`} />
                );
              })}
              {g.fields.some((f) => f.endsWith("_u32")) && (
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                  {g.fields.filter((f) => f.endsWith("_u32")).map((f) => {
                    const d = docs(f);
                    const u = UNITS[f] ?? {};
                    const v = Number(value[f] ?? POLICY_DEFAULTS[f] ?? 0);
                    return (
                      <NumberInput key={f} label={d.title}
                        description={<>{d.doc}{u.hint && <><br /><b>{u.hint}</b></>}{f.includes("MaxUpload") || f.includes("MaxDownload") ? <> — {fmtBps(v)}</> : null}</>}
                        value={v} min={0} max={u.max} suffix={u.suffix} allowDecimal={false} allowNegative={false} thousandSeparator=","
                        readOnly={readOnly} onChange={(x) => onChange({ [f]: Number(x) || 0 })} data-testid={`policy-${f}`} />
                    );
                  })}
                </SimpleGrid>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion>
  );
}
