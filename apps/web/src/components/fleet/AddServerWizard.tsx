import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  Alert, Button, Center, Checkbox, Group, Loader, Modal, NumberInput, PasswordInput, Radio, SegmentedControl, Stack, Stepper, Switch,
  TagsInput, Text, TextInput, Textarea,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconCircleCheck, IconRefresh } from "@tabler/icons-react";
import { post } from "../../lib/api";
import { notifyError } from "../../lib/hooks";
import { dt } from "../../lib/format";
import type { Server } from "../../lib/types";
import { ErrorAlert, KeyValue } from "../common";
import { CertDetails, ConnectionErrorAlert, TLS_MODES, normFp, type ProbeResult, type TlsMode } from "./tls";

export const SERVER_TYPES: Record<number, string> = { 0: "Standalone server", 1: "Cluster controller", 2: "Cluster member" };

interface TestResult { ok: boolean; info: Record<string, any>; capsCount: number | null }

export function ServerInfoSummary({ info, capsCount }: { info: Record<string, any>; capsCount?: number | null }) {
  return (
    <KeyValue rows={[
      ["Product", info.ServerProductName_str ?? "–"],
      ["Version", `${info.ServerVersionString_str ?? "–"}`],
      ["Build", `${info.ServerBuildInt_u32 ?? "–"} (${dt(info.ServerBuildDate_dt)})`],
      ["Host name", info.ServerHostName_str ?? "–"],
      ["Operating system", [info.OsProductName_str, info.OsVersion_str].filter(Boolean).join(" ") || "–"],
      ["Server type", SERVER_TYPES[info.ServerType_u32 as number] ?? String(info.ServerType_u32 ?? "–")],
      ...(capsCount != null ? [["Capabilities reported", String(capsCount)] as [string, string]] : []),
    ]} />
  );
}

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

export function AddServerWizard({ opened, onClose, existingTags }: { opened: boolean; onClose: () => void; existingTags: string[] }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  // Step 1
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number>(443);
  const [mode, setMode] = useState<"server" | "hub">("server");
  const [hub, setHub] = useState("");
  const [password, setPassword] = useState("");
  // Step 2
  const [tlsMode, setTlsMode] = useState<TlsMode>("pin");
  const [fingerprint, setFingerprint] = useState("");
  const [fpConfirmed, setFpConfirmed] = useState(false);
  const [caPem, setCaPem] = useState("");
  const [insecureAck, setInsecureAck] = useState(false);
  // Step 4
  const [name, setName] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [openAfter, setOpenAfter] = useState(true);

  const probe = useMutation<ProbeResult, Error, void>({
    mutationFn: () => post<ProbeResult>("/api/servers/probe", { host: host.trim(), port }),
    onSuccess: (r) => { setFingerprint(r.fingerprint); setFpConfirmed(false); },
  });
  const body = () => ({
    name: name.trim() || host.trim(),
    host: host.trim(),
    port,
    hub: mode === "hub" ? hub.trim() : null,
    password,
    tlsMode,
    tlsFingerprint: tlsMode === "pin" ? fingerprint.trim() : null,
    caPem: tlsMode === "ca" ? caPem.trim() : null,
  });
  const test = useMutation<TestResult, Error, void>({
    mutationFn: () => post<TestResult>("/api/servers/test", body()),
    onSuccess: (r) => { if (!name) setName(String(r.info.ServerHostName_str ?? host)); },
  });
  const create = useMutation<Server, Error, void>({
    mutationFn: () => post<Server>("/api/servers", { ...body(), tags, notes, enabled }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["fleet-summary"] });
      notifications.show({ color: "green", message: `Server ${s.name} added` });
      close();
      if (openAfter) nav(`/servers/${s.id}`);
    },
    onError: (e) => notifyError(e, "Could not add server"),
  });

  const reset = () => {
    setStep(0); setHost(""); setPort(443); setMode("server"); setHub(""); setPassword("");
    setTlsMode("pin"); setFingerprint(""); setFpConfirmed(false); setCaPem(""); setInsecureAck(false);
    setName(""); setTags([]); setNotes(""); setEnabled(true);
    setProbedKey(""); probe.reset(); test.reset(); create.reset();
  };
  const close = () => { onClose(); setTimeout(reset, 200); };

  // Auto-run probe on entering step 2 and test on entering step 3
  const [probedKey, setProbedKey] = useState("");
  useEffect(() => {
    const key = `${host.trim()}:${port}`;
    if (opened && step === 1 && probedKey !== key) { setProbedKey(key); probe.mutate(); }
  }, [step, opened]);
  useEffect(() => { if (opened && step === 2) { test.reset(); test.mutate(); } }, [step, opened]);

  const step1Valid = host.trim().length > 0 && port >= 1 && port <= 65535 && (mode === "server" || hub.trim().length > 0);
  const step2Valid =
    (tlsMode === "pin" && normFp(fingerprint).length === 64 && fpConfirmed) ||
    (tlsMode === "ca" && PEM_RE.test(caPem)) ||
    (tlsMode === "insecure" && insecureAck);
  const fpEdited = !!probe.data && normFp(fingerprint) !== normFp(probe.data.fingerprint);

  return (
    <Modal opened={opened} onClose={close} title="Add SoftEther VPN Server" size="xl" centered closeOnClickOutside={false}>
      <Stepper active={step} onStepClick={(i) => i < step && setStep(i)} size="sm" mb="md" allowNextStepsSelect={false}>
        <Stepper.Step label="Connection" description="Host & credentials">
          <Stack mt="md" data-testid="wizard-step-connection">
            <Group grow align="flex-start">
              <TextInput label="Host" required placeholder="vpn.example.com or 10.0.0.5" value={host} onChange={(e) => setHost(e.currentTarget.value)} data-autofocus data-testid="wizard-host"
                description="DNS name or IP address of the VPN Server" />
              <NumberInput label="Admin port" required min={1} max={65535} value={port} onChange={(v) => setPort(Number(v) || 0)} maw={160} allowDecimal={false} data-testid="wizard-port"
                description="443, 992, 1194 or 5555 by default" />
            </Group>
            <div>
              <Text size="sm" fw={500} mb={4}>Administration mode</Text>
              <SegmentedControl value={mode} onChange={(v) => setMode(v as "server" | "hub")} data={[
                { value: "server", label: "Server administrator" }, { value: "hub", label: "Virtual Hub administrator" },
              ]} />
              <Text size="xs" c="dimmed" mt={4}>
                {mode === "server"
                  ? "Full control of the whole VPN Server using the server administrator password."
                  : "Manage a single Virtual Hub using that hub's administrator password (set in the hub properties). Server-wide settings are not available in this mode."}
              </Text>
            </div>
            {mode === "hub" && <TextInput label="Virtual Hub name" required value={hub} onChange={(e) => setHub(e.currentTarget.value)} data-testid="wizard-hub" />}
            <PasswordInput label={mode === "hub" ? "Hub administrator password" : "Server administrator password"} value={password} onChange={(e) => setPassword(e.currentTarget.value)}
              autoComplete="new-password" description="Stored encrypted on the management server. Leave empty if the server has no password (not recommended)." data-testid="wizard-password" />
          </Stack>
        </Stepper.Step>

        <Stepper.Step label="TLS trust" description="Verify certificate">
          <Stack mt="md" data-testid="wizard-step-tls">
            {probe.isPending && <Center py="md"><Group gap="xs"><Loader size="sm" /><Text size="sm">Fetching the certificate presented by {host}:{port}…</Text></Group></Center>}
            {probe.error && <ConnectionErrorAlert error={probe.error} />}
            {probe.data && (
              <>
                <Text size="sm" c="dimmed">The server at <b>{host}:{port}</b> presented this certificate. Compare the fingerprint with the one shown on the server itself (e.g. <code>vpncmd /server … ServerCertGet</code> or the server manager) before trusting it.</Text>
                <CertDetails probe={probe.data} />
              </>
            )}
            <Group justify="flex-end"><Button size="xs" variant="subtle" leftSection={<IconRefresh size={14} />} onClick={() => probe.mutate()} loading={probe.isPending}>Probe again</Button></Group>
            <Radio.Group label="Trust mode" value={tlsMode} onChange={(v) => setTlsMode(v as TlsMode)}>
              <Stack gap="xs" mt={6}>
                {TLS_MODES.map((m) => (
                  <Radio key={m.value} value={m.value} label={m.label} description={m.description} color={m.value === "insecure" ? "red" : undefined} data-testid={`wizard-tls-${m.value}`} />
                ))}
              </Stack>
            </Radio.Group>
            {tlsMode === "pin" && (
              <>
                <TextInput label="SHA-256 fingerprint to pin" value={fingerprint} onChange={(e) => { setFingerprint(e.currentTarget.value); setFpConfirmed(false); }} ff="monospace"
                  error={fingerprint && normFp(fingerprint).length !== 64 ? "Must be 32 hex bytes (64 hex digits)" : undefined}
                  description={fpEdited ? "Edited — differs from the probed certificate; the connection test will fail unless this matches." : "Pre-filled from the probe. You may paste a fingerprint obtained out-of-band instead."} />
                <Checkbox checked={fpConfirmed} onChange={(e) => setFpConfirmed(e.currentTarget.checked)} disabled={normFp(fingerprint).length !== 64}
                  label="I have verified that this fingerprint belongs to my server" data-testid="wizard-fp-confirm" />
              </>
            )}
            {tlsMode === "ca" && (
              <Textarea label="CA certificate (PEM)" required autosize minRows={5} maxRows={12} ff="monospace" value={caPem} onChange={(e) => setCaPem(e.currentTarget.value)}
                placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"} error={caPem && !PEM_RE.test(caPem) ? "Not a PEM certificate" : undefined}
                description="The root or intermediate CA that issued the server certificate. The host name must match the certificate." />
            )}
            {tlsMode === "insecure" && (
              <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Certificate verification disabled">
                <Stack gap="xs">
                  <Text size="sm">The management server will accept any certificate. An attacker on the network path can impersonate this VPN Server and steal the administrator password. Use only in isolated lab environments.</Text>
                  <Checkbox checked={insecureAck} onChange={(e) => setInsecureAck(e.currentTarget.checked)} color="red" label="I understand the risk" data-testid="wizard-insecure-ack" />
                </Stack>
              </Alert>
            )}
          </Stack>
        </Stepper.Step>

        <Stepper.Step label="Test" description="Verify credentials">
          <Stack mt="md" data-testid="wizard-step-test">
            {test.isPending && <Center py="md"><Group gap="xs"><Loader size="sm" /><Text size="sm">Connecting and calling GetServerInfo…</Text></Group></Center>}
            {test.error && (
              <ConnectionErrorAlert error={test.error} onTrust={(fp) => { setTlsMode("pin"); setFingerprint(fp); setFpConfirmed(false); setStep(1); }} />
            )}
            {test.data && (
              <>
                <Alert color="green" icon={<IconCircleCheck size={18} />} title="Connection successful" data-testid="wizard-test-ok">Credentials and TLS settings work.</Alert>
                <ServerInfoSummary info={test.data.info} capsCount={test.data.capsCount} />
              </>
            )}
            <Group justify="flex-end"><Button size="xs" variant="subtle" leftSection={<IconRefresh size={14} />} onClick={() => test.mutate()} loading={test.isPending}>Test again</Button></Group>
          </Stack>
        </Stepper.Step>

        <Stepper.Step label="Details" description="Name & tags">
          <Stack mt="md" data-testid="wizard-step-details">
            <TextInput label="Display name" required value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={100} data-testid="wizard-name" />
            <TagsInput label="Tags" description="Group servers by site, environment, customer… Press Enter to add." data={existingTags} value={tags} onChange={setTags} clearable maxTags={30} />
            <Textarea label="Notes" autosize minRows={2} maxRows={6} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} maxLength={5000} />
            <Switch label="Enabled (poll this server and allow management)" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
            <Checkbox label="Open the server after adding it" checked={openAfter} onChange={(e) => setOpenAfter(e.currentTarget.checked)} />
            {create.error && <ErrorAlert error={create.error} />}
          </Stack>
        </Stepper.Step>
      </Stepper>

      <Group justify="space-between" mt="md">
        <Button variant="default" onClick={() => (step === 0 ? close() : setStep(step - 1))}>{step === 0 ? "Cancel" : "Back"}</Button>
        <Group gap="xs">
          {step === 2 && test.error && <Button variant="subtle" color="gray" onClick={() => setStep(3)}>Continue without a successful test</Button>}
          {step < 3 ? (
            <Button onClick={() => setStep(step + 1)} data-testid="wizard-next"
              disabled={(step === 0 && !step1Valid) || (step === 1 && !step2Valid) || (step === 2 && !test.data)}>Next</Button>
          ) : (
            <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()} data-testid="wizard-create">Add server</Button>
          )}
        </Group>
      </Group>
    </Modal>
  );
}
