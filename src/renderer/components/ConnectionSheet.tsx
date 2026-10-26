// Add / edit a connection setting, the way SoftEther's Server Manager does it:
//   form → probe the certificate → confirm its fingerprint → test the login → save.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button, Checkbox, Collapse, Group, NumberInput, PasswordInput, Radio, SegmentedControl, Stack, Switch, TagsInput, Textarea,
  TextInput, UnstyledButton,
} from "@mantine/core";
import { IconCheck, IconChevronRight, IconCircleDashed, IconFileImport, IconLoader2, IconServer2, IconShieldCheck } from "@tabler/icons-react";
import dayjs from "dayjs";
import { ApiError, openFile, post, put } from "../lib/api";
import { notifySuccess, useServer, useServers } from "../lib/hooks";
import { normFp, colonFp } from "../lib/format";
import { secretStore } from "../lib/platform";
import type { ProbeResult, Server, ServerInput, TestResult, TlsMode, Transport } from "../lib/types";
import { serverBase } from "../sections";
import { ErrorState, FingerprintField, FormRow, FormSection, PropertyList, Sheet, Tag } from "../design";

interface FormState {
  name: string; host: string; port: number; hubMode: boolean; hub: string; password: string; savePassword: boolean;
  transport: Transport; tlsMode: TlsMode; fingerprint: string; caPem: string; insecureAck: boolean; tags: string[]; notes: string;
}

const EMPTY: FormState = {
  name: "", host: "", port: 443, hubMode: false, hub: "", password: "", savePassword: true,
  transport: "native", tlsMode: "pin", fingerprint: "", caPem: "", insecureAck: false, tags: [], notes: "",
};

const COMMON_PORTS = [443, 992, 1194, 5555];
const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

type Step = "form" | "trust" | "working";
type Phase = "probe" | "test" | "save";

function fromServer(s: Server): FormState {
  return {
    name: s.name, host: s.host, port: s.port, hubMode: !!s.hub, hub: s.hub ?? "", password: "", savePassword: s.passwordSaved,
    transport: s.transport ?? "native", tlsMode: s.tlsMode, fingerprint: s.fingerprint ?? "", caPem: "", insecureAck: s.tlsMode === "insecure",
    tags: s.tags ?? [], notes: s.notes ?? "",
  };
}

function Progress({ phase, skipProbe, skipTest }: { phase: Phase; skipProbe: boolean; skipTest: boolean }) {
  const order: Phase[] = ["probe", "test", "save"];
  const items: { p: Phase; label: string; skip: boolean }[] = [
    { p: "probe", label: "Verify the server’s certificate", skip: skipProbe },
    { p: "test", label: "Sign in with the administrator password", skip: skipTest },
    { p: "save", label: "Save the connection", skip: false },
  ];
  return (
    <div className="sem-progress" role="status" aria-live="polite" data-testid="connection-progress">
      {items.filter((i) => !i.skip).map((i) => {
        const state = order.indexOf(i.p) < order.indexOf(phase) ? "done" : i.p === phase ? "active" : "todo";
        return (
          <div className="sem-progress-row" data-state={state} key={i.p}>
            {state === "done" ? <IconCheck size={15} stroke={2.2} /> : state === "active" ? <IconLoader2 size={15} className="sem-spin" /> : <IconCircleDashed size={15} stroke={1.5} />}
            <span>{i.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function CertSummary({ probe, pinned }: { probe: ProbeResult; pinned?: string | null }) {
  const from = dayjs(probe.validFrom), to = dayjs(probe.validTo), now = dayjs();
  const expired = to.isValid() && to.isBefore(now);
  const notYet = from.isValid() && from.isAfter(now);
  const soon = !expired && to.isValid() && to.diff(now, "day") < 30;
  return (
    <PropertyList labelWidth={110} dense testId="cert-details" items={[
      { label: "Subject", value: <span className="sem-break">{probe.subject || "–"}</span> },
      { label: "Issuer", value: <Group gap={6}><span className="sem-break">{probe.issuer || "–"}</span>{probe.selfSigned && <Tag>Self-signed</Tag>}</Group> },
      { label: "Valid", value: <Group gap={6}>
        <span>{from.isValid() ? from.format("YYYY-MM-DD") : probe.validFrom} to {to.isValid() ? to.format("YYYY-MM-DD") : probe.validTo}</span>
        {expired && <Tag color="red">Expired</Tag>}{notYet && <Tag color="red">Not yet valid</Tag>}{soon && <Tag color="orange">Expires soon</Tag>}
      </Group> },
      ...(pinned ? [{ label: "Trusted now", value: normFp(pinned) === normFp(probe.fingerprint)
        ? <Tag color="green" icon={<IconShieldCheck size={11} />}>Same certificate</Tag>
        : <Tag color="orange">Different certificate</Tag> }] : []),
    ]} />
  );
}

export function ConnectionSheet({ opened, serverId, onClose }: { opened: boolean; serverId?: number; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const editing = serverId !== undefined;
  const existing = useServer(editing ? serverId : undefined);
  const servers = useServers();
  const [f, setF] = useState<FormState>(EMPTY);
  const [step, setStep] = useState<Step>("form");
  const [phase, setPhaseState] = useState<Phase>("probe");
  const phaseRef = useRef<Phase>("probe");
  const setPhase = (p: Phase) => { phaseRef.current = p; setPhaseState(p); };
  const [advanced, setAdvanced] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [testFailed, setTestFailed] = useState(false);
  const [touched, setTouched] = useState(false);
  const store = secretStore();

  // Initialise when opened
  useEffect(() => {
    if (!opened) return;
    setStep("form"); setProbe(null); setError(null); setTestFailed(false); setTouched(false);
    if (!editing) { setF(EMPTY); setAdvanced(false); }
  }, [opened, editing]);
  useEffect(() => {
    if (opened && editing && existing.data) { setF(fromServer(existing.data)); setAdvanced(existing.data.tlsMode !== "pin" || existing.data.transport !== "native"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, editing, existing.data?.id]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => { setF((p) => ({ ...p, [k]: v })); setTestFailed(false); };
  const orig = existing.data;
  const endpointChanged = !orig || orig.host !== f.host.trim() || orig.port !== f.port;
  const skipProbe = f.tlsMode !== "pin" || (!!orig && !endpointChanged && !!f.fingerprint && normFp(f.fingerprint) === normFp(orig.fingerprint));
  const skipTest = editing && !f.password && !!orig?.passwordSaved;
  const allTags = useMemo(() => [...new Set((servers.data ?? []).flatMap((s) => s.tags))].sort(), [servers.data]);

  const errors = {
    host: !f.host.trim() ? "Enter a host name or IP address." : /\s/.test(f.host.trim()) ? "Host names can’t contain spaces." : null,
    port: !(f.port >= 1 && f.port <= 65535) ? "Enter a port between 1 and 65535." : null,
    hub: f.hubMode && !f.hub.trim() ? "Enter the name of the Virtual Hub." : null,
    ca: f.tlsMode === "ca" && !PEM_RE.test(f.caPem) && !(orig?.hasCa && orig.tlsMode === "ca") ? "Paste or choose a PEM certificate." : null,
    insecure: f.tlsMode === "insecure" && !f.insecureAck ? "Confirm that you understand the risk." : null,
    fp: f.tlsMode === "pin" && f.fingerprint && normFp(f.fingerprint).length !== 64 ? "A SHA-256 fingerprint has 64 hexadecimal digits." : null,
  };
  const valid = !Object.values(errors).some(Boolean);

  const body = (): ServerInput => ({
    name: f.name.trim() || f.host.trim(),
    host: f.host.trim(),
    port: f.port,
    hub: f.hubMode ? f.hub.trim() : null,
    password: f.password,
    savePassword: f.savePassword,
    transport: f.transport,
    tlsMode: f.tlsMode,
    fingerprint: f.tlsMode === "pin" ? colonFp(f.fingerprint) || null : null,
    caPem: f.tlsMode === "ca" && f.caPem.trim() ? f.caPem.trim() : null,
    tags: f.tags,
    notes: f.notes,
  });

  const save = async (fingerprint = f.fingerprint) => {
    setPhase("save");
    const b = { ...body(), fingerprint: f.tlsMode === "pin" ? colonFp(fingerprint) || null : null };
    const s = editing ? await put<Server>(`/api/servers/${serverId}`, b) : await post<Server>("/api/servers", b);
    await qc.invalidateQueries();
    notifySuccess(editing ? `Saved ${s.name}` : `Added ${s.name}`);
    onClose();
    if (!editing) nav(serverBase(s.id));
  };

  const test = async (fingerprint: string) => {
    if (skipTest) return save(fingerprint);
    setPhase("test");
    const b = body();
    const r = await post<TestResult>("/api/servers/test", {
      host: b.host, port: b.port, hub: b.hub, password: b.password, transport: b.transport, tlsMode: b.tlsMode,
      fingerprint: b.tlsMode === "pin" ? colonFp(fingerprint) : null, caPem: b.caPem,
    });
    if (r && r.ok === false) throw new ApiError(502, { error: r.error ?? "The connection test failed", kind: r.kind, presentedFingerprint: r.presentedFingerprint });
    if (!f.name.trim() && r?.info?.ServerHostName_str) setF((p) => ({ ...p, name: p.name || String(r.info!.ServerHostName_str) }));
    return save(fingerprint);
  };

  const fail = (e: unknown, afterTest: boolean) => {
    setError(e);
    setTestFailed(afterTest);
    setStep("form");
  };

  const onContinue = async () => {
    setTouched(true);
    if (!valid) return;
    setError(null);
    setStep("working");
    if (!skipProbe) {
      setPhase("probe");
      try {
        const r = await post<ProbeResult>("/api/servers/probe", { host: f.host.trim(), port: f.port });
        setProbe(r);
        setStep("trust");
      } catch (e) { fail(e, false); }
      return;
    }
    try { await test(f.fingerprint); } catch (e) { fail(e, phaseRef.current === "test"); }
  };

  const onTrust = async () => {
    if (!probe) return;
    set("fingerprint", colonFp(probe.fingerprint));
    setStep("working");
    try { await test(probe.fingerprint); } catch (e) { fail(e, phaseRef.current === "test"); }
  };

  const onSaveAnyway = async () => {
    setStep("working");
    try { await save(); } catch (e) { fail(e, false); }
  };

  const retrust = (fp: string) => {
    setProbe((p) => (p ? { ...p, fingerprint: fp } : { fingerprint: fp, subject: "", issuer: "", validFrom: "", validTo: "", selfSigned: false }));
    setError(null);
    setStep("trust");
  };

  const title = editing ? <>Edit “{orig?.name ?? "Connection"}”</> : "New Connection";
  const err = (k: keyof typeof errors) => (touched ? errors[k] ?? undefined : undefined);

  let content: ReactNode;
  let footer: ReactNode;
  if (step === "working") {
    content = <Progress phase={phase} skipProbe={skipProbe && !probe} skipTest={skipTest} />;
    footer = <Group justify="flex-end"><Button variant="default" disabled>Cancel</Button><Button loading>Connecting</Button></Group>;
  } else if (step === "trust" && probe) {
    content = (
      <Stack gap={14} data-testid="connection-trust">
        <div>
          <div className="sem-sheet-lead">Verify the server’s identity</div>
          <p className="sem-sheet-text">
            <b>{f.host.trim()}:{f.port}</b> presented this certificate. If you can, compare the fingerprint with the one shown on the
            server itself before you trust it. After that, this app refuses to connect if the certificate changes.
          </p>
        </div>
        <FingerprintField value={probe.fingerprint} label="SHA-256 fingerprint" compare={editing && orig?.fingerprint ? orig.fingerprint : undefined} />
        {probe.subject && <CertSummary probe={probe} pinned={editing ? orig?.fingerprint : undefined} />}
      </Stack>
    );
    footer = (
      <Group justify="space-between">
        <Button variant="default" onClick={() => setStep("form")}>Back</Button>
        <Button onClick={onTrust} leftSection={<IconShieldCheck size={15} />} data-testid="connection-trust-confirm">Trust and Connect</Button>
      </Group>
    );
  } else {
    content = (
      <form id="connection-form" onSubmit={(e) => { e.preventDefault(); void onContinue(); }} data-testid="connection-form">
        {!!error && (
          <div style={{ marginBottom: 14 }}>
            <ErrorState error={error} inline onTrust={retrust} testId="connection-error" />
          </div>
        )}
        <FormSection title="Server">
          <FormRow label="Name" description="Shown in the sidebar.">{(id) => (
            <TextInput id={id} value={f.name} onChange={(e) => set("name", e.currentTarget.value)} placeholder={f.host.trim() || "e.g. Tokyo office"} maxLength={100} data-testid="conn-name" />
          )}</FormRow>
          <FormRow label="Host name">{(id) => (
            <TextInput id={id} value={f.host} onChange={(e) => set("host", e.currentTarget.value)} placeholder="vpn.example.com or 203.0.113.10" error={err("host")}
              data-autofocus={!editing || undefined} autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="conn-host" />
          )}</FormRow>
          <FormRow label="Port" description="Any listener of the VPN Server.">{(id) => (
            <div className="sem-port-row">
              <NumberInput id={id} value={f.port} onChange={(v) => set("port", Number(v) || 0)} min={1} max={65535} allowDecimal={false} hideControls w={84} error={err("port")} data-testid="conn-port" />
              <div className="sem-chips" role="group" aria-label="Common ports">
                {COMMON_PORTS.map((p) => (
                  <UnstyledButton key={p} className="sem-chip" data-active={f.port === p || undefined} onClick={() => set("port", p)} aria-pressed={f.port === p}>{p}</UnstyledButton>
                ))}
              </div>
            </div>
          )}</FormRow>
        </FormSection>

        <FormSection title="Administrator">
          <FormRow label="Hub admin mode" description={f.hubMode ? "Manage a single Virtual Hub with that hub’s own password. Server-wide settings aren’t available." : "Manage the whole server with the server administrator password."}>
            <Switch checked={f.hubMode} onChange={(e) => set("hubMode", e.currentTarget.checked)} aria-label="Administer a single Virtual Hub" data-testid="conn-hubmode" />
          </FormRow>
          {f.hubMode && (
            <FormRow label="Virtual Hub">{(id) => (
              <TextInput id={id} value={f.hub} onChange={(e) => set("hub", e.currentTarget.value)} placeholder="DEFAULT" error={err("hub")} data-testid="conn-hub" />
            )}</FormRow>
          )}
          <FormRow label="Password">{(id) => (
            <PasswordInput id={id} value={f.password} onChange={(e) => set("password", e.currentTarget.value)} autoComplete="new-password"
              placeholder={editing && orig?.passwordSaved ? "Unchanged" : editing ? "Not saved" : undefined} data-testid="conn-password" />
          )}</FormRow>
          <FormRow label="">
            <Checkbox
              label={store.saveLabel} checked={f.savePassword} onChange={(e) => set("savePassword", e.currentTarget.checked)} data-testid="conn-save-password"
              description={f.savePassword ? `The password is ${store.long}.` : "You’ll be asked for it the first time you open this server after starting the app."}
            />
          </FormRow>
        </FormSection>

        <UnstyledButton className="sem-disclosure" data-open={advanced || undefined} onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced} data-testid="conn-advanced">
          <IconChevronRight size={12} stroke={2.2} /> Advanced
          {!advanced && (f.transport !== "native" || f.tlsMode !== "pin") && <Tag color="accent">{f.transport === "jsonrpc" ? "JSON-RPC" : ""}{f.transport === "jsonrpc" && f.tlsMode !== "pin" ? " · " : ""}{f.tlsMode === "ca" ? "CA" : f.tlsMode === "insecure" ? "Not verified" : ""}</Tag>}
        </UnstyledButton>
        <Collapse expanded={advanced}>
          <FormSection>
            <FormRow label="Protocol" description={f.transport === "native"
              ? "SoftEther’s own admin protocol, as used by Server Manager and vpncmd. Works even when the JSON-RPC API is turned off."
              : "The server’s HTTPS JSON-RPC API (/api/). Requires DisableJsonRpcWebApi to be false on the server."} align="start">
              <SegmentedControl value={f.transport} onChange={(v) => set("transport", v as Transport)} data={[{ value: "native", label: "Native" }, { value: "jsonrpc", label: "JSON-RPC" }]} data-testid="conn-transport" />
            </FormRow>
            <FormRow label="Certificate" align="start">
              <Radio.Group value={f.tlsMode} onChange={(v) => set("tlsMode", v as TlsMode)} aria-label="Certificate verification">
                <Stack gap={10}>
                  <Radio value="pin" label="Trust this server’s certificate" description="Recommended. Works with SoftEther’s self-signed certificate; you confirm its fingerprint once." data-testid="conn-tls-pin" />
                  <Radio value="ca" label="Verify with a certificate authority" description="For certificates issued by your own or a public CA. The host name must match." data-testid="conn-tls-ca" />
                  <Radio value="insecure" label="Don’t verify" description="Anyone on the network path could impersonate the server and capture the password." data-testid="conn-tls-insecure" />
                </Stack>
              </Radio.Group>
            </FormRow>
            {f.tlsMode === "pin" && editing && (
              <FormRow label="Fingerprint" description="Leave as is, or paste one you obtained out of band." align="start">{(id) => (
                <TextInput id={id} value={f.fingerprint} onChange={(e) => set("fingerprint", e.currentTarget.value)} ff="monospace" error={err("fp")} data-testid="conn-fingerprint" />
              )}</FormRow>
            )}
            {f.tlsMode === "ca" && (
              <FormRow label="CA certificate" align="start" stacked>{(id) => (
                <Stack gap={6}>
                  <Textarea id={id} value={f.caPem} onChange={(e) => set("caPem", e.currentTarget.value)} autosize minRows={4} maxRows={8} ff="monospace" fz={11}
                    placeholder={orig?.hasCa ? "Unchanged (a CA certificate is saved)" : "-----BEGIN CERTIFICATE-----"} error={err("ca")} data-testid="conn-ca" />
                  <Group><Button size="xs" variant="default" leftSection={<IconFileImport size={14} />} onClick={async () => {
                    const file = await openFile({ title: "Choose CA Certificate", filters: [{ name: "Certificates", extensions: ["pem", "crt", "cer"] }] });
                    if (file) set("caPem", file.content);
                  }}>Choose File…</Button></Group>
                </Stack>
              )}</FormRow>
            )}
            {f.tlsMode === "insecure" && (
              <FormRow label="" error={err("insecure")}>
                <Checkbox color="red" checked={f.insecureAck} onChange={(e) => set("insecureAck", e.currentTarget.checked)} label="I understand the password could be intercepted" data-testid="conn-insecure-ack" />
              </FormRow>
            )}
            <FormRow label="Tags" description="Group and filter servers on the overview.">{(id) => (
              <TagsInput id={id} value={f.tags} onChange={(v) => set("tags", v)} data={allTags} placeholder={f.tags.length ? undefined : "production, tokyo…"} clearable />
            )}</FormRow>
            <FormRow label="Notes" align="start">{(id) => (
              <Textarea id={id} value={f.notes} onChange={(e) => set("notes", e.currentTarget.value)} autosize minRows={2} maxRows={5} maxLength={5000} />
            )}</FormRow>
          </FormSection>
        </Collapse>
      </form>
    );
    footer = (
      <Group justify="space-between">
        <div>{testFailed && <Button variant="subtle" color="gray" onClick={onSaveAnyway} data-testid="conn-save-anyway">Save Without Connecting</Button>}</div>
        <Group gap={8}>
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="connection-form" data-testid="conn-continue">{editing ? "Save" : "Connect"}</Button>
        </Group>
      </Group>
    );
  }

  return (
    <Sheet
      opened={opened}
      onClose={onClose}
      busy={step === "working"}
      title={title}
      subtitle={step === "trust" ? "Certificate check" : editing ? `${orig?.host ?? ""}${orig ? `:${orig.port}` : ""}` : "Connect to a SoftEther VPN Server"}
      icon={<IconServer2 size={20} stroke={1.5} />}
      size={600}
      footer={footer}
      testId="connection-sheet"
    >
      {content}
    </Sheet>
  );
}
