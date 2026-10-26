// Server › Capabilities: functions and limits the server reports (GetCaps), with filters, details and CSV export.
import { useMemo, useState } from "react";
import { Button, SegmentedControl } from "@mantine/core";
import { IconCopy, IconDownload, IconListCheck } from "@tabler/icons-react";
import { downloadText, num, serverVersion } from "../../lib/format";
import { notifyError, notifySuccess, useCaps } from "../../lib/hooks";
import { DataTable, Inspector, Mono, PageHeader, PropertyList, StatusBadge, type ContextMenuItem } from "../../design";
import { toCsv } from "../../components/domain/util";
import { Unreachable, safeName, useServerPage } from "./_server-protocols-security/shared";

interface CapRow { idx: number; name: string; value: number; desc: string; kind: "bool" | "int" | "other"; label: string }

const ACRONYMS: Record<string, string> = {
  ipsec: "IPsec", sstp: "SSTP", openvpn: "OpenVPN", ddns: "DDNS", qos: "QoS", radius: "RADIUS", crl: "CRL", ac: "AC", acl: "ACL",
  ipv6: "IPv6", vlan: "VLAN", l3: "L3", sw: "switch", if: "interface", udp: "UDP", aes: "AES", ni: "NI", vm: "VM", mac: "MAC", ip: "IP",
  tcp: "TCP", url: "URL", msg: "message", rw: "read/write", eth: "Ethernet", secnat: "SecureNAT", securenat: "SecureNAT", vpn3: "VPN 3", vpn4: "VPN 4",
  tap: "TAP", pcap: "pcap", nat: "NAT", dhcp: "DHCP", cert: "certificate", ex: "extended", max: "maximum", lb: "local bridge", wg: "WireGuard",
};

/** "b_support_ipsec" → "Support IPsec" (used when the server gives no description). */
function readable(name: string): string {
  const s = name.replace(/^(b|i)_/, "").replace(/suppport/, "support").split("_").filter(Boolean).map((w) => ACRONYMS[w.toLowerCase()] ?? w).join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const UNLIMITED = 0xffffffff;
const FILTERS = { all: "All", yes: "Supported", no: "Not Supported", lim: "Limits" } as const;
type Filter = keyof typeof FILTERS;

function Value({ r }: { r: CapRow }) {
  if (r.kind === "bool") return <StatusBadge status={r.value ? "ok" : "off"}>{r.value ? "Yes" : "No"}</StatusBadge>;
  if (r.value === UNLIMITED) return <span title={num(r.value)}>Unlimited</span>;
  return <span className="sem-num">{num(r.value)}</span>;
}

export default function CapsPage() {
  const { serverId, s, reachable, ready } = useServerPage();
  const caps = useCaps(serverId);
  const [filter, setFilter] = useState<Filter>("all");
  const [detail, setDetail] = useState<CapRow | null>(null);

  const rows = useMemo<CapRow[]>(() => {
    const seen = new Set<string>();
    const out: CapRow[] = [];
    (caps.data?.CapsList ?? []).forEach((c, idx) => {
      const x = c as { CapsName_str: string; CapsValue_u32: number; CapsDescrption_utf?: string };
      if (seen.has(x.CapsName_str)) return; // the server reports a few caps twice
      seen.add(x.CapsName_str);
      const kind = x.CapsName_str.startsWith("b_") ? "bool" : x.CapsName_str.startsWith("i_") ? "int" : "other";
      const desc = (x.CapsDescrption_utf ?? "").trim();
      out.push({ idx, name: x.CapsName_str, value: x.CapsValue_u32, desc, kind, label: desc || readable(x.CapsName_str) });
    });
    return out;
  }, [caps.data]);
  const counts: Record<Filter, number> = {
    all: rows.length,
    yes: rows.filter((r) => r.kind === "bool" && r.value).length,
    no: rows.filter((r) => r.kind === "bool" && !r.value).length,
    lim: rows.filter((r) => r.kind !== "bool").length,
  };
  const shown = rows.filter((r) => (filter === "all" ? true : filter === "yes" ? r.kind === "bool" && r.value !== 0 : filter === "no" ? r.kind === "bool" && r.value === 0 : r.kind !== "bool"));

  const exportCsv = async () => {
    try {
      const res = await downloadText(`caps-${safeName(s?.name ?? String(serverId))}.csv`, toCsv([["name", "value", "description"], ...rows.map((r) => [r.name, r.value, r.desc])]), "text/csv");
      if (res.saved) notifySuccess(`Saved ${rows.length} capabilities`);
    } catch (e) { notifyError(e, "Couldn’t save the CSV file"); }
  };
  const menu = (r: CapRow): ContextMenuItem[] => [
    { label: "Show Details", icon: <IconListCheck size={14} />, onClick: () => setDetail(r) },
    { label: "Copy Name", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(r.name), testId: `caps-copy-${r.name}` },
    { label: "Copy Value", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(String(r.value)) },
  ];

  if (!s) return null;
  const version = serverVersion(s.state?.info);
  return (
    <>
      <PageHeader
        title="Capabilities"
        meta={caps.data ? <>{counts.all} capabilities · {counts.yes} supported{version ? <> · {version}</> : null}</> : undefined}
        description="Functions and limits the server reports. They depend on the edition, the version and the clustering role."
        actions={ready && <Button variant="default" leftSection={<IconDownload size={14} />} onClick={() => void exportCsv()} disabled={!rows.length} data-testid="caps-export">Export CSV…</Button>}
      />
      {!reachable && <Unreachable serverId={serverId} name={s.name} error={s.state?.error} checkedAt={s.state?.checkedAt} />}
      {reachable && (
        <DataTable
          testId="caps-table" aria-label="Capabilities"
          data={caps.data ? shown : undefined} loading={caps.isLoading} error={caps.error} onRetry={() => void caps.refetch()}
          rowKey={(r) => r.name} selectable="single" initialSort={{ key: "label", dir: "asc" }}
          onRowOpen={setDetail} contextMenu={menu} rowTestId={(r) => `caps-row-${r.name}`}
          rowTone={(r) => (r.kind === "bool" && !r.value ? "dim" : undefined)}
          searchPlaceholder="Filter capabilities"
          filters={(
            <SegmentedControl size="xs" value={filter} onChange={(v) => setFilter(v as Filter)} aria-label="Show" data-testid="caps-filter"
              data={(Object.keys(FILTERS) as Filter[]).map((f) => ({ value: f, label: `${FILTERS[f]} (${counts[f]})` }))} />
          )}
          empty={{ title: "No capabilities", icon: <IconListCheck size={28} stroke={1.4} />, description: "The server didn’t report any capabilities." }}
          columns={[
            { key: "label", title: "Capability", truncate: true, render: (r) => <span title={r.label}>{r.label}</span> },
            { key: "name", title: "Name", width: 240, render: (r) => <Mono dim>{r.name}</Mono> },
            { key: "value", title: "Value", width: 110, align: "right", value: (r) => r.value, render: (r) => <Value r={r} /> },
          ]}
        />
      )}
      <Inspector opened={!!detail} onClose={() => setDetail(null)} title={detail?.label ?? ""} subtitle="Capability" icon={<IconListCheck size={18} stroke={1.5} />} testId="caps-inspector">
        {detail && (
          <PropertyList labelWidth={100} items={[
            { label: "Name", value: <Mono>{detail.name}</Mono> },
            { label: "Type", value: detail.kind === "bool" ? "Flag (b_)" : detail.kind === "int" ? "Limit (i_)" : "Other" },
            { label: "Value", value: <Value r={detail} /> },
            { label: "Raw value", value: <Mono>{String(detail.value)}</Mono> },
            { label: "Description", value: detail.desc || <span className="sem-dim">None</span> },
          ]} />
        )}
      </Inspector>
    </>
  );
}
