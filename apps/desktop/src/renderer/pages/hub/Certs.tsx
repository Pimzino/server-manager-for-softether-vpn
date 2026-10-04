// Hub › Trusted CAs & CRL. The hub's certificate trust store for signed-certificate authentication:
//   * trusted CA certificates (EnumCa / GetCa / AddCa / DeleteCa), with details, fingerprints and PEM/DER export
//   * the certificate revocation list (EnumCrl / GetCrl / AddCrl / SetCrl / DelCrl), editable in a sheet that can be
//     filled from a certificate file.
// Ported from apps/web/src/pages/hub/Certs.tsx.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, SegmentedControl, Textarea, TextInput } from "@mantine/core";
import {
  IconCertificate, IconCertificateOff, IconCopy, IconDeviceFloppy, IconFileCertificate, IconInfoCircle, IconPencil, IconPlus, IconTrash, IconUpload,
} from "@tabler/icons-react";
import { rpc, saveFile } from "../../lib/api";
import { notifyError, notifySuccess, useRpc, useRpcMutation } from "../../lib/hooks";
import { dateShort, dt } from "../../lib/format";
import { useDocs } from "../../components/domain/hooks";
import { b64ToHex, hexToB64, isHex } from "../../components/domain/util";
import { b64ToBytes, certsFromFile, derB64ToPem, dnGet, dnToString, md5, parseCert, sha, toHex, type CertSummary } from "../../components/domain/x509";
import { CERT_FILTERS, openBytes } from "../../components/domain/files";
import { Callout } from "../../components/domain/ui";
import {
  CopyField, DataTable, ErrorState, FingerprintField, FormRow, FormSection, Inspector, PageHeader, PropertyList, PropertySkeleton, Sheet, Tag,
} from "../../design";
import { HubUnreachable, useHubPage } from "./_hub-core/shared";

// ---------------------------------------------------------------------------------------------
// Shared

interface CaItem { Key_u32: number; SubjectName_utf: string; IssuerName_utf: string; Expires_dt: string }

const DAY = 86_400_000;
function safeName(s: string) {
  return (s.split(",")[0].replace(/^\s*CN=/i, "") || "certificate").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
}

function ExpiryTag({ date }: { date: string | Date | null | undefined }) {
  if (!date) return null;
  const days = Math.floor((new Date(date).getTime() - Date.now()) / DAY);
  if (days < 0) return <Tag color="red">Expired</Tag>;
  if (days < 30) return <Tag color="orange">{days === 0 ? "Expires today" : `${days} ${days === 1 ? "day" : "days"} left`}</Tag>;
  return null;
}

const savePem = (name: string, b64: string) =>
  saveFile({ suggestedName: `${name}.pem`, content: derB64ToPem(b64), filters: [{ name: "PEM Certificate", extensions: ["pem", "crt"] }] });
const saveDer = (name: string, b64: string) =>
  saveFile({ suggestedName: `${name}.cer`, content: b64, encoding: "base64", filters: [{ name: "DER Certificate", extensions: ["cer", "der"] }] });

interface Parsed { cert: CertSummary | null; sha1: string; sha256: string; md5: string; error?: string }
function useParsedCert(b64: string | undefined): Parsed | null {
  const [info, setInfo] = useState<Parsed | null>(null);
  useEffect(() => {
    if (!b64) { setInfo(null); return; }
    let cancelled = false;
    void (async () => {
      const der = b64ToBytes(b64);
      let cert: CertSummary | null = null;
      let error: string | undefined;
      try { cert = parseCert(der); } catch (e) { error = (e as Error).message; }
      const [s1, s256] = await Promise.all([sha("SHA-1", der), sha("SHA-256", der)]);
      if (!cancelled) setInfo({ cert, sha1: toHex(s1, ":"), sha256: toHex(s256, ":"), md5: toHex(md5(der), ":"), error });
    })();
    return () => { cancelled = true; };
  }, [b64]);
  return info;
}

/** Subject, issuer, validity and fingerprints of one certificate. */
function CertDetails({ b64, compact, testId }: { b64: string; compact?: boolean; testId?: string }) {
  const info = useParsedCert(b64);
  if (!info) return <PropertySkeleton rows={compact ? 3 : 6} />;
  const c = info.cert;
  const items = c ? [
    { label: "Subject", value: <span style={{ wordBreak: "break-word" }}>{dnToString(c.subject)}</span> },
    { label: "Issuer", value: <span style={{ wordBreak: "break-word" }}>{dnToString(c.issuer)} {c.selfSigned && <Tag>Self-signed</Tag>}</span> },
    { label: "Serial number", value: <CopyField value={toHex(c.serial, ":")} size="sm" /> },
    { label: "Valid from", value: dt(c.notBefore?.toISOString()) },
    { label: "Valid until", value: <span className="sem-row-inline">{dt(c.notAfter?.toISOString())}<ExpiryTag date={c.notAfter} /></span> },
  ] : [{ label: "Can’t read", value: <span className="sem-text-red">{info.error ?? "Unknown format"}</span> }];
  return (
    <div className="sem-stack" style={{ gap: "var(--sem-space-5)" }} data-testid={testId}>
      <PropertyList labelWidth={compact ? 100 : 120} dense items={compact ? items : [...items,
        { label: "SHA-1", value: <CopyField value={info.sha1} size="sm" /> },
        { label: "MD5", value: <CopyField value={info.md5} size="sm" /> },
      ]} />
      {!compact && <FingerprintField value={info.sha256} label="SHA-256 fingerprint" />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Trusted CA certificates

function CaInspector({ serverId, hub, item, onClose, onDelete }: {
  serverId: number; hub: string; item: CaItem | null; onClose: () => void; onDelete: (c: CaItem) => void;
}) {
  const q = useRpc<{ Cert_bin?: string }>(serverId, "GetCa", { HubName_str: hub, Key_u32: item?.Key_u32 ?? 0 }, { enabled: !!item });
  const b64 = q.data?.Cert_bin ?? "";
  const name = safeName(item?.SubjectName_utf ?? "ca");
  return (
    <Inspector
      opened={!!item} onClose={onClose} width={420} testId="ca-inspector"
      title={item?.SubjectName_utf.replace(/^CN=/, "").split(",")[0] ?? "Certificate"}
      subtitle="Trusted CA certificate"
      icon={<IconCertificate size={18} stroke={1.5} />}
      actions={b64 && item ? (
        <>
          <Button size="xs" variant="default" leftSection={<IconDeviceFloppy size={13} />} onClick={() => void savePem(name, b64)} data-testid="ca-download-pem">Save PEM…</Button>
          <Button size="xs" variant="default" leftSection={<IconDeviceFloppy size={13} />} onClick={() => void saveDer(name, b64)} data-testid="ca-download-der">Save DER…</Button>
          <Button size="xs" variant="default" c="var(--sem-red)" leftSection={<IconTrash size={13} />} onClick={() => onDelete(item)} data-testid="ca-inspector-delete">Delete…</Button>
        </>
      ) : undefined}
    >
      {q.error ? <ErrorState error={q.error} inline onRetry={() => void q.refetch()} />
        : !b64 ? <PropertySkeleton rows={6} />
        : (
          <div className="sem-stack" style={{ gap: "var(--sem-space-6)" }}>
            <CertDetails b64={b64} testId="ca-details" />
            <div>
              <div className="sem-fp-label" style={{ marginBottom: "var(--sem-space-2)" }}>PEM</div>
              <Textarea value={derB64ToPem(b64)} readOnly autosize minRows={5} maxRows={10} aria-label="PEM"
                styles={{ input: { fontFamily: "var(--sem-font-mono)", fontSize: "var(--sem-fz-caption)" } }} data-testid="ca-pem-view" />
            </div>
          </div>
        )}
    </Inspector>
  );
}

function AddCaSheet({ serverId, hub, opened, onClose }: { serverId: number; hub: string; opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [pem, setPem] = useState("");
  const [certs, setCerts] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (opened) { setPem(""); setCerts([]); setError(null); setFileName(null); } }, [opened]);

  const chooseFile = async () => {
    const f = await openBytes({ filters: CERT_FILTERS, title: "Choose a CA Certificate" });
    if (!f) return;
    const found = certsFromFile(f.bytes);
    if (!found.length) { notifyError(new Error("The file has no X.509 certificate. Choose a PEM or DER certificate."), "Can’t use this file"); return; }
    setFileName(f.name);
    setCerts(found);
    setPem(found.map((c) => derB64ToPem(c)).join(""));
  };
  const onPaste = (text: string) => {
    setPem(text);
    setFileName(null);
    setCerts(certsFromFile(new TextEncoder().encode(text)));
  };
  const submit = async () => {
    setBusy(true); setError(null);
    let added = 0;
    try {
      for (const c of certs) { await rpc(serverId, "AddCa", { HubName_str: hub, Cert_bin: c }); added++; }
      notifySuccess(added === 1 ? "Trusted CA certificate added" : `${added} trusted CA certificates added`);
      onClose();
    } catch (e) { setError(e); } finally {
      setBusy(false);
      if (added) void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
    }
  };

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={busy} size={620} testId="ca-add-sheet"
      title="Add Trusted CA Certificate" subtitle={`Virtual Hub “${hub}”`} icon={<IconCertificate size={19} stroke={1.5} />}
      footer={(
        <div className="sem-row-inline" style={{ justifyContent: "flex-end", width: "100%" }}>
          <Button variant="default" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} loading={busy} disabled={!certs.length} data-testid="ca-add-submit">
            {certs.length > 1 ? `Add ${certs.length} Certificates` : "Add Certificate"}
          </Button>
        </div>
      )}
    >
      <p className="sem-sheet-lead sem-dim" style={{ marginTop: 0 }}>
        Choose a PEM (.pem, .crt) or DER (.cer, .der) certificate, or paste PEM text. A PEM bundle adds every certificate in it. Only the
        certificate is needed, never the private key.
      </p>
      <div className="sem-row-inline" style={{ marginBottom: "var(--sem-space-5)" }}>
        <Button variant="default" leftSection={<IconUpload size={14} />} onClick={() => void chooseFile()} data-testid="ca-file">Choose File…</Button>
        {fileName && <span className="sem-dim">{fileName}</span>}
      </div>
      <Textarea
        placeholder="-----BEGIN CERTIFICATE-----" value={pem} onChange={(e) => onPaste(e.currentTarget.value)} aria-label="PEM text"
        autosize minRows={5} maxRows={10} data-testid="ca-pem" spellCheck={false}
        styles={{ input: { fontFamily: "var(--sem-font-mono)", fontSize: "var(--sem-fz-caption)" } }}
        error={pem.trim() && !certs.length ? "No certificate found in this text." : undefined}
      />
      {certs.map((c, i) => (
        <FormSection key={c.slice(0, 40) + i} title={certs.length > 1 ? `Certificate ${i + 1}` : "Certificate"} testId={`ca-preview-${i}`}>
          <div style={{ padding: "var(--sem-space-4) 0" }}><CertDetails b64={c} compact /></div>
        </FormSection>
      ))}
      {error != null && <div style={{ marginTop: "var(--sem-space-5)" }}><ErrorState error={error} inline /></div>}
    </Sheet>
  );
}

function TrustedCas({ serverId, hub, adding, setAdding }: { serverId: number; hub: string; adding: boolean; setAdding: (v: boolean) => void }) {
  const q = useRpc<{ CAList?: CaItem[] }>(serverId, "EnumCa", { HubName_str: hub });
  const [view, setView] = useState<CaItem | null>(null);
  const target = useRef("");
  const del = useRpcMutation<{ HubName_str: string; Key_u32: number }>(serverId, "DeleteCa", {
    success: "Trusted CA certificate deleted",
    confirm: () => ({
      title: <>Delete the trusted CA “{target.current}”?</>,
      message: "Users whose certificates this CA issued can no longer log in with signed-certificate authentication.",
      confirmLabel: "Delete Certificate", testId: "ca-delete",
    }),
    onSuccess: (_r, p) => { if (view?.Key_u32 === p.Key_u32) setView(null); },
  });
  const remove = (c: CaItem) => { target.current = c.SubjectName_utf; del.mutate({ HubName_str: hub, Key_u32: c.Key_u32 }); };
  const save = async (c: CaItem, kind: "pem" | "der") => {
    try {
      const r = await rpc<{ Cert_bin?: string }>(serverId, "GetCa", { HubName_str: hub, Key_u32: c.Key_u32 });
      if (r.Cert_bin) await (kind === "pem" ? savePem : saveDer)(safeName(c.SubjectName_utf), r.Cert_bin);
    } catch (e) { notifyError(e, "Couldn’t read the certificate"); }
  };
  return (
    <>
      <DataTable
        testId="ca-table" aria-label="Trusted CA certificates"
        data={q.data?.CAList} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}
        rowKey={(c) => c.Key_u32} selectable="single" initialSort={{ key: "SubjectName_utf", dir: "asc" }}
        rowTestId={(c) => `ca-row-${c.Key_u32}`}
        onRowOpen={setView}
        rowTone={(c) => (new Date(c.Expires_dt).getTime() < Date.now() ? "danger" : undefined)}
        empty={{
          title: "No Trusted CA Certificates",
          description: "Add the CA that issues your users’ client certificates.",
          icon: <IconCertificate size={28} stroke={1.4} />,
          action: <Button size="xs" variant="default" leftSection={<IconPlus size={13} />} onClick={() => setAdding(true)}>Add Certificate…</Button>,
        }}
        contextMenu={(c) => [
          { label: "Show Details", icon: <IconInfoCircle size={14} />, onClick: () => setView(c), testId: "ca-menu-details" },
          { label: "Save as PEM…", icon: <IconDeviceFloppy size={14} />, onClick: () => void save(c, "pem"), testId: "ca-menu-pem" },
          { label: "Save as DER…", icon: <IconDeviceFloppy size={14} />, onClick: () => void save(c, "der"), testId: "ca-menu-der" },
          { label: "Copy Subject", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(c.SubjectName_utf), testId: "ca-menu-copy" },
          "divider",
          { label: "Delete…", icon: <IconTrash size={14} />, danger: true, onClick: () => remove(c), testId: "ca-menu-delete" },
        ]}
        columns={[
          { key: "SubjectName_utf", title: "Subject", render: (c) => <span className="sem-strong">{c.SubjectName_utf}</span>, truncate: true },
          { key: "IssuerName_utf", title: "Issuer", render: (c) => c.SubjectName_utf === c.IssuerName_utf ? <span className="sem-dim">Self-signed</span> : c.IssuerName_utf, truncate: true },
          {
            key: "Expires_dt", title: "Expires", width: 190, value: (c) => new Date(c.Expires_dt).getTime(),
            render: (c) => <span className="sem-row-inline" style={{ flexWrap: "nowrap" }}><span className="sem-num" title={dt(c.Expires_dt)}>{dateShort(c.Expires_dt)}</span><ExpiryTag date={c.Expires_dt} /></span>,
          },
          { key: "Key_u32", title: "Key", width: 110, align: "right", render: (c) => <span className="sem-mono" data-dim>{c.Key_u32}</span> },
        ]}
      />
      <CaInspector serverId={serverId} hub={hub} item={view} onClose={() => setView(null)} onDelete={remove} />
      <AddCaSheet serverId={serverId} hub={hub} opened={adding} onClose={() => setAdding(false)} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Certificate revocation list

interface CrlItem { Key_u32: number; CrlInfo_utf: string }
interface Crl {
  HubName_str?: string; Key_u32?: number;
  CommonName_utf?: string; Organization_utf?: string; Unit_utf?: string; Country_utf?: string; State_utf?: string; Local_utf?: string;
  Serial_bin?: string; DigestMD5_bin?: string; DigestSHA1_bin?: string;
}
interface CrlForm { cn: string; o: string; ou: string; c: string; st: string; l: string; serial: string; md5: string; sha1: string }
const EMPTY_CRL: CrlForm = { cn: "", o: "", ou: "", c: "", st: "", l: "", serial: "", md5: "", sha1: "" };

const crlToForm = (r: Crl): CrlForm => ({
  cn: r.CommonName_utf ?? "", o: r.Organization_utf ?? "", ou: r.Unit_utf ?? "", c: r.Country_utf ?? "",
  st: r.State_utf ?? "", l: r.Local_utf ?? "", serial: b64ToHex(r.Serial_bin, " "), md5: b64ToHex(r.DigestMD5_bin, " "), sha1: b64ToHex(r.DigestSHA1_bin, " "),
});

/**
 * EnumCrl describes each entry as one string, e.g. `Subject="CN=bob, O=Acme", Serial="01 23", MD5="..", SHA1=".."`.
 * Split it into its parts (keys SoftEther omits are simply missing).
 */
function parseCrlInfo(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function CrlSheet({ serverId, hub, editKey, opened, onClose }: { serverId: number; hub: string; editKey: number | null; opened: boolean; onClose: () => void }) {
  const doc = useDocs("VpnRpcCrl");
  const existing = useRpc<Crl>(serverId, "GetCrl", { HubName_str: hub, Key_u32: editKey ?? 0 }, { enabled: opened && editKey !== null });
  const [f, setF] = useState<CrlForm>(EMPTY_CRL);
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    if (!opened) return;
    setSource(null);
    if (editKey === null) setF(EMPTY_CRL);
    else if (existing.data) setF(crlToForm(existing.data));
  }, [opened, editKey, existing.data]);
  const add = useRpcMutation(serverId, "AddCrl", { success: "Revoked certificate added", onSuccess: onClose });
  const set = useRpcMutation(serverId, "SetCrl", { success: "Revoked certificate updated", onSuccess: onClose });
  const busy = add.isPending || set.isPending;

  const fromCert = async () => {
    const file = await openBytes({ filters: CERT_FILTERS, title: "Choose the Certificate to Revoke" });
    if (!file) return;
    const [b64] = certsFromFile(file.bytes);
    if (!b64) { notifyError(new Error("The file has no X.509 certificate."), "Can’t use this file"); return; }
    const der = b64ToBytes(b64);
    try {
      const c = parseCert(der);
      const s1 = await sha("SHA-1", der);
      setF({
        cn: dnGet(c.subject, "CN"), o: dnGet(c.subject, "O"), ou: dnGet(c.subject, "OU"), c: dnGet(c.subject, "C"),
        st: dnGet(c.subject, "ST"), l: dnGet(c.subject, "L"), serial: toHex(c.serial, " "), md5: toHex(md5(der), " "), sha1: toHex(s1, " "),
      });
      setSource(file.name);
    } catch (e) { notifyError(e, "Couldn’t read the certificate"); }
  };

  const errors = {
    serial: f.serial && !isHex(f.serial) ? "Hexadecimal bytes, for example 01 A3 FF." : undefined,
    md5: f.md5 && !isHex(f.md5, 16) ? "16 bytes (32 hex digits)." : undefined,
    sha1: f.sha1 && !isHex(f.sha1, 20) ? "20 bytes (40 hex digits)." : undefined,
  };
  const empty = Object.values(f).every((v) => !v.trim());
  const invalid = Object.values(errors).some(Boolean) || empty;

  const submit = () => {
    if (invalid) return;
    const p: Crl = {
      HubName_str: hub,
      CommonName_utf: f.cn.trim(), Organization_utf: f.o.trim(), Unit_utf: f.ou.trim(), Country_utf: f.c.trim(),
      State_utf: f.st.trim(), Local_utf: f.l.trim(),
      Serial_bin: hexToB64(f.serial) ?? "", DigestMD5_bin: hexToB64(f.md5) ?? "", DigestSHA1_bin: hexToB64(f.sha1) ?? "",
    };
    if (editKey === null) add.mutate(p as Record<string, unknown>);
    else set.mutate({ ...p, Key_u32: editKey } as Record<string, unknown>);
  };

  const row = (k: keyof CrlForm, label: string, field: string, extra: { placeholder?: string; error?: string; mono?: boolean; w?: number; hint?: ReactNode } = {}) => (
    <FormRow label={label} description={extra.hint ?? (doc(field) || undefined)} error={extra.error} stacked={extra.mono}>
      {(id) => (
        <TextInput
          id={id} w={extra.w} value={f[k]} placeholder={extra.placeholder} error={!!extra.error} spellCheck={false} autoComplete="off"
          onChange={(e) => setF({ ...f, [k]: e.currentTarget.value })} data-testid={`crl-${k}`}
          styles={extra.mono ? { input: { fontFamily: "var(--sem-font-mono)", fontSize: "var(--sem-fz-small)" } } : undefined}
        />
      )}
    </FormRow>
  );

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={busy} size={640} testId="crl-sheet"
      title={editKey === null ? "Add Revoked Certificate" : "Edit Revoked Certificate"} subtitle={`Virtual Hub “${hub}”`}
      icon={<IconCertificateOff size={19} stroke={1.5} />}
      footer={(
        <div className="sem-row-inline" style={{ justifyContent: "space-between", width: "100%" }}>
          <Button variant="default" leftSection={<IconFileCertificate size={14} />} onClick={() => void fromCert()} data-testid="crl-from-cert" disabled={busy}>
            Fill from Certificate…
          </Button>
          <div className="sem-row-inline">
            <Button variant="default" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={invalid || (editKey !== null && existing.isLoading)} data-testid="crl-submit">
              {editKey === null ? "Add Entry" : "Save"}
            </Button>
          </div>
        </div>
      )}
    >
      {editKey !== null && existing.error ? <ErrorState error={existing.error} inline onRetry={() => void existing.refetch()} /> : (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <p className="sem-sheet-lead sem-dim" style={{ marginTop: 0 }}>
            A client certificate is refused when it matches <b>every</b> field you fill in. A digest alone is usually enough; otherwise combine subject
            fields with the serial number. Empty fields are ignored.
          </p>
          {source && <div className="sem-callouts" style={{ marginTop: 0, marginBottom: "var(--sem-space-4)" }}><Callout tone="green" testId="crl-source">Filled from {source}.</Callout></div>}
          <FormSection title="Digests" testId="crl-digests">
            {row("sha1", "SHA-1", "DigestSHA1_bin", { placeholder: "40 hex digits", error: errors.sha1, mono: true, hint: "160-bit digest of the certificate." })}
            {row("md5", "MD5", "DigestMD5_bin", { placeholder: "32 hex digits", error: errors.md5, mono: true, hint: "128-bit digest of the certificate." })}
            {row("serial", "Serial number", "Serial_bin", { placeholder: "01 23 45 67", error: errors.serial, mono: true, hint: "In hexadecimal." })}
          </FormSection>
          <FormSection title="Subject" testId="crl-subject">
            {row("cn", "Common name (CN)", "CommonName_utf", { hint: "" })}
            {row("o", "Organization (O)", "Organization_utf", { hint: "" })}
            {row("ou", "Organizational unit (OU)", "Unit_utf", { hint: "" })}
            {row("c", "Country (C)", "Country_utf", { placeholder: "GB", w: 90, hint: "" })}
            {row("st", "State or province (ST)", "State_utf", { hint: "" })}
            {row("l", "Locality (L)", "Local_utf", { hint: "" })}
          </FormSection>
          {editKey !== null && <div className="sem-form-section-footer">Saving an edited entry gives it a new key.</div>}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      )}
    </Sheet>
  );
}

function RevocationList({ serverId, hub, setSheet }: {
  serverId: number; hub: string; setSheet: (v: { key: number | null } | null) => void;
}) {
  const q = useRpc<{ CRLList?: CrlItem[] }>(serverId, "EnumCrl", { HubName_str: hub });
  const target = useRef("");
  const del = useRpcMutation<{ HubName_str: string; Key_u32: number }>(serverId, "DelCrl", {
    success: "Revoked certificate deleted",
    confirm: () => ({
      title: <>Delete the revoked certificate “{target.current}”?</>,
      message: "Certificates matching this entry are accepted again, if a trusted CA issued them.",
      confirmLabel: "Delete Entry", testId: "crl-delete",
    }),
  });
  const rows = useMemo(() => (q.data?.CRLList ?? []).map((r) => ({ ...r, parts: parseCrlInfo(r.CrlInfo_utf) })), [q.data]);
  type Row = (typeof rows)[number];
  const label = (r: Row) => r.parts.Subject || r.parts.SHA1 || r.parts.MD5 || r.parts.Serial || `#${r.Key_u32}`;
  return (
    <DataTable
      testId="crl-table" aria-label="Revoked certificates"
      data={q.data ? rows : undefined} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}
      rowKey={(r) => r.Key_u32} selectable="single"
      rowTestId={(r) => `crl-row-${r.Key_u32}`}
      onRowOpen={(r) => setSheet({ key: r.Key_u32 })}
      empty={{
        title: "No Revoked Certificates",
        description: "Revoke a client certificate to refuse it on this hub even though a trusted CA issued it.",
        icon: <IconCertificateOff size={28} stroke={1.4} />,
        action: <Button size="xs" variant="default" leftSection={<IconPlus size={13} />} onClick={() => setSheet({ key: null })}>Add Revoked Certificate…</Button>,
      }}
      contextMenu={(r) => [
        { label: "Edit…", icon: <IconPencil size={14} />, onClick: () => setSheet({ key: r.Key_u32 }), testId: "crl-menu-edit" },
        { label: "Copy Details", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(r.CrlInfo_utf) },
        "divider",
        { label: "Delete…", icon: <IconTrash size={14} />, danger: true, onClick: () => { target.current = label(r); del.mutate({ HubName_str: hub, Key_u32: r.Key_u32 }); }, testId: "crl-menu-delete" },
      ]}
      columns={[
        { key: "subject", title: "Subject", value: (r) => r.parts.Subject ?? "", truncate: true,
          render: (r) => r.parts.Subject ? <span className="sem-strong">{r.parts.Subject}</span> : <span className="sem-dim">Any subject</span> },
        { key: "serial", title: "Serial", width: 170, value: (r) => r.parts.Serial ?? "", truncate: true,
          render: (r) => r.parts.Serial ? <span className="sem-mono" title={r.parts.Serial}>{r.parts.Serial}</span> : <span className="sem-dim">–</span> },
        {
          key: "digest", title: "Digest", value: (r) => `${r.parts.SHA1 ?? ""} ${r.parts.MD5 ?? ""}`, truncate: true, width: "34%",
          render: (r) => {
            const [k, v] = r.parts.SHA1 ? ["SHA-1", r.parts.SHA1] : r.parts.MD5 ? ["MD5", r.parts.MD5] : [null, null];
            if (!k) return <span className="sem-dim">–</span>;
            return (
              <span className="sem-row-inline" style={{ flexWrap: "nowrap", maxWidth: "100%" }} title={[r.parts.SHA1 && `SHA-1 ${r.parts.SHA1}`, r.parts.MD5 && `MD5 ${r.parts.MD5}`].filter(Boolean).join("\n")}>
                <Tag>{k}</Tag><span className="sem-mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{v}</span>
                {r.parts.SHA1 && r.parts.MD5 && <span className="sem-dim">+ MD5</span>}
              </span>
            );
          },
        },
        { key: "Key_u32", title: "Key", width: 110, align: "right", render: (r) => <span className="sem-mono" data-dim>{r.Key_u32}</span> },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------------------------

type Tab = "ca" | "crl";

export default function HubCertsPage() {
  const { serverId, hub, ready, server } = useHubPage();
  const [tab, setTab] = useState<Tab>("ca");
  const [addingCa, setAddingCa] = useState(false);
  const [crlSheet, setCrlSheet] = useState<{ key: number | null } | null>(null);
  if (!server.data) return null;
  return (
    <>
      <PageHeader
        title="Trusted CAs & CRL"
        description="Certificates this hub trusts for users with signed-certificate authentication, and the certificates it refuses. Changes apply to new connections."
        actions={ready && (tab === "ca"
          ? <Button leftSection={<IconPlus size={14} />} onClick={() => setAddingCa(true)} data-testid="add-ca">Add Certificate…</Button>
          : <Button leftSection={<IconPlus size={14} />} onClick={() => setCrlSheet({ key: null })} data-testid="add-crl">Add Revoked Certificate…</Button>)}
      />
      {!ready ? <HubUnreachable serverId={serverId} /> : (
        <>
          <SegmentedControl
            size="sm" value={tab} onChange={(v) => setTab(v as Tab)} mb="var(--sem-space-3)"
            data={[
              { value: "ca", label: <span className="sem-row-inline" style={{ gap: 6, flexWrap: "nowrap" }} data-testid="tab-ca"><IconCertificate size={14} />Trusted CAs</span> },
              { value: "crl", label: <span className="sem-row-inline" style={{ gap: 6, flexWrap: "nowrap" }} data-testid="tab-crl"><IconCertificateOff size={14} />Revoked Certificates</span> },
            ]}
          />
          <p className="sem-dim" style={{ margin: "0 0 var(--sem-space-5)", fontSize: "var(--sem-fz-small)" }} data-testid="certs-tab-description">
            {tab === "ca"
              ? "Users with signed-certificate authentication are accepted when a CA listed here issued their certificate and it matches the user’s name or serial constraints. Cascade connections can also use these CAs to verify their server."
              : "Client certificates that match an entry are refused on this hub, even when a trusted CA issued them."}
          </p>
          {tab === "ca" ? (
            <TrustedCas serverId={serverId} hub={hub} adding={addingCa} setAdding={setAddingCa} />
          ) : (
            <RevocationList serverId={serverId} hub={hub} setSheet={setCrlSheet} />
          )}
          <CrlSheet serverId={serverId} hub={hub} editKey={crlSheet?.key ?? null} opened={!!crlSheet} onClose={() => setCrlSheet(null)} />
        </>
      )}
    </>
  );
}
