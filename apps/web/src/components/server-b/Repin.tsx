import { useEffect, useState } from "react";
import { Alert, Badge, Button, Code, Group, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconPin, IconRadar } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { post, put } from "../../lib/api";
import { notifyError, useServer } from "../../lib/hooks";
import { ConfirmButton, KeyValue } from "../common";
import { normalizeFp } from "./x509";

interface ProbeResult { fingerprint: string; subject: string; issuer: string; validFrom: string; validTo: string; selfSigned: boolean; pem: string }

/**
 * Checks the certificate the server presents right now against the fingerprint pinned in the
 * manager, and lets an admin re-pin it (POST /api/servers/probe + PUT /api/servers/:id).
 */
export function RepinPanel({ serverId, expectedFp, canEdit, autoProbe }: { serverId: number; expectedFp?: string | null; canEdit: boolean; autoProbe?: boolean }) {
  const qc = useQueryClient();
  const server = useServer(serverId);
  const s = server.data;
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState(false);

  const doProbe = async () => {
    if (!s) return;
    setBusy(true);
    try {
      setProbe(await post<ProbeResult>("/api/servers/probe", { host: s.host, port: s.port }));
    } catch (e) {
      notifyError(e, "Could not fetch the presented certificate");
    } finally {
      setBusy(false);
    }
  };
  const ready = !!s;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (autoProbe && ready && canEdit) void doProbe(); }, [autoProbe, ready, canEdit]);

  if (!s) return null;
  const pinned = normalizeFp(s.tlsFingerprint);
  const presented = probe ? normalizeFp(probe.fingerprint) : "";
  const matchesPin = !!probe && presented === pinned;
  const matchesExpected = expectedFp ? presented === normalizeFp(expectedFp) : undefined;

  const repin = async () => {
    try {
      await put(`/api/servers/${serverId}`, { tlsFingerprint: probe!.fingerprint });
      notifications.show({ color: "green", message: "Pinned fingerprint updated" });
      await qc.invalidateQueries();
    } catch (e) {
      notifyError(e, "Update pinned fingerprint");
      throw e;
    }
  };

  return (
    <Stack gap="sm" data-testid="repin-panel">
      <KeyValue rows={[
        ["Manager TLS mode", <Badge variant="light" color={s.tlsMode === "pin" ? "blue" : s.tlsMode === "ca" ? "teal" : "orange"}>{s.tlsMode === "pin" ? "Pinned fingerprint" : s.tlsMode === "ca" ? "Custom CA" : "Insecure (no verification)"}</Badge>],
        ["Pinned SHA-256 fingerprint", s.tlsFingerprint ? <Code style={{ wordBreak: "break-all" }} data-testid="pinned-fp">{s.tlsFingerprint}</Code> : <Text size="sm" c="dimmed">None</Text>],
      ]} />
      {s.tlsMode === "ca" && <Text size="sm" c="dimmed">The manager trusts this server through a CA certificate. A new server certificate must be issued by that CA (and match the host name), otherwise update the server's TLS settings on the Servers page.</Text>}
      {s.tlsMode === "insecure" && <Text size="sm" c="orange">The manager does not verify this server's certificate. Consider pinning the fingerprint.</Text>}
      {canEdit && (
        <Group>
          <Button variant="light" size="xs" leftSection={<IconRadar size={14} />} loading={busy} onClick={doProbe} data-testid="probe-cert">
            Check the certificate presented by {s.host}:{s.port}
          </Button>
        </Group>
      )}
      {probe && (
        <Alert
          color={matchesPin ? "green" : matchesExpected === false ? "red" : "yellow"} variant="light"
          icon={matchesPin ? <IconCheck size={16} /> : <IconAlertTriangle size={16} />}
          title={matchesPin ? "The presented certificate matches the pinned fingerprint" : "The presented certificate differs from the pinned fingerprint"}
        >
          <KeyValue rows={[
            ["Presented fingerprint", <Code style={{ wordBreak: "break-all" }} data-testid="presented-fp">{probe.fingerprint}</Code>],
            ["Subject", probe.subject],
            ["Issuer", probe.issuer + (probe.selfSigned ? " (self-signed)" : "")],
            ["Valid", `${probe.validFrom} → ${probe.validTo}`],
          ]} />
          {matchesExpected === true && !matchesPin && <Text size="sm" mt="xs">This is the certificate you just installed.</Text>}
          {matchesExpected === false && (
            <Text size="sm" c="red" mt="xs" fw={500}>
              This is NOT the certificate you just installed. Do not pin it unless you understand why (a proxy or a man-in-the-middle could be presenting it).
            </Text>
          )}
          {!matchesPin && canEdit && s.tlsMode !== "ca" && (
            <Group mt="sm">
              <ConfirmButton
                title="Pin the presented certificate?"
                color={matchesExpected === false ? "red" : "blue"} variant="filled" size="xs" confirmLabel="Update pinned fingerprint"
                leftSection={<IconPin size={14} />}
                message={<Stack gap={4}>
                  <Text size="sm">The manager will trust only this certificate for <b>{s.name}</b> from now on:</Text>
                  <Code style={{ wordBreak: "break-all" }}>{probe.fingerprint}</Code>
                  <Text size="sm" c="dimmed">Compare it with the fingerprint shown by the server console (vpncmd ServerCertGet) if in doubt.</Text>
                </Stack>}
                onConfirm={repin}
              >
                <span data-testid="repin-confirm">Update pinned fingerprint</span>
              </ConfirmButton>
            </Group>
          )}
        </Alert>
      )}
    </Stack>
  );
}
