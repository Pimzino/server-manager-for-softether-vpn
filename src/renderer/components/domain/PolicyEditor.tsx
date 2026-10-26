// Security policy editor shared by Users, Groups and Cascade Connections.
// Field list and descriptions come from the API catalog (type VpnRpcSetUser, fields "policy:*").
// Layout: one grouped FormSection per policy group (System Settings style), a switch or number per row.
import { NumberInput, Switch } from "@mantine/core";
import { useCatalog } from "../../lib/hooks";
import { FormRow, FormSection, Tag } from "../../design";

type Struct = Record<string, unknown>;

interface PolicyGroupDef { key: string; title: string; description: string; fields: string[] }

/** Grouping of every policy:* field (Ver3 is internal and always true). */
export const POLICY_GROUPS: PolicyGroupDef[] = [
  {
    key: "access", title: "Access and session behaviour", description: "Whether the user may connect and what the session is allowed to do.",
    fields: ["policy:Access_bool", "policy:MonitorPort_bool", "policy:NoBridge_bool", "policy:NoRouting_bool", "policy:NoQoS_bool",
      "policy:FixPassword_bool", "policy:NoSavePassword_bool"],
  },
  {
    key: "security", title: "Security filters", description: "Anti-spoofing and isolation filters applied to the session’s packets.",
    fields: ["policy:PrivacyFilter_bool", "policy:CheckMac_bool", "policy:CheckIP_bool", "policy:ArpDhcpOnly_bool",
      "policy:NoServer_bool", "policy:NoBroadcastLimiter_bool"],
  },
  {
    key: "limits", title: "Limits", description: "Connection, address and bandwidth limits. 0 means unlimited or not set.",
    fields: ["policy:MaxConnection_u32", "policy:TimeOut_u32", "policy:MultiLogins_u32", "policy:AutoDisconnect_u32",
      "policy:MaxMac_u32", "policy:MaxIP_u32", "policy:MaxIPv6_u32", "policy:MaxUpload_u32", "policy:MaxDownload_u32"],
  },
  {
    key: "dhcp", title: "DHCP and routing (IPv4)", description: "DHCP and IPv4 routing for the session.",
    fields: ["policy:DHCPFilter_bool", "policy:DHCPNoServer_bool", "policy:DHCPForce_bool"],
  },
  {
    key: "ipv6", title: "IPv6", description: "Router advertisements, DHCPv6, routing and duplicate-address filters.",
    fields: ["policy:RSandRAFilter_bool", "policy:RAFilter_bool", "policy:DHCPv6Filter_bool", "policy:DHCPv6NoServer_bool",
      "policy:NoRoutingV6_bool", "policy:CheckIPv6_bool", "policy:NoServerV6_bool",
      "policy:NoIPv6DefaultRouterInRA_bool", "policy:NoIPv6DefaultRouterInRAWhenIPv6_bool"],
  },
  {
    key: "filters", title: "Protocol filters and VLAN", description: "Drop whole protocol families, or tag the session into a VLAN.",
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

const UNITS: Record<string, { unit?: string; max?: number; hint?: string }> = {
  "policy:MaxConnection_u32": { max: 32, hint: "1–32 TCP connections." },
  "policy:TimeOut_u32": { unit: "s", hint: "In seconds." },
  "policy:AutoDisconnect_u32": { unit: "s", hint: "In seconds; 0 never disconnects." },
  "policy:MaxUpload_u32": { unit: "bps", hint: "Bits per second; 0 is unlimited." },
  "policy:MaxDownload_u32": { unit: "bps", hint: "Bits per second; 0 is unlimited." },
  "policy:VLanId_u32": { max: 4095, hint: "1–4095; 0 adds no VLAN tag." },
  "policy:MultiLogins_u32": { hint: "0 is unlimited." },
  "policy:MaxMac_u32": { hint: "0 is unlimited." },
  "policy:MaxIP_u32": { hint: "0 is unlimited." },
  "policy:MaxIPv6_u32": { hint: "0 is unlimited." },
};

function fallbackTitle(name: string) {
  return name.replace(/^policy:/, "").replace(/_(bool|u32)$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/** Split "Security policy: Allow Access. The users…" into a title and a description. */
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

/** "1.50 Mbps", "unlimited" for 0. */
export function fmtBps(n: number) {
  if (!n) return "unlimited";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} Gbps`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} Mbps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kbps`;
  return `${n} bps`;
}

/** Short human summary of the non-default policy values (for table cells and tags). */
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

/**
 * Editable security policy. `onChange` receives a patch ({ "policy:X": value }) to merge into the struct.
 * Use inside a Sheet or a settings page; each group is its own grouped box.
 */
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
    <div data-testid={testId}>
      {groups.map((g) => {
        const n = changed(g);
        return (
          <FormSection
            key={g.key}
            testId={`${testId}-${g.key}`}
            title={<span className="sem-row-inline">{g.title}{n > 0 && <Tag color="accent">{n} changed</Tag>}</span>}
            description={g.description}
          >
            {g.fields.map((f) => {
              const d = docs(f);
              if (f.endsWith("_bool")) {
                return (
                  <FormRow key={f} label={d.title} description={d.doc || undefined}>
                    {(id) => (
                      <Switch id={id} checked={!!(value[f] ?? POLICY_DEFAULTS[f])} disabled={readOnly} aria-label={d.title}
                        onChange={(e) => onChange({ [f]: e.currentTarget.checked })} data-testid={`policy-${f}`} />
                    )}
                  </FormRow>
                );
              }
              const u = UNITS[f] ?? {};
              const v = Number(value[f] ?? POLICY_DEFAULTS[f] ?? 0);
              const bps = f.includes("MaxUpload") || f.includes("MaxDownload");
              return (
                <FormRow key={f} label={d.title} description={<>{d.doc}{d.doc && u.hint ? " " : ""}{u.hint}</>}>
                  {(id) => (
                    <div className="sem-row-inline" style={{ flexWrap: "nowrap" }}>
                      <NumberInput id={id} w={150} value={v} min={0} max={u.max} allowDecimal={false} allowNegative={false} thousandSeparator=","
                        readOnly={readOnly} aria-label={d.title} onChange={(x) => onChange({ [f]: Number(x) || 0 })} data-testid={`policy-${f}`}
                        rightSection={u.unit ? <span className="sem-input-unit">{u.unit}</span> : undefined} rightSectionWidth={u.unit ? 40 : undefined} />
                      {bps && <span className="sem-dim sem-num">{fmtBps(v)}</span>}
                    </div>
                  )}
                </FormRow>
              );
            })}
          </FormSection>
        );
      })}
    </div>
  );
}
