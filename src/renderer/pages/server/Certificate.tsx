// Server › Certificate & TLS: the server certificate (GetServerCert), exporting it, installing your own
// (SetServerCert) or a new self-signed one (RegenerateServerCert), re-trusting it in this app (RepinPanel), and
// the TLS cipher (Get/SetServerCipher, GetServerCipherList).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Group, Menu, SegmentedControl, Select, Textarea, TextInput } from "@mantine/core";
import {
  IconCertificate, IconChevronDown, IconDownload, IconFileCertificate, IconKey, IconRefresh, IconShieldCheck, IconUpload,
} from "@tabler/icons-react";
import { dt, downloadB64, downloadText, normFp } from "../../lib/format";
import { notifyError, notifySuccess, useRpc, useRpcMutation } from "../../lib/hooks";
import {
  confirmAction, ErrorState, FingerprintField, FormRow, FormSection, Mono, PageHeader, PropertyList, PropertySkeleton, Section, Sheet, StatusBadge, Tag,
  type PropertyItem,
} from "../../design";
import { openBytes, CERT_FILTERS, KEY_FILTERS } from "../../components/domain/files";
import { RepinPanel } from "../../components/domain/Repin";
import { Callout, Disclosure, HelpLabel } from "../../components/domain/ui";
import {
  b64ToBytes, bytesToB64, fingerprint256, inspectPrivateKey, parseCertificate, readDerOrPem, toPem, type CertInfo, type KeyInfo,
} from "../../components/domain/x509";
import { CodeBlock, HubModeNotice, Unreachable, safeName, useServerPage } from "./_server-protocols-security/shared";

interface KeyPair { Cert_bin?: string; Key_bin?: string }

const DAY = 86_400_000;
const daysLeft = (d: Date) => Math.floor((d.getTime() - Date.now()) / DAY);

function Expiry({ notAfter }: { notAfter: Date }) {
  const days = daysLeft(notAfter);
  if (days < 0) return <StatusBadge status="error">Expired {-days} {-days === 1 ? "day" : "days"} ago</StatusBadge>;
  if (days < 30) return <StatusBadge status="warning">Expires in {days} {days === 1 ? "day" : "days"}</StatusBadge>;
  return <StatusBadge status="ok">Valid for {days.toLocaleString()} more days</StatusBadge>;
}

function certItems(info: CertInfo, fp: string, pinned?: string | null): PropertyItem[] {
  return [
    { label: "Common name", value: <span className="sem-strong" data-testid="cert-cn">{info.commonName || "–"}</span> },
    { label: "Subject", value: <span className="sem-break">{info.subject}</span> },
    { label: "Issuer", value: <span className="sem-cell-title"><span className="sem-break">{info.issuer}</span>{info.selfSigned && <Tag>Self-signed</Tag>}</span> },
    { label: "Alternative names", value: info.subjectAltNames.length ? info.subjectAltNames.join(", ") : <span className="sem-dim">None. Clients match the common name.</span> },
    { label: "Valid from", value: dt(info.notBefore.toISOString()) },
    { label: "Valid until", value: <span className="sem-cell-title">{dt(info.notAfter.toISOString())}<Expiry notAfter={info.notAfter} /></span> },
    { label: "Public key", value: `${info.keyAlgorithm}${info.keySize ? ` ${info.keySize} bit` : ""}${info.curve ? ` (${info.curve})` : ""}` },
    { label: "Signature", value: <span className="sem-cell-title">{info.signatureAlgorithm}{/sha1|md5/i.test(info.signatureAlgorithm) && <Tag color="orange">Weak</Tag>}</span> },
    { label: "Serial number", value: <Mono>{info.serial}</Mono> },
    { label: "Version", value: `X.509 v${info.version}` },
    {
      label: "SHA-256 fingerprint",
      value: (
        <div className="sem-stack" style={{ gap: "var(--sem-space-3)" }} data-testid="cert-fp">
          <FingerprintField value={fp} compare={pinned === undefined ? undefined : pinned} />
          {pinned !== undefined && pinned && (normFp(pinned) === normFp(fp)
            ? <StatusBadge status="ok" testId="cert-fp-match">Trusted by this app</StatusBadge>
            : <StatusBadge status="warning" testId="cert-fp-match">Differs from the fingerprint this app trusts</StatusBadge>)}
        </div>
      ),
    },
  ];
}

type Parsed = { info?: CertInfo; fp?: string; error?: string; key?: KeyInfo };

function useParsedCert(data: KeyPair | undefined): Parsed {
  const [p, setP] = useState<Parsed>({});
  useEffect(() => {
    let live = true;
    if (!data?.Cert_bin) { setP({}); return; }
    const der = b64ToBytes(data.Cert_bin);
    let key: KeyInfo | undefined;
    try { key = data.Key_bin ? inspectPrivateKey(b64ToBytes(data.Key_bin)) : undefined; } catch { key = undefined; }
    let info: CertInfo | undefined;
    let error: string | undefined;
    try { info = parseCertificate(der); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    void fingerprint256(der).then((fp) => { if (live) setP({ info, fp, error, key }); });
    return () => { live = false; };
  }, [data]);
  return p;
}

// ------------------------------------------------------------------------------------------ install / generate

/** Second step of both sheets: the server now presents a new certificate, so this app must trust it. */
function TrustStep({ serverId, expectedFp, what }: { serverId: number; expectedFp?: string | null; what: string }) {
  return (
    <div className="sem-stack" style={{ gap: "var(--sem-space-6)" }} data-testid="cert-after-change">
      <Callout tone="green" icon={<IconShieldCheck size={16} stroke={1.7} />} title={what}>
        The server now presents a new certificate. This app refuses to connect to it until you trust the new fingerprint below.
      </Callout>
      <RepinPanel serverId={serverId} expectedFp={expectedFp} autoProbe />
    </div>
  );
}

interface Candidate { certB64: string; keyB64: string; info: CertInfo; fp: string; key: KeyInfo; notes: string[] }

function ImportSheet({ serverId, serverName, opened, onClose }: { serverId: number; serverName: string; opened: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [certFile, setCertFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [keyFile, setKeyFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [certText, setCertText] = useState("");
  const [keyText, setKeyText] = useState("");
  const [cand, setCand] = useState<Candidate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { if (opened) { setCertFile(null); setKeyFile(null); setCertText(""); setKeyText(""); setDone(null); setMode("file"); } }, [opened]);
  const set = useRpcMutation<{ Cert_bin: string; Key_bin: string }>(serverId, "SetServerCert", {
    success: "Server certificate replaced",
    onSuccess: () => setDone(cand?.fp ?? ""),
    confirm: () => ({
      title: "Replace the server certificate?",
      message: <>The current certificate and private key are <b>deleted permanently</b>. Export them first if you may need them again.</>,
      details: (
        <ul style={{ margin: 0, paddingLeft: "var(--sem-space-7)" }}>
          <li>Clients that verify the server certificate must trust <b>{cand?.info.commonName || "the new certificate"}</b>.</li>
          <li>This app must trust the new fingerprint. You’re guided through it next.</li>
          <li>OpenVPN configuration files that embed the old certificate must be saved again.</li>
        </ul>
      ),
      confirmLabel: "Replace Certificate",
      typeToConfirm: serverName,
      typeLabel: <>To confirm, type the connection name <span className="sem-code-inline">{serverName}</span></>,
      testId: "set-server-cert",
    }),
  });

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setCand(null);
    void (async () => {
      try {
        const enc = new TextEncoder();
        const c = mode === "file" ? (certFile ? readDerOrPem(certFile.bytes, "cert") : null) : certText.trim() ? readDerOrPem(enc.encode(certText), "cert") : null;
        const k = mode === "file" ? (keyFile ? readDerOrPem(keyFile.bytes, "key") : null) : keyText.trim() ? readDerOrPem(enc.encode(keyText), "key") : null;
        if (!c || !k) return;
        const info = parseCertificate(c.der);
        const key = inspectPrivateKey(k.der);
        const fp = await fingerprint256(c.der);
        const notes: string[] = [];
        if (c.note) notes.push(c.note);
        if (info.rsaModulus && key.rsaModulus && info.rsaModulus !== key.rsaModulus) throw new Error("The private key doesn’t belong to this certificate (the RSA modulus differs).");
        if (!(info.rsaModulus && key.rsaModulus)) notes.push("The key couldn’t be matched to the certificate here. The server checks it and refuses a pair that doesn’t match.");
        if (info.notAfter.getTime() < Date.now()) notes.push("This certificate has already expired.");
        if (info.notBefore.getTime() > Date.now()) notes.push("This certificate isn’t valid yet.");
        if (!cancelled) setCand({ certB64: bytesToB64(c.der), keyB64: bytesToB64(k.der), info, key, fp, notes });
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [mode, certFile, keyFile, certText, keyText]);

  const pick = async (kind: "cert" | "key") => {
    try {
      const f = await openBytes({ filters: kind === "cert" ? CERT_FILTERS : KEY_FILTERS, title: kind === "cert" ? "Choose the Certificate" : "Choose the Private Key" });
      if (f) (kind === "cert" ? setCertFile : setKeyFile)(f);
    } catch (e) { notifyError(e, "Couldn’t read the file"); }
  };
  const fileRow = (kind: "cert" | "key", file: { name: string } | null, label: string, desc: string) => (
    <FormRow label={label} description={desc}>
      <Group gap={10} wrap="nowrap">
        <Button variant="default" leftSection={kind === "cert" ? <IconCertificate size={14} /> : <IconKey size={14} />} onClick={() => void pick(kind)} data-testid={kind === "cert" ? "cert-file" : "key-file"}>
          Choose…
        </Button>
        <span className={file ? "sem-mono" : "sem-dim"} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}
          data-testid={kind === "cert" ? "cert-file-name" : "key-file-name"}>{file ? file.name : "No file chosen"}</span>
      </Group>
    </FormRow>
  );

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={set.isPending} size={640} testId="cert-import-sheet"
      title={done !== null ? "Trust the New Certificate" : "Install Certificate"}
      subtitle={done !== null ? undefined : "Use a certificate and private key issued by your CA. PEM or DER; the key must not be encrypted."}
      icon={<IconFileCertificate size={19} stroke={1.5} />}
      footer={done !== null ? (
        <Group justify="flex-end"><Button onClick={onClose} data-testid="cert-import-done">Done</Button></Group>
      ) : (
        <Group justify="flex-end" gap={8}>
          <Button variant="default" onClick={onClose} disabled={set.isPending}>Cancel</Button>
          <Button color="red" leftSection={<IconUpload size={14} />} disabled={!cand} loading={set.isPending} data-testid="set-server-cert"
            onClick={() => cand && set.mutate({ Cert_bin: cand.certB64, Key_bin: cand.keyB64 })}>Install Certificate…</Button>
        </Group>
      )}
    >
      {done !== null ? <TrustStep serverId={serverId} expectedFp={done || null} what="Certificate installed" /> : (
        <div className="sem-stack" style={{ gap: "var(--sem-space-6)" }}>
          <SegmentedControl value={mode} onChange={(v) => setMode(v as "file" | "paste")} style={{ alignSelf: "flex-start" }} data-testid="cert-mode"
            data={[{ value: "file", label: "From Files" }, { value: "paste", label: "Paste PEM" }]} />
          {mode === "file" ? (
            <FormSection>
              {fileRow("cert", certFile, "Certificate", ".pem, .crt, .cer or .der")}
              {fileRow("key", keyFile, "Private key", "Unencrypted RSA or EC key")}
            </FormSection>
          ) : (
            <FormSection>
              <FormRow stacked label="Certificate (PEM)">
                {(id) => <Textarea id={id} autosize minRows={4} maxRows={8} value={certText} onChange={(e) => setCertText(e.currentTarget.value)} spellCheck={false}
                  styles={{ input: { fontFamily: "var(--sem-font-mono)", fontSize: "var(--sem-fz-small)" } }} placeholder="-----BEGIN CERTIFICATE-----" data-testid="cert-text" />}
              </FormRow>
              <FormRow stacked label="Private key (PEM)">
                {(id) => <Textarea id={id} autosize minRows={4} maxRows={8} value={keyText} onChange={(e) => setKeyText(e.currentTarget.value)} spellCheck={false}
                  styles={{ input: { fontFamily: "var(--sem-font-mono)", fontSize: "var(--sem-fz-small)" } }} placeholder="-----BEGIN PRIVATE KEY-----" data-testid="key-text" />}
              </FormRow>
            </FormSection>
          )}
          {err && <Callout tone="red" title="This certificate can’t be installed" testId="cert-import-error">{err}</Callout>}
          {cand && (
            <Section title="New certificate" variant="inset" testId="cert-preview">
              <PropertyList labelWidth={150} dense items={[
                ...certItems(cand.info, cand.fp),
                { label: "Private key", value: cand.key.kind },
              ]} />
            </Section>
          )}
          {cand && cand.notes.length > 0 && (
            <Callout tone="yellow" testId="cert-import-notes"><ul style={{ margin: 0, paddingLeft: "var(--sem-space-7)" }}>{cand.notes.map((n) => <li key={n}>{n}</li>)}</ul></Callout>
          )}
        </div>
      )}
    </Sheet>
  );
}

const CN_RE = /^[A-Za-z0-9.*_-][A-Za-z0-9. _*-]{0,63}$/;

function GenerateSheet({ serverId, serverName, currentCn, host, opened, onClose }: {
  serverId: number; serverName: string; currentCn: string; host: string; opened: boolean; onClose: () => void;
}) {
  const [cn, setCn] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => { if (opened) { setCn(currentCn || host); setDone(false); } }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = CN_RE.test(cn.trim());
  const regen = useRpcMutation<{ StrValue_str: string }>(serverId, "RegenerateServerCert", {
    success: "New self-signed certificate created",
    onSuccess: () => setDone(true),
    confirm: (p) => ({
      title: "Replace the certificate with a new self-signed one?",
      message: <>A new self-signed certificate for <b>{p.StrValue_str}</b> is created. The current certificate and private key are <b>deleted permanently</b>, and every client that trusts the old certificate must be updated.</>,
      confirmLabel: "Create Certificate",
      typeToConfirm: serverName,
      typeLabel: <>To confirm, type the connection name <span className="sem-code-inline">{serverName}</span></>,
      testId: "regen-cert",
    }),
  });
  const submit = () => { if (valid) regen.mutate({ StrValue_str: cn.trim() }); };
  return (
    <Sheet
      opened={opened} onClose={onClose} busy={regen.isPending} size={done ? 640 : 520} testId="cert-regen-sheet"
      title={done ? "Trust the New Certificate" : "New Self-Signed Certificate"}
      subtitle={done ? undefined : "SSTP clients need the common name to equal the host name they dial."}
      icon={<IconRefresh size={19} stroke={1.5} />}
      footer={done ? (
        <Group justify="flex-end"><Button onClick={onClose} data-testid="cert-regen-done">Done</Button></Group>
      ) : (
        <Group justify="flex-end" gap={8}>
          <Button variant="default" onClick={onClose} disabled={regen.isPending}>Cancel</Button>
          <Button color="red" disabled={!valid} loading={regen.isPending} onClick={submit} data-testid="regen-cert">Create Certificate…</Button>
        </Group>
      )}
    >
      {done ? <TrustStep serverId={serverId} what="Self-signed certificate created" /> : (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <FormSection>
            <FormRow label="Common name" description="For example vpn.example.com." error={cn && !valid ? "Use a host name: letters, digits, “.”, “-” and “*”." : undefined}>
              {(id) => <TextInput id={id} w={260} value={cn} onChange={(e) => setCn(e.currentTarget.value)} data-autofocus spellCheck={false} error={!!cn && !valid} data-testid="regen-cn" />}
            </FormRow>
          </FormSection>
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------ cipher

const WEAK = /RC4|DES|MD5|NULL|EXPORT|-SHA$|^AES\d+-SHA/i;

function CipherSection({ serverId, enabled }: { serverId: number; enabled: boolean }) {
  const cur = useRpc<{ String_str?: string }>(serverId, "GetServerCipher", {}, { enabled });
  const list = useRpc<{ String_str?: string }>(serverId, "GetServerCipherList", {}, { enabled, retry: false });
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => { if (cur.data) setValue(cur.data.String_str ?? ""); }, [cur.data]);
  const current = cur.data?.String_str ?? "";
  const data = useMemo(() => {
    const names = (list.data?.String_str ?? "").split(";").map((s) => s.trim()).filter(Boolean);
    const tls13 = names.filter((n) => n.startsWith("TLS_"));
    const other = names.filter((n) => !n.startsWith("TLS_"));
    const groups = [
      { group: "Recommended", items: [{ value: "~DEFAULT~", label: "Automatic (negotiated by the TLS library)" }] },
      ...(tls13.length ? [{ group: "TLS 1.3", items: tls13 }] : []),
      ...(other.length ? [{ group: "TLS 1.2 and older", items: other }] : []),
    ];
    if (current && current !== "~DEFAULT~" && !names.includes(current)) groups.push({ group: "Current", items: [current] });
    return groups;
  }, [list.data, current]);
  const save = useRpcMutation<{ String_str: string }>(serverId, "SetServerCipher", {
    success: "TLS cipher changed",
    confirm: (p) => ({
      title: "Change the TLS cipher?",
      message: "Clients and managers, including this app, that don’t support it can no longer connect. Existing sessions stay connected.",
      details: (
        <div className="sem-stack" style={{ gap: "var(--sem-space-2)" }}>
          <div>New setting: <span className="sem-code-inline">{p.String_str === "~DEFAULT~" ? "Automatic" : p.String_str}</span></div>
          {WEAK.test(p.String_str) && <div className="sem-text-red">This cipher is considered weak.</div>}
        </div>
      ),
      confirmLabel: "Change Cipher",
      tone: "warning",
      testId: "save-cipher",
    }),
  });
  const dirty = value !== null && !!cur.data && value !== current;
  const weak = !!value && WEAK.test(value);

  return (
    <FormSection title="TLS cipher" description="Used for the TLS connection between the server and VPN clients, bridges and managers. Choosing one suite limits which clients can connect." testId="cipher-section">
      {cur.error ? <div style={{ padding: "var(--sem-space-5)" }}><ErrorState error={cur.error} inline onRetry={() => void cur.refetch()} /></div> : !cur.data ? <PropertySkeleton rows={1} /> : (
        <FormRow label="Cipher suite"
          description={list.error ? "The server didn’t list its ciphers, so only the current one is shown." : weak ? <span style={{ color: "var(--sem-orange)" }}>Weak: no forward secrecy or legacy algorithms.</span> : `Current: ${current === "~DEFAULT~" ? "Automatic" : current}`}>
          {(id) => (
            <Group gap={8} wrap="nowrap">
              <Select id={id} data={data} value={value} onChange={setValue} searchable allowDeselect={false} w={330} maxDropdownHeight={320}
                renderOption={({ option }) => <span className={option.value === "~DEFAULT~" ? undefined : "sem-mono"}>{option.label}</span>}
                data-testid="cipher-select" comboboxProps={{ withinPortal: true }} />
              <Button variant="default" disabled={!dirty} loading={save.isPending} onClick={() => value && save.mutate({ String_str: value })} data-testid="save-cipher-apply">Apply…</Button>
            </Group>
          )}
        </FormRow>
      )}
    </FormSection>
  );
}

// ------------------------------------------------------------------------------------------ page

export default function CertificatePage() {
  const { serverId, s, reachable, hubMode, ready } = useServerPage();
  const enabled = ready && !hubMode;
  const cert = useRpc<KeyPair>(serverId, "GetServerCert", {}, { enabled });
  const parsed = useParsedCert(cert.data);
  const [sheet, setSheet] = useState<"import" | "generate" | null>(null);
  if (!s) return null;

  const pinned = s.tlsMode === "pin" ? s.fingerprint : undefined;
  const pem = cert.data?.Cert_bin ? toPem("CERTIFICATE", cert.data.Cert_bin) : "";
  const base = `${safeName(s.name)}-${safeName(parsed.info?.commonName || "server")}`;
  const save = async (p: Promise<{ saved: boolean }>, what: string) => {
    try { if ((await p).saved) notifySuccess(`${what} saved`); } catch (e) { notifyError(e, `Couldn’t save the ${what.toLowerCase()}`); }
  };
  const exportKey = async () => {
    const ok = await confirmAction({
      title: "Export the server’s private key?",
      message: "Anyone with this key can impersonate the VPN Server. Keep the file encrypted and delete it when you no longer need it.",
      confirmLabel: "Export Key",
      tone: "warning",
      testId: "export-key",
    });
    if (ok && cert.data?.Key_bin) await save(downloadText(`${base}.key`, toPem(parsed.key?.pemLabel ?? "PRIVATE KEY", cert.data.Key_bin), "application/x-pem-file"), "Private key");
  };

  const trust = (
    <Section title="Trust in this app" description="How this app checks the server’s certificate. After the certificate changes, trust the new fingerprint here." testId="cert-trust">
      <RepinPanel serverId={serverId} />
    </Section>
  );

  const meta: ReactNode = parsed.info ? (
    <>
      <span>{parsed.info.commonName || "No common name"}</span>
      <span className="sem-dim">·</span>
      <Expiry notAfter={parsed.info.notAfter} />
      {parsed.info.selfSigned && <><span className="sem-dim">·</span><span>Self-signed</span></>}
    </>
  ) : undefined;

  return (
    <>
      <PageHeader
        title="Certificate & TLS"
        meta={enabled ? meta : undefined}
        description="The certificate the server presents to VPN clients and managers, how this app trusts it, and the TLS cipher."
        actions={enabled && (
          <>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <Button variant="default" leftSection={<IconDownload size={14} />} rightSection={<IconChevronDown size={12} />} disabled={!cert.data?.Cert_bin} data-testid="cert-export">Export</Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => void save(downloadB64(`${base}.cer`, cert.data!.Cert_bin!, "application/pkix-cert"), "Certificate")} data-testid="download-cer">Certificate (DER)…</Menu.Item>
                <Menu.Item onClick={() => void save(downloadText(`${base}.pem`, pem, "application/x-pem-file"), "Certificate")} data-testid="download-pem">Certificate (PEM)…</Menu.Item>
                {cert.data?.Key_bin && <><Menu.Divider /><Menu.Item leftSection={<IconKey size={14} />} onClick={() => void exportKey()} data-testid="export-key">Private Key…</Menu.Item></>}
              </Menu.Dropdown>
            </Menu>
            <Button variant="default" leftSection={<IconRefresh size={14} />} onClick={() => setSheet("generate")} data-testid="open-regen">New Self-Signed…</Button>
            <Button leftSection={<IconUpload size={14} />} onClick={() => setSheet("import")} data-testid="open-import">Install Certificate…</Button>
          </>
        )}
      />
      {!reachable && <Unreachable serverId={serverId} name={s.name} error={s.state?.error} checkedAt={s.state?.checkedAt} />}
      {reachable && hubMode && <HubModeNotice hub={s.hub!} what="the server certificate isn’t available." />}
      {/* Trust needs no RPC (it probes the TLS handshake), so it stays available when the server is unreachable, e.g.
          after the certificate was replaced elsewhere and this app now refuses the new one, and in hub admin mode. */}
      {!enabled && trust}
      {enabled && (
        <>
          <Section title="Server certificate" variant="inset" testId="cert-current">
            {cert.error ? <ErrorState error={cert.error} inline onRetry={() => void cert.refetch()} /> : !parsed.fp ? <PropertySkeleton rows={8} /> : (
              <div className="sem-stack" style={{ gap: "var(--sem-space-5)" }}>
                {parsed.error && <Callout tone="yellow">The certificate couldn’t be read ({parsed.error}). The fingerprint and PEM are still shown.</Callout>}
                <PropertyList labelWidth={170} items={[
                  ...(parsed.info ? certItems(parsed.info, parsed.fp, pinned) : [{ label: "SHA-256 fingerprint", value: <FingerprintField value={parsed.fp} /> }]),
                  ...(cert.data?.Key_bin ? [{
                    label: <HelpLabel label="Private key" doc="Stored on the server. Export it before replacing the certificate if you may need it again: the old key can’t be recovered." />,
                    value: <span className="sem-cell-title"><Tag variant="outline">{parsed.key?.kind ?? "DER"}</Tag><span className="sem-dim">Stored on the server</span></span>,
                  }] : []),
                ]} />
                <Disclosure label="PEM" testId="toggle-pem">
                  <div style={{ paddingTop: "var(--sem-space-4)" }}><CodeBlock code={pem} testId="cert-pem" label="Copy PEM" /></div>
                </Disclosure>
              </div>
            )}
          </Section>

          {trust}

          <CipherSection serverId={serverId} enabled={enabled} />

          <ImportSheet serverId={serverId} serverName={s.name} opened={sheet === "import"} onClose={() => setSheet(null)} />
          <GenerateSheet serverId={serverId} serverName={s.name} currentCn={parsed.info?.commonName ?? ""} host={s.host} opened={sheet === "generate"} onClose={() => setSheet(null)} />
        </>
      )}
    </>
  );
}
