import { useEffect, useMemo, useState } from "react";
import {
  Alert, Badge, Button, Code, Collapse, FileInput, Group, List, SegmentedControl, Select, SimpleGrid, Stack, Text, TextInput, Textarea,
} from "@mantine/core";
import { IconAlertTriangle, IconCertificate, IconDownload, IconKey, IconRefresh, IconUpload } from "@tabler/icons-react";
import dayjs from "dayjs";
import { ConfirmButton, Copyable, KeyValue, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { RepinPanel } from "../../components/server-b/Repin";
import { HelpLabel, useServerAccess } from "../../components/server-b/ui";
import {
  b64ToBytes, bytesToB64, fingerprint256, inspectPrivateKey, normalizeFp, parseCertificate, readDerOrPem, toPem, type CertInfo, type KeyInfo,
} from "../../components/server-b/x509";
import { useRpc, useRpcMutation, useScope } from "../../lib/hooks";
import { downloadB64, downloadText } from "../../lib/format";

interface KeyPair { Cert_bin?: string; Key_bin?: string }

function safeName(s: string) { return s.replace(/[^\w.-]/g, "_"); }

function ExpiryBadge({ notAfter }: { notAfter: Date }) {
  const days = dayjs(notAfter).diff(dayjs(), "day");
  if (days < 0) return <Badge color="red">Expired {-days} day(s) ago</Badge>;
  if (days < 30) return <Badge color="orange">Expires in {days} day(s)</Badge>;
  return <Badge color="green" variant="light">Valid for {days} more day(s)</Badge>;
}

function CertDetails({ info, fp, pinned }: { info: CertInfo; fp: string; pinned?: string | null }) {
  return (
    <KeyValue rows={[
      ["Common name (CN)", <Text fw={600} size="sm">{info.commonName || "–"}</Text>],
      ["Subject", info.subject],
      ["Issuer", <Group gap={6}><span>{info.issuer}</span>{info.selfSigned && <Badge size="xs" variant="outline" color="gray">self-signed</Badge>}</Group>],
      ["Subject alternative names", info.subjectAltNames.length ? info.subjectAltNames.join(", ") : <Text size="sm" c="dimmed">None (clients match against the CN)</Text>],
      ["Valid from", dayjs(info.notBefore).format("YYYY-MM-DD HH:mm:ss")],
      ["Valid until", <Group gap={6}><span>{dayjs(info.notAfter).format("YYYY-MM-DD HH:mm:ss")}</span><ExpiryBadge notAfter={info.notAfter} /></Group>],
      ["Public key", `${info.keyAlgorithm}${info.keySize ? ` ${info.keySize} bit` : ""}${info.curve ? ` (${info.curve})` : ""}`],
      ["Signature algorithm", <Group gap={6}><span>{info.signatureAlgorithm}</span>{/sha1|md5/i.test(info.signatureAlgorithm) && <Badge size="xs" color="orange">weak</Badge>}</Group>],
      ["Serial number", <Code>{info.serial}</Code>],
      ["X.509 version", `v${info.version}`],
      ["SHA-256 fingerprint", <Stack gap={4}>
        <span data-testid="cert-fp"><Copyable value={fp} /></span>
        {pinned !== undefined && (pinned
          ? normalizeFp(pinned) === normalizeFp(fp)
            ? <Badge color="green" variant="light" w="fit-content">Matches the fingerprint pinned in the manager</Badge>
            : <Badge color="red" variant="light" w="fit-content">Differs from the fingerprint pinned in the manager</Badge>
          : null)}
      </Stack>],
    ]} />
  );
}

function CurrentCert({ serverId, serverName, pinned, isAdmin }: { serverId: number; serverName: string; pinned: string | null | undefined; isAdmin: boolean }) {
  const q = useRpc<KeyPair>(serverId, "GetServerCert");
  const [info, setInfo] = useState<{ info?: CertInfo; fp?: string; error?: string; key?: KeyInfo }>({});
  const [showPem, setShowPem] = useState(false);
  useEffect(() => {
    if (!q.data?.Cert_bin) return;
    const der = b64ToBytes(q.data.Cert_bin);
    let key: KeyInfo | undefined;
    try { key = q.data.Key_bin ? inspectPrivateKey(b64ToBytes(q.data.Key_bin)) : undefined; } catch { key = undefined; }
    try {
      const parsed = parseCertificate(der);
      void fingerprint256(der).then((fp) => setInfo({ info: parsed, fp, key }));
    } catch (e) {
      void fingerprint256(der).then((fp) => setInfo({ fp, error: e instanceof Error ? e.message : String(e), key }));
    }
  }, [q.data]);
  const pem = q.data?.Cert_bin ? toPem("CERTIFICATE", q.data.Cert_bin) : "";
  const base = `${safeName(serverName)}-${safeName(info.info?.commonName || "server")}`;

  return (
    <Section
      title="Current server certificate"
      description="The SSL/TLS certificate the VPN Server presents to VPN clients, SSTP / OpenVPN clients and administration tools (including this manager)."
      actions={q.data?.Cert_bin && (
        <>
          <Button size="xs" variant="light" leftSection={<IconDownload size={14} />} onClick={() => downloadB64(`${base}.cer`, q.data!.Cert_bin!, "application/pkix-cert")} data-testid="download-cer">.cer (DER)</Button>
          <Button size="xs" variant="light" leftSection={<IconDownload size={14} />} onClick={() => downloadText(`${base}.pem`, pem, "application/x-pem-file")} data-testid="download-pem">.pem</Button>
        </>
      )}
    >
      <QueryState query={q}>
        {info.error && <Alert color="orange" variant="light" mb="sm">Could not parse the certificate ({info.error}); the fingerprint and PEM are still shown.</Alert>}
        {info.info && info.fp ? <CertDetails info={info.info} fp={info.fp} pinned={pinned} /> : info.fp ? <KeyValue rows={[["SHA-256 fingerprint", <Copyable value={info.fp} />]]} /> : null}
        <Group mt="sm" gap="xs">
          <Button size="xs" variant="subtle" onClick={() => setShowPem((v) => !v)} data-testid="toggle-pem">{showPem ? "Hide" : "Show"} PEM</Button>
        </Group>
        <Collapse expanded={showPem}>
          <Group align="flex-start" gap="xs" mt="xs">
            <Code block style={{ flex: 1, fontSize: 11 }} data-testid="cert-pem">{pem}</Code>
            <Copyable value={pem} mono={false} />
          </Group>
        </Collapse>
        {q.data?.Key_bin && (
          <KeyValue rows={[
            [<HelpLabel label="Private key" doc="The private key matching the certificate. Only administrators can export it — keep a copy before replacing the certificate, as the old key cannot be recovered afterwards." />,
              <Group gap="xs">
                <Badge variant="outline" color="gray">{info.key?.kind ?? "DER"}</Badge>
                <Text size="sm" c="dimmed">stored on the server (not displayed)</Text>
                {isAdmin && (
                  <ConfirmButton
                    title="Export the server private key?"
                    color="orange" size="xs" confirmLabel="Download key"
                    leftSection={<IconKey size={14} />}
                    message="Anyone holding this key can impersonate the VPN Server. Store the file encrypted and delete it after use. The export is recorded in the audit log (GetServerCert)."
                    onConfirm={() => downloadText(`${base}.key`, toPem(info.key?.pemLabel ?? "PRIVATE KEY", q.data!.Key_bin!), "application/x-pem-file")}
                  >
                    <span data-testid="export-key">Export private key…</span>
                  </ConfirmButton>
                )}
              </Group>],
          ]} />
        )}
      </QueryState>
    </Section>
  );
}

interface Candidate { certB64: string; keyB64: string; info: CertInfo; fp: string; key: KeyInfo; notes: string[] }

async function readInput(file: File | null, text: string, want: "cert" | "key"): Promise<{ der: Uint8Array; note?: string } | null> {
  if (file) return readDerOrPem(new Uint8Array(await file.arrayBuffer()), want);
  if (text.trim()) return readDerOrPem(new TextEncoder().encode(text), want);
  return null;
}

function AfterChange({ serverId, expectedFp, what }: { serverId: number; expectedFp?: string | null; what: string }) {
  return (
    <Alert color="blue" variant="light" mt="md" icon={<IconCertificate size={16} />} title={`${what} — now update the manager's trust`}>
      <Text size="sm" mb="sm">
        The VPN Server now presents a new certificate. If the manager pins this server's fingerprint, every further request will fail with a
        certificate mismatch until the pin is updated. Check the presented certificate and pin it:
      </Text>
      <RepinPanel serverId={serverId} expectedFp={expectedFp} canEdit autoProbe />
    </Alert>
  );
}

function ReplaceCert({ serverId, serverName }: { serverId: number; serverName: string }) {
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [certFile, setCertFile] = useState<File | null>(null);
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [certText, setCertText] = useState("");
  const [keyText, setKeyText] = useState("");
  const [cand, setCand] = useState<Candidate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const set = useRpcMutation(serverId, "SetServerCert", { success: "Server certificate replaced", onSuccess: () => setDone(cand?.fp ?? null) });

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setCand(null);
    void (async () => {
      try {
        const c = await readInput(mode === "file" ? certFile : null, mode === "paste" ? certText : "", "cert");
        const k = await readInput(mode === "file" ? keyFile : null, mode === "paste" ? keyText : "", "key");
        if (!c || !k) return;
        const info = parseCertificate(c.der);
        const key = inspectPrivateKey(k.der);
        const fp = await fingerprint256(c.der);
        const notes: string[] = [];
        if (c.note) notes.push(c.note);
        if (info.rsaModulus && key.rsaModulus && info.rsaModulus !== key.rsaModulus) throw new Error("The private key does not match the certificate (RSA modulus differs).");
        if (!(info.rsaModulus && key.rsaModulus)) notes.push("The key/certificate match could not be verified locally; the server verifies it and rejects a mismatching pair.");
        if (dayjs(info.notAfter).isBefore(dayjs())) notes.push("This certificate has already expired.");
        if (dayjs(info.notBefore).isAfter(dayjs())) notes.push("This certificate is not valid yet.");
        if (!cancelled) setCand({ certB64: bytesToB64(c.der), keyB64: bytesToB64(k.der), info, key, fp, notes });
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [mode, certFile, keyFile, certText, keyText]);

  return (
    <Section title="Replace with your own certificate" description="Install a certificate and private key issued by your CA (e.g. for SSTP clients, which require a trusted certificate whose name matches the host name). PEM or DER files are accepted; the key must not be encrypted.">
      <Stack>
        <SegmentedControl w="fit-content" value={mode} onChange={(v) => setMode(v as "file" | "paste")} data={[{ value: "file", label: "Upload files" }, { value: "paste", label: "Paste PEM" }]} />
        {mode === "file" ? (
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <FileInput label="Certificate" description="X.509 certificate (.pem, .crt, .cer, .der)" placeholder="Choose file…" value={certFile} onChange={setCertFile} clearable accept=".pem,.crt,.cer,.der" leftSection={<IconCertificate size={16} />} data-testid="cert-file" />
            <FileInput label="Private key" description="Unencrypted RSA / EC key (.key, .pem, .der)" placeholder="Choose file…" value={keyFile} onChange={setKeyFile} clearable accept=".key,.pem,.der" leftSection={<IconKey size={16} />} data-testid="key-file" />
          </SimpleGrid>
        ) : (
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <Textarea label="Certificate (PEM)" autosize minRows={6} maxRows={12} ff="monospace" value={certText} onChange={(e) => setCertText(e.currentTarget.value)} placeholder="-----BEGIN CERTIFICATE-----" data-testid="cert-text" />
            <Textarea label="Private key (PEM)" autosize minRows={6} maxRows={12} ff="monospace" value={keyText} onChange={(e) => setKeyText(e.currentTarget.value)} placeholder="-----BEGIN PRIVATE KEY-----" data-testid="key-text" />
          </SimpleGrid>
        )}
        {err && <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>{err}</Alert>}
        {cand && (
          <Alert color="gray" variant="light" title="New certificate preview" data-testid="cert-preview">
            <CertDetails info={cand.info} fp={cand.fp} />
            <Text size="sm" mt="xs">Private key: {cand.key.kind}</Text>
            {cand.notes.length > 0 && <List size="sm" mt="xs" c="orange">{cand.notes.map((n) => <List.Item key={n}>{n}</List.Item>)}</List>}
          </Alert>
        )}
        <Group justify="flex-end">
          <ConfirmButton
            title="Replace the server certificate?"
            color="red" variant="filled" size="sm" confirmLabel="Replace certificate"
            disabled={!cand} typeToConfirm={serverName}
            leftSection={<IconUpload size={16} />}
            message={<Stack gap="xs">
              <Text size="sm">The current certificate and private key will be <b>deleted permanently</b> (export them first if you may need them again).</Text>
              <List size="sm">
                <List.Item>VPN clients that verify or pin the server certificate must be updated to trust <b>{cand?.info.commonName || "the new certificate"}</b>.</List.Item>
                <List.Item><b>This manager pins the fingerprint of this server.</b> After the change it must be re-pinned to <Code>{cand?.fp.slice(0, 23)}…</Code>, otherwise all management requests fail. You will be guided through this next.</List.Item>
                <List.Item>OpenVPN configuration files embedding the old certificate must be regenerated.</List.Item>
              </List>
            </Stack>}
            onConfirm={() => set.mutateAsync({ Cert_bin: cand!.certB64, Key_bin: cand!.keyB64 })}
          >
            <span data-testid="set-server-cert">Install certificate…</span>
          </ConfirmButton>
        </Group>
        {done !== null && <AfterChange serverId={serverId} expectedFp={done} what="Certificate installed" />}
      </Stack>
    </Section>
  );
}

function RegenerateCert({ serverId, serverName, currentCn, host }: { serverId: number; serverName: string; currentCn: string; host: string }) {
  const [cn, setCn] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => { if (!cn) setCn(currentCn || host); }, [currentCn, host]); // eslint-disable-line react-hooks/exhaustive-deps
  const regen = useRpcMutation(serverId, "RegenerateServerCert", { success: "New self-signed certificate generated", onSuccess: () => setDone(true) });
  const valid = /^[A-Za-z0-9.*_-][A-Za-z0-9. _*-]{0,63}$/.test(cn.trim());
  return (
    <Section title="Generate a new self-signed certificate" description="Replaces the current certificate with a freshly generated self-signed one. The CN must equal the host name SSTP clients dial.">
      <Group align="flex-end">
        <TextInput label="Common name (CN)" description="e.g. vpn.example.com" value={cn} onChange={(e) => setCn(e.currentTarget.value)} w={360}
          error={cn && !valid ? "Use a host name (letters, digits, '.', '-', '*')" : undefined} data-testid="regen-cn" />
        <ConfirmButton
          title="Regenerate the server certificate?"
          color="red" variant="filled" size="sm" confirmLabel="Generate new certificate"
          disabled={!valid} typeToConfirm={serverName}
          leftSection={<IconRefresh size={16} />}
          message={<Stack gap="xs">
            <Text size="sm">A new self-signed certificate with CN <Code>{cn.trim()}</Code> is created and the current certificate and private key are <b>deleted permanently</b>.</Text>
            <Text size="sm"><b>The manager's pinned fingerprint must be updated afterwards</b>, and every client that trusts the old certificate must be updated.</Text>
          </Stack>}
          onConfirm={() => regen.mutateAsync({ StrValue_str: cn.trim() })}
        >
          <span data-testid="regen-cert">Generate…</span>
        </ConfirmButton>
      </Group>
      {done && <AfterChange serverId={serverId} what="Self-signed certificate generated" />}
    </Section>
  );
}

function CipherSection({ serverId, isAdmin }: { serverId: number; isAdmin: boolean }) {
  const cur = useRpc<{ String_str?: string }>(serverId, "GetServerCipher");
  const list = useRpc<{ String_str?: string }>(serverId, "GetServerCipherList", {}, { retry: false });
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => { if (cur.data) setValue(cur.data.String_str ?? ""); }, [cur.data]);
  const save = useRpcMutation(serverId, "SetServerCipher", { success: "TLS cipher updated" });
  const data = useMemo(() => {
    const names = (list.data?.String_str ?? "").split(";").map((s) => s.trim()).filter(Boolean);
    const tls13 = names.filter((n) => n.startsWith("TLS_"));
    const other = names.filter((n) => !n.startsWith("TLS_"));
    const current = cur.data?.String_str ?? "";
    const groups = [
      { group: "Default", items: [{ value: "~DEFAULT~", label: "Default — let the TLS library negotiate (recommended)" }] },
      ...(tls13.length ? [{ group: "TLS 1.3 suites", items: tls13 }] : []),
      ...(other.length ? [{ group: "TLS 1.2 and older", items: other }] : []),
    ];
    if (current && current !== "~DEFAULT~" && !names.includes(current)) groups.push({ group: "Current", items: [current] });
    return groups;
  }, [list.data, cur.data]);
  const dirty = value !== null && cur.data && value !== (cur.data.String_str ?? "");
  const weak = !!value && /RC4|DES|MD5|NULL|EXPORT|-SHA$|^AES\d+-SHA/i.test(value);
  return (
    <Section title="TLS encryption algorithm" description="Algorithm used for the TLS connection between the VPN Server and VPN clients / bridges / admin tools. Pinning a single suite limits which clients can connect.">
      <QueryState query={cur}>
        <Group align="flex-end">
          <Select
            label="Cipher suite" data={data} value={value} onChange={setValue} searchable allowDeselect={false} w={480}
            readOnly={!isAdmin} description={list.error ? "Could not load the supported cipher list; only the current value is shown." : `Current: ${cur.data?.String_str === "~DEFAULT~" ? "Default" : cur.data?.String_str ?? "–"}`}
            data-testid="cipher-select"
          />
          {isAdmin && (
            <ConfirmButton
              title="Change the TLS cipher?"
              color="orange" variant="filled" size="sm" confirmLabel="Apply" disabled={!dirty}
              message={<Stack gap="xs">
                <Text size="sm">New setting: <Code>{value === "~DEFAULT~" ? "Default" : value}</Code></Text>
                <Text size="sm">Clients (including this manager) that do not support the selected suite will no longer be able to connect. Existing sessions are not interrupted.</Text>
                {weak && <Text size="sm" c="red">This suite is considered weak.</Text>}
              </Stack>}
              onConfirm={() => save.mutateAsync({ String_str: value ?? "~DEFAULT~" })}
            >
              <span data-testid="save-cipher">Apply</span>
            </ConfirmButton>
          )}
        </Group>
        {weak && <Text size="xs" c="orange" mt={4}>The selected suite is considered weak (no forward secrecy or legacy algorithms).</Text>}
      </QueryState>
    </Section>
  );
}

export default function CertificatePage() {
  const { serverId } = useScope();
  const { server, role, isAdmin } = useServerAccess(serverId);
  const s = server.data;
  const cert = useRpc<KeyPair>(serverId, "GetServerCert");
  const currentCn = useMemo(() => {
    try { return cert.data?.Cert_bin ? parseCertificate(b64ToBytes(cert.data.Cert_bin)).commonName : ""; } catch { return ""; }
  }, [cert.data]);
  return (
    <>
      <PageHeader title="Certificate & TLS" description="Server SSL certificate, TLS cipher, and the trust relationship between this manager and the VPN Server." />
      {!isAdmin && <ReadOnlyNotice role={role} />}
      <CurrentCert serverId={serverId} serverName={s?.name ?? "server"} pinned={s?.tlsMode === "pin" ? s.tlsFingerprint : undefined} isAdmin={isAdmin} />
      <Section title="Manager trust" description="How this manager verifies the server's certificate. After any certificate change the pinned fingerprint must be updated.">
        <RepinPanel serverId={serverId} canEdit={isAdmin} />
      </Section>
      {isAdmin && s && (
        <>
          <ReplaceCert serverId={serverId} serverName={s.name} />
          <RegenerateCert serverId={serverId} serverName={s.name} currentCn={currentCn} host={s.host} />
        </>
      )}
      <CipherSection serverId={serverId} isAdmin={isAdmin} />
    </>
  );
}
