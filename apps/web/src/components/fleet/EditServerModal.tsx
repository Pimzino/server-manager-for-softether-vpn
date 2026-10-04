import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Button, Divider, Group, Modal, NumberInput, PasswordInput, Radio, SegmentedControl, Stack, Switch, TagsInput, Text, TextInput, Textarea,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconCertificate } from "@tabler/icons-react";
import { post, put } from "../../lib/api";
import { notifyError } from "../../lib/hooks";
import type { Server } from "../../lib/types";
import { CertDetails, ConnectionErrorAlert, TLS_MODES, normFp, type ProbeResult, type TlsMode } from "./tls";

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

/**
 * Edit a registered server. Password blank = unchanged; CA PEM blank = keep the stored CA.
 * `repin` opens the dialog and immediately re-probes the certificate.
 */
export function EditServerModal({ server, onClose, repin, existingTags }: { server: Server | null; onClose: () => void; repin?: boolean; existingTags: string[] }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(443);
  const [mode, setMode] = useState<"server" | "hub">("server");
  const [hub, setHub] = useState("");
  const [password, setPassword] = useState("");
  const [tlsMode, setTlsMode] = useState<TlsMode>("pin");
  const [fingerprint, setFingerprint] = useState("");
  const [caPem, setCaPem] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [enabled, setEnabled] = useState(true);

  const probe = useMutation<ProbeResult, Error, { host: string; port: number }>({
    mutationFn: (b) => post<ProbeResult>("/api/servers/probe", b),
  });

  useEffect(() => {
    if (!server) return;
    setName(server.name); setHost(server.host); setPort(server.port);
    setMode(server.hub ? "hub" : "server"); setHub(server.hub ?? ""); setPassword("");
    setTlsMode(server.tlsMode); setFingerprint(server.tlsFingerprint ?? ""); setCaPem("");
    setTags(server.tags); setNotes(server.notes); setEnabled(server.enabled);
    probe.reset();
    if (repin) probe.mutate({ host: server.host, port: server.port });
  }, [server?.id, repin]);

  const save = useMutation({
    mutationFn: () => {
      const b: Record<string, unknown> = {
        name: name.trim(), host: host.trim(), port, hub: mode === "hub" ? hub.trim() : null, tlsMode,
        tlsFingerprint: tlsMode === "pin" ? fingerprint.trim() : null, tags, notes, enabled,
      };
      if (password) b.password = password;
      if (tlsMode === "ca" && caPem.trim()) b.caPem = caPem.trim();
      return put<Server>(`/api/servers/${server!.id}`, b);
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["server", s.id] });
      void qc.invalidateQueries({ queryKey: ["fleet-summary"] });
      void qc.invalidateQueries({ queryKey: ["rpc", s.id] });
      notifications.show({
        color: s.state?.ok === false ? "orange" : "green",
        title: `Server ${s.name} saved`,
        message: s.state?.ok === false ? `Saved, but the server is not reachable: ${s.state.error}` : "Connection verified",
        autoClose: s.state?.ok === false ? 10000 : 4000,
      });
      onClose();
    },
    onError: (e) => notifyError(e, "Could not save server"),
  });

  const fpValid = normFp(fingerprint).length === 64;
  const caRequired = tlsMode === "ca" && !server?.hasCa;
  const valid = name.trim() && host.trim() && port >= 1 && port <= 65535 && (mode === "server" || hub.trim())
    && (tlsMode !== "pin" || fpValid) && (!caRequired || PEM_RE.test(caPem)) && (!caPem.trim() || PEM_RE.test(caPem));
  const fpChanged = !!server && normFp(fingerprint) !== normFp(server.tlsFingerprint);

  return (
    <Modal opened={!!server} onClose={onClose} title={server ? `Edit ${server.name}` : ""} size="lg" centered>
      {server && (
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Stack data-testid="edit-server-form">
            <TextInput label="Display name" required value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={100} />
            <Group grow align="flex-start">
              <TextInput label="Host" required value={host} onChange={(e) => setHost(e.currentTarget.value)} />
              <NumberInput label="Admin port" required min={1} max={65535} maw={140} value={port} onChange={(v) => setPort(Number(v) || 0)} allowDecimal={false} />
            </Group>
            <div>
              <Text size="sm" fw={500} mb={4}>Administration mode</Text>
              <SegmentedControl value={mode} onChange={(v) => setMode(v as "server" | "hub")} data={[{ value: "server", label: "Server administrator" }, { value: "hub", label: "Virtual Hub administrator" }]} />
            </div>
            {mode === "hub" && <TextInput label="Virtual Hub name" required value={hub} onChange={(e) => setHub(e.currentTarget.value)} />}
            <PasswordInput label="Administrator password" placeholder="Unchanged" description="Leave blank to keep the stored password." value={password}
              onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="new-password" />

            <Divider label="TLS trust" labelPosition="left" />
            <Radio.Group value={tlsMode} onChange={(v) => setTlsMode(v as TlsMode)}>
              <Stack gap="xs">
                {TLS_MODES.map((m) => <Radio key={m.value} value={m.value} label={m.label} description={m.description} color={m.value === "insecure" ? "red" : undefined} />)}
              </Stack>
            </Radio.Group>
            {tlsMode === "pin" && (
              <Stack gap="xs">
                <Group align="flex-end" wrap="nowrap">
                  <TextInput style={{ flex: 1 }} label="Pinned SHA-256 fingerprint" ff="monospace" value={fingerprint} onChange={(e) => setFingerprint(e.currentTarget.value)}
                    error={fingerprint && !fpValid ? "Must be 64 hex digits" : !fingerprint ? "Required in pin mode" : undefined} />
                  <Button variant="light" leftSection={<IconCertificate size={16} />} onClick={() => probe.mutate({ host: host.trim(), port })} loading={probe.isPending} data-testid="repin-probe">
                    Re-pin certificate
                  </Button>
                </Group>
                {probe.error && <ConnectionErrorAlert error={probe.error} />}
                {probe.data && (
                  <Alert color={normFp(probe.data.fingerprint) === normFp(server.tlsFingerprint) ? "green" : "orange"} variant="light" title="Certificate presented by the server">
                    <CertDetails probe={probe.data} pinned={server.tlsFingerprint} />
                    <Group justify="flex-end" mt="xs">
                      <Button size="xs" onClick={() => setFingerprint(probe.data!.fingerprint)} disabled={normFp(fingerprint) === normFp(probe.data.fingerprint)} data-testid="repin-use">
                        Pin this certificate
                      </Button>
                    </Group>
                  </Alert>
                )}
                {fpChanged && fpValid && <Text size="xs" c="orange">The pinned fingerprint will change when you save. Make sure you verified the new certificate.</Text>}
              </Stack>
            )}
            {tlsMode === "ca" && (
              <Textarea label="CA certificate (PEM)" autosize minRows={4} maxRows={10} ff="monospace" value={caPem} onChange={(e) => setCaPem(e.currentTarget.value)}
                placeholder={server.hasCa ? "A CA certificate is stored — leave blank to keep it" : "-----BEGIN CERTIFICATE-----"} required={caRequired}
                error={caPem && !PEM_RE.test(caPem) ? "Not a PEM certificate" : undefined} />
            )}
            {tlsMode === "insecure" && (
              <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Certificate verification disabled">
                Anyone able to intercept traffic between the management server and this VPN Server can impersonate it and capture the administrator password.
              </Alert>
            )}

            <Divider label="Details" labelPosition="left" />
            <TagsInput label="Tags" data={existingTags} value={tags} onChange={setTags} clearable maxTags={30} />
            <Textarea label="Notes" autosize minRows={2} maxRows={6} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} maxLength={5000} />
            <Switch label="Enabled" description="Disabled servers are not polled and cannot be managed." checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>Cancel</Button>
              <Button type="submit" loading={save.isPending} disabled={!valid} data-testid="edit-server-save">Save</Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}
