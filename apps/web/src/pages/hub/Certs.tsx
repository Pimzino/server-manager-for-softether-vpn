import { useEffect, useState, type ReactNode } from "react";
import {
  ActionIcon, Alert, Badge, Button, Code, FileButton, Group, Modal, SimpleGrid, Stack, Tabs, Text, Textarea, TextInput, Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconCertificate, IconCertificateOff, IconDownload, IconEye, IconFileCertificate, IconPencil, IconPlus, IconTrash, IconUpload,
} from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, Copyable, ErrorAlert, KeyValue, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { b64ToHex, hexToB64, isHex, useDocs, useHubAccess } from "../../components/hub-a/shared";
import {
  b64ToBytes, certsFromFile, derB64ToPem, dnGet, dnToString, md5, parseCert, sha, toHex, type CertInfo,
} from "../../components/hub-a/x509";
import { notifyError, useRpc, useRpcMutation } from "../../lib/hooks";
import { rpc } from "../../lib/api";
import { downloadB64, downloadText, dt } from "../../lib/format";
import { useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";

// ---------------------------------------------------------------------------------------------
// Trusted CA certificates
// ---------------------------------------------------------------------------------------------

interface CaItem { Key_u32: number; SubjectName_utf: string; IssuerName_utf: string; Expires_dt: string }

function safeName(s: string) {
  return (s.split(",")[0] || "certificate").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
}

function ExpiryBadge({ date }: { date: string | Date | null | undefined }) {
  if (!date) return null;
  const d = dayjs(date);
  const days = d.diff(dayjs(), "day");
  if (days < 0) return <Badge color="red" variant="light">Expired</Badge>;
  if (days < 30) return <Badge color="orange" variant="light">Expires in {days}d</Badge>;
  return <Badge color="green" variant="light">Valid</Badge>;
}

function CertDetails({ b64 }: { b64: string }) {
  const [info, setInfo] = useState<{ cert: CertInfo | null; sha1: string; sha256: string; md5: string; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const der = b64ToBytes(b64);
      let cert: CertInfo | null = null;
      let error: string | undefined;
      try { cert = parseCert(der); } catch (e) { error = (e as Error).message; }
      const [s1, s256] = await Promise.all([sha("SHA-1", der), sha("SHA-256", der)]);
      if (!cancelled) setInfo({ cert, sha1: toHex(s1), sha256: toHex(s256), md5: toHex(md5(der)), error });
    })();
    return () => { cancelled = true; };
  }, [b64]);
  if (!info) return null;
  const c = info.cert;
  return (
    <KeyValue rows={[
      ...(c ? [
        ["Subject", dnToString(c.subject)],
        ["Issuer", <>{dnToString(c.issuer)} {c.selfSigned && <Badge size="xs" variant="outline" ml={4}>self-signed</Badge>}</>],
        ["Serial number", <Copyable value={toHex(c.serial)} />],
        ["Valid from", dt(c.notBefore?.toISOString())],
        ["Valid until", <Group gap={6}>{dt(c.notAfter?.toISOString())}<ExpiryBadge date={c.notAfter} /></Group>],
      ] as [ReactNode, ReactNode][] : [["Parse error", info.error ?? "unknown"]] as [ReactNode, ReactNode][]),
      ["SHA-256 fingerprint", <Copyable value={info.sha256} />],
      ["SHA-1 fingerprint", <Copyable value={info.sha1} />],
      ["MD5 fingerprint", <Copyable value={info.md5} />],
    ]} />
  );
}

function ViewCaModal({ serverId, hub, item, onClose }: { serverId: number; hub: string; item: CaItem | null; onClose: () => void }) {
  const q = useRpc<{ Cert_bin?: string }>(serverId, "GetCa", { HubName_str: hub, Key_u32: item?.Key_u32 ?? 0 }, { enabled: !!item });
  const b64 = q.data?.Cert_bin ?? "";
  const name = safeName(item?.SubjectName_utf ?? "ca");
  return (
    <Modal opened={!!item} onClose={onClose} title="Trusted CA certificate" size="xl" centered>
      <QueryState query={q}>
        {b64 && (
          <Stack>
            <CertDetails b64={b64} />
            <Textarea label="PEM" value={derB64ToPem(b64)} readOnly autosize minRows={6} maxRows={12} ff="monospace" styles={{ input: { fontSize: 11 } }} />
            <Group justify="flex-end">
              <Button variant="light" leftSection={<IconDownload size={16} />} onClick={() => downloadText(`${name}.pem`, derB64ToPem(b64), "application/x-pem-file")} data-testid="ca-download-pem">Download PEM</Button>
              <Button variant="light" leftSection={<IconDownload size={16} />} onClick={() => downloadB64(`${name}.cer`, b64, "application/pkix-cert")} data-testid="ca-download-der">Download DER (.cer)</Button>
            </Group>
          </Stack>
        )}
      </QueryState>
    </Modal>
  );
}

function AddCaModal({ serverId, hub, opened, onClose }: { serverId: number; hub: string; opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [pem, setPem] = useState("");
  const [certs, setCerts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (opened) { setPem(""); setCerts([]); setError(null); } }, [opened]);

  const loadFile = async (f: File | null) => {
    if (!f) return;
    const found = certsFromFile(new Uint8Array(await f.arrayBuffer()));
    if (!found.length) { notifyError(new Error("No X.509 certificate found in this file (expected PEM or DER)"), "Invalid file"); return; }
    setCerts(found);
    setPem(found.map((c) => derB64ToPem(c)).join(""));
  };
  const onPaste = (text: string) => {
    setPem(text);
    setCerts(certsFromFile(new TextEncoder().encode(text)));
  };

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      for (const c of certs) await rpc(serverId, "AddCa", { HubName_str: hub, Cert_bin: c });
      notifications.show({ color: "green", message: `${certs.length} trusted CA certificate(s) added` });
      void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Add trusted CA certificate" size="lg" centered>
      <Stack>
        <Text size="sm" c="dimmed">
          Upload an X.509 certificate in PEM (.pem/.crt) or DER (.cer/.der) format, or paste PEM text. A PEM bundle adds every
          certificate it contains. Only the certificate is needed — never upload a private key.
        </Text>
        <FileButton onChange={loadFile} accept=".pem,.crt,.cer,.der,application/x-x509-ca-cert,application/pkix-cert,application/x-pem-file">
          {(props) => <Button {...props} variant="light" leftSection={<IconUpload size={16} />} w="fit-content" data-testid="ca-file">Choose certificate file…</Button>}
        </FileButton>
        <Textarea label="PEM" placeholder="-----BEGIN CERTIFICATE-----" value={pem} onChange={(e) => onPaste(e.currentTarget.value)}
          autosize minRows={6} maxRows={12} ff="monospace" styles={{ input: { fontSize: 11 } }} data-testid="ca-pem" />
        {certs.map((c, i) => (
          <Alert key={i} variant="light" color="blue" icon={<IconFileCertificate size={16} />} title={`Certificate ${i + 1}`} p="xs">
            <CertDetails b64={c} />
          </Alert>
        ))}
        {error != null && <ErrorAlert error={error} />}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={!certs.length} data-testid="ca-add-submit">
            Add {certs.length > 1 ? `${certs.length} certificates` : "certificate"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function TrustedCas({ serverId, hub, canWrite }: { serverId: number; hub: string; canWrite: boolean }) {
  const q = useRpc<{ CAList?: CaItem[] }>(serverId, "EnumCa", { HubName_str: hub }, { enabled: !!hub });
  const del = useRpcMutation(serverId, "DeleteCa", { success: "Trusted CA certificate deleted" });
  const [view, setView] = useState<CaItem | null>(null);
  const [adding, setAdding] = useState(false);
  const download = async (c: CaItem) => {
    try {
      const r = await rpc<{ Cert_bin?: string }>(serverId, "GetCa", { HubName_str: hub, Key_u32: c.Key_u32 });
      if (r.Cert_bin) downloadText(`${safeName(c.SubjectName_utf)}.pem`, derB64ToPem(r.Cert_bin), "application/x-pem-file");
    } catch (e) { notifyError(e, "GetCa"); }
  };
  return (
    <Section
      title="Trusted CA certificates"
      description="Users with “signed certificate” authentication are accepted when their client certificate is issued by one of these CAs (and matches the user's name/serial constraints). Also used to verify cascade server certificates where enabled."
    >
      <QueryState query={q}>
        <DataTable
          testId="ca-table"
          data={q.data?.CAList}
          rowKey={(c) => c.Key_u32}
          initialSort={{ key: "SubjectName_utf", dir: "asc" }}
          empty="No trusted CA certificates"
          onRowClick={setView}
          toolbar={canWrite && <Button size="sm" leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)} data-testid="add-ca">Add CA certificate</Button>}
          columns={[
            { key: "SubjectName_utf", title: "Subject", render: (c) => <Text size="sm" fw={600}>{c.SubjectName_utf}</Text> },
            { key: "IssuerName_utf", title: "Issuer", render: (c) => <Text size="sm">{c.IssuerName_utf}</Text> },
            {
              key: "Expires_dt", title: "Expires",
              render: (c) => <Group gap={6} wrap="nowrap"><Text size="sm">{dt(c.Expires_dt)}</Text><ExpiryBadge date={c.Expires_dt} /></Group>,
            },
            { key: "Key_u32", title: "Key", render: (c) => <Text size="xs" c="dimmed" ff="monospace">{c.Key_u32}</Text> },
            {
              key: "actions", title: "", sortable: false, align: "right",
              render: (c) => (
                <Group gap={4} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                  <Tooltip label="View"><ActionIcon variant="subtle" onClick={() => setView(c)} aria-label="View certificate"><IconEye size={16} /></ActionIcon></Tooltip>
                  <Tooltip label="Download PEM"><ActionIcon variant="subtle" onClick={() => download(c)} aria-label="Download certificate"><IconDownload size={16} /></ActionIcon></Tooltip>
                  {canWrite && (
                    <ConfirmButton
                      title="Delete trusted CA certificate?"
                      message={<>Users whose certificates were issued by <b>{c.SubjectName_utf}</b> will no longer be able to authenticate with signed-certificate authentication.</>}
                      confirmLabel="Delete"
                      leftSection={<IconTrash size={14} />}
                      onConfirm={() => del.mutateAsync({ HubName_str: hub, Key_u32: c.Key_u32 })}
                    >Delete</ConfirmButton>
                  )}
                </Group>
              ),
            },
          ]}
        />
      </QueryState>
      <ViewCaModal serverId={serverId} hub={hub} item={view} onClose={() => setView(null)} />
      <AddCaModal serverId={serverId} hub={hub} opened={adding} onClose={() => setAdding(false)} />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Certificate revocation list
// ---------------------------------------------------------------------------------------------

interface CrlItem { Key_u32: number; CrlInfo_utf: string }
interface Crl {
  HubName_str?: string;
  Key_u32?: number;
  CommonName_utf?: string;
  Organization_utf?: string;
  Unit_utf?: string;
  Country_utf?: string;
  State_utf?: string;
  Local_utf?: string;
  Serial_bin?: string;
  DigestMD5_bin?: string;
  DigestSHA1_bin?: string;
}

interface CrlForm { cn: string; o: string; ou: string; c: string; st: string; l: string; serial: string; md5: string; sha1: string }
const EMPTY_CRL: CrlForm = { cn: "", o: "", ou: "", c: "", st: "", l: "", serial: "", md5: "", sha1: "" };

const crlToForm = (r: Crl): CrlForm => ({
  cn: r.CommonName_utf ?? "", o: r.Organization_utf ?? "", ou: r.Unit_utf ?? "", c: r.Country_utf ?? "",
  st: r.State_utf ?? "", l: r.Local_utf ?? "", serial: b64ToHex(r.Serial_bin), md5: b64ToHex(r.DigestMD5_bin), sha1: b64ToHex(r.DigestSHA1_bin),
});

/** Parse "Subject=\"CN=bob, O=Acme\", Serial=\"01 23\", MD5=\"..\", SHA1=\"..\"" into parts. */
function parseCrlInfo(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function CrlModal({ serverId, hub, editKey, opened, onClose }: { serverId: number; hub: string; editKey: number | null; opened: boolean; onClose: () => void }) {
  const doc = useDocs("VpnRpcCrl");
  const existing = useRpc<Crl>(serverId, "GetCrl", { HubName_str: hub, Key_u32: editKey ?? 0 }, { enabled: opened && editKey !== null });
  const [f, setF] = useState<CrlForm>(EMPTY_CRL);
  useEffect(() => {
    if (!opened) return;
    if (editKey === null) setF(EMPTY_CRL);
    else if (existing.data) setF(crlToForm(existing.data));
  }, [opened, editKey, existing.data]);
  const add = useRpcMutation(serverId, "AddCrl", { success: "Revoked certificate entry added", onSuccess: onClose });
  const set = useRpcMutation(serverId, "SetCrl", { success: "Revoked certificate entry updated", onSuccess: onClose });

  const fromCert = async (file: File | null) => {
    if (!file) return;
    const [b64] = certsFromFile(new Uint8Array(await file.arrayBuffer()));
    if (!b64) { notifyError(new Error("No X.509 certificate found in this file"), "Invalid file"); return; }
    const der = b64ToBytes(b64);
    try {
      const c = parseCert(der);
      const s1 = await sha("SHA-1", der);
      setF({
        cn: dnGet(c.subject, "CN"), o: dnGet(c.subject, "O"), ou: dnGet(c.subject, "OU"), c: dnGet(c.subject, "C"),
        st: dnGet(c.subject, "ST"), l: dnGet(c.subject, "L"), serial: toHex(c.serial, " "), md5: toHex(md5(der), " "), sha1: toHex(s1, " "),
      });
    } catch (e) { notifyError(e, "Could not parse certificate"); }
  };

  const errors = {
    serial: f.serial && !isHex(f.serial) ? "Hexadecimal bytes, e.g. 01 A3 FF" : undefined,
    md5: f.md5 && !isHex(f.md5, 16) ? "16 bytes (32 hex digits)" : undefined,
    sha1: f.sha1 && !isHex(f.sha1, 20) ? "20 bytes (40 hex digits)" : undefined,
  };
  const empty = Object.values(f).every((v) => !v.trim());
  const invalid = Object.values(errors).some(Boolean) || empty;

  const submit = () => {
    const p: Crl = {
      HubName_str: hub,
      CommonName_utf: f.cn.trim(), Organization_utf: f.o.trim(), Unit_utf: f.ou.trim(), Country_utf: f.c.trim(),
      State_utf: f.st.trim(), Local_utf: f.l.trim(),
      Serial_bin: hexToB64(f.serial), DigestMD5_bin: hexToB64(f.md5), DigestSHA1_bin: hexToB64(f.sha1),
    };
    if (editKey === null) add.mutate(p as Record<string, unknown>);
    else set.mutate({ ...p, Key_u32: editKey } as Record<string, unknown>);
  };

  const field = (k: keyof CrlForm, label: string, name: string, extra?: { placeholder?: string; error?: string; mono?: boolean }) => (
    <TextInput
      label={label}
      description={doc(name)}
      value={f[k]}
      onChange={(e) => setF({ ...f, [k]: e.currentTarget.value })}
      placeholder={extra?.placeholder}
      error={extra?.error}
      ff={extra?.mono ? "monospace" : undefined}
      data-testid={`crl-${k}`}
    />
  );

  return (
    <Modal opened={opened} onClose={onClose} title={editKey === null ? "Add revoked certificate" : "Edit revoked certificate"} size="xl" centered>
      {editKey !== null && existing.error ? <ErrorAlert error={existing.error} /> : (
        <Stack>
          <Text size="sm" c="dimmed">
            A client certificate is rejected when it matches <b>all</b> of the conditions you fill in. Normally a digest (MD5 or SHA-1)
            alone is enough; alternatively combine subject fields and serial number. Empty fields are ignored.
          </Text>
          <FileButton onChange={fromCert} accept=".pem,.crt,.cer,.der">
            {(props) => <Button {...props} variant="light" size="xs" w="fit-content" leftSection={<IconFileCertificate size={14} />} data-testid="crl-from-cert">Fill from certificate file…</Button>}
          </FileButton>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            {field("cn", "Common name (CN)", "CommonName_utf")}
            {field("o", "Organization (O)", "Organization_utf")}
            {field("ou", "Organizational unit (OU)", "Unit_utf")}
            {field("c", "Country (C)", "Country_utf", { placeholder: "GB" })}
            {field("st", "State / province (ST)", "State_utf")}
            {field("l", "Locality (L)", "Local_utf")}
          </SimpleGrid>
          {field("serial", "Serial number (hex)", "Serial_bin", { placeholder: "01 23 45 67", error: errors.serial, mono: true })}
          {field("md5", "MD5 digest (hex, 128 bit)", "DigestMD5_bin", { placeholder: "32 hex digits", error: errors.md5, mono: true })}
          {field("sha1", "SHA-1 digest (hex, 160 bit)", "DigestSHA1_bin", { placeholder: "40 hex digits", error: errors.sha1, mono: true })}
          {editKey !== null && <Text size="xs" c="dimmed">Saving an edited entry gives it a new key id.</Text>}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} loading={add.isPending || set.isPending} disabled={invalid || (editKey !== null && existing.isLoading)} data-testid="crl-submit">
              {editKey === null ? "Add entry" : "Save entry"}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function RevocationList({ serverId, hub, canWrite }: { serverId: number; hub: string; canWrite: boolean }) {
  const q = useRpc<{ CRLList?: CrlItem[] }>(serverId, "EnumCrl", { HubName_str: hub }, { enabled: !!hub });
  const del = useRpcMutation(serverId, "DelCrl", { success: "Revoked certificate entry deleted" });
  const [modal, setModal] = useState<{ key: number | null } | null>(null);
  const rows = (q.data?.CRLList ?? []).map((r) => ({ ...r, parts: parseCrlInfo(r.CrlInfo_utf) }));
  return (
    <Section
      title="Certificate revocation list"
      description="Client certificates matching an entry here are refused for certificate-based authentication on this hub, even if they are otherwise trusted."
    >
      <QueryState query={q}>
        <DataTable
          testId="crl-table"
          data={rows}
          rowKey={(r) => r.Key_u32}
          empty="No revoked certificates"
          onRowClick={canWrite ? (r) => setModal({ key: r.Key_u32 }) : undefined}
          toolbar={canWrite && <Button size="sm" leftSection={<IconPlus size={16} />} onClick={() => setModal({ key: null })} data-testid="add-crl">Add revoked certificate</Button>}
          columns={[
            { key: "subject", title: "Subject", value: (r) => r.parts.Subject ?? "", render: (r) => <Text size="sm">{r.parts.Subject || <Text span c="dimmed" size="sm">any</Text>}</Text> },
            { key: "serial", title: "Serial", value: (r) => r.parts.Serial ?? "", render: (r) => r.parts.Serial ? <Code>{r.parts.Serial}</Code> : "–" },
            {
              key: "digest", title: "Digests", sortable: false, value: (r) => `${r.parts.MD5 ?? ""} ${r.parts.SHA1 ?? ""}`,
              render: (r) => (
                <Stack gap={2}>
                  {r.parts.MD5 && <Text size="xs" ff="monospace"><b>MD5</b> {r.parts.MD5}</Text>}
                  {r.parts.SHA1 && <Text size="xs" ff="monospace"><b>SHA1</b> {r.parts.SHA1}</Text>}
                  {!r.parts.MD5 && !r.parts.SHA1 && "–"}
                </Stack>
              ),
            },
            { key: "Key_u32", title: "Key", render: (r) => <Text size="xs" c="dimmed" ff="monospace">{r.Key_u32}</Text> },
            {
              key: "actions", title: "", sortable: false, align: "right",
              render: (r) => canWrite && (
                <Group gap={4} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                  <Tooltip label="Edit"><ActionIcon variant="subtle" onClick={() => setModal({ key: r.Key_u32 })} aria-label="Edit entry"><IconPencil size={16} /></ActionIcon></Tooltip>
                  <ConfirmButton
                    title="Delete revoked certificate entry?"
                    message="Certificates matching this entry will be accepted again (if otherwise trusted)."
                    confirmLabel="Delete"
                    leftSection={<IconTrash size={14} />}
                    onConfirm={() => del.mutateAsync({ HubName_str: hub, Key_u32: r.Key_u32 })}
                  >Delete</ConfirmButton>
                </Group>
              ),
            },
          ]}
        />
      </QueryState>
      <CrlModal serverId={serverId} hub={hub} editKey={modal?.key ?? null} opened={!!modal} onClose={() => setModal(null)} />
    </Section>
  );
}

export default function HubCertsPage() {
  const { serverId, hub, role, canWrite } = useHubAccess();
  const [tab, setTab] = useState<string | null>("ca");
  return (
    <>
      <PageHeader
        title="Trusted CAs & revoked certificates"
        description="Certificate trust store of this Virtual Hub for users with signed-certificate authentication. Changes take effect for new connections."
      />
      {!canWrite && <ReadOnlyNotice role={role} />}
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List mb="md">
          <Tabs.Tab value="ca" leftSection={<IconCertificate size={16} />} data-testid="tab-ca">Trusted CAs</Tabs.Tab>
          <Tabs.Tab value="crl" leftSection={<IconCertificateOff size={16} />} data-testid="tab-crl">Revoked certificates (CRL)</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="ca"><TrustedCas serverId={serverId} hub={hub} canWrite={canWrite} /></Tabs.Panel>
        <Tabs.Panel value="crl"><RevocationList serverId={serverId} hub={hub} canWrite={canWrite} /></Tabs.Panel>
      </Tabs>
    </>
  );
}
