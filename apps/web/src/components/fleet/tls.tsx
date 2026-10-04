import { Alert, Badge, Group, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconShieldCheck } from "@tabler/icons-react";
import dayjs from "dayjs";
import { ApiError } from "../../lib/api";
import { Copyable, ErrorAlert, KeyValue } from "../common";
import type { Server } from "../../lib/types";

/** Result of POST /api/servers/probe */
export interface ProbeResult {
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
  pem: string;
}

export type TlsMode = Server["tlsMode"];

export const TLS_MODES: { value: TlsMode; label: string; description: string }[] = [
  { value: "pin", label: "Pin certificate (recommended)", description: "Trust exactly this certificate, identified by its SHA-256 fingerprint. Works with SoftEther's default self-signed certificate. If the certificate changes, connections fail until you re-pin." },
  { value: "ca", label: "Verify against a CA", description: "Validate the certificate chain against a CA certificate you supply (PEM). Use when the server has a certificate from your internal PKI or a public CA." },
  { value: "insecure", label: "No verification (insecure)", description: "Accept any certificate. Anyone able to intercept traffic can impersonate the server and capture the administrator password." },
];

/** Short form "AB:CD:EF…12:34" of a colon-separated fingerprint. */
export function shortFp(fp: string | null | undefined): string {
  if (!fp) return "–";
  const parts = fp.split(":");
  return parts.length <= 6 ? fp : `${parts.slice(0, 4).join(":")}…${parts.slice(-2).join(":")}`;
}

export function normFp(fp: string | null | undefined): string {
  return (fp ?? "").replace(/[^0-9a-f]/gi, "").toUpperCase();
}

/** Connection error details from an ApiError returned by /test, /probe or the gateway. */
export function connectionError(e: unknown): { kind?: string; presentedFingerprint?: string } {
  if (!(e instanceof ApiError)) return {};
  return {
    kind: typeof e.body.connection === "string" ? e.body.connection : undefined,
    presentedFingerprint: typeof e.body.presentedFingerprint === "string" ? e.body.presentedFingerprint : undefined,
  };
}

/** Detect a pinned-certificate mismatch recorded by the poller in server state. */
export function stateMismatch(s: Server): string | null {
  const m = s.state?.error?.match(/fingerprint ([0-9A-F:]{20,}) does not match the pinned fingerprint/i);
  return m ? m[1] : null;
}

const KIND_HELP: Record<string, string> = {
  "tls-mismatch": "The server presented a different certificate than the pinned one. This happens after the server certificate was regenerated or replaced — or when someone is intercepting the connection. Verify the new fingerprint out-of-band before trusting it.",
  tls: "TLS verification failed. In CA mode, check that the supplied CA certificate issued the server's certificate and that the host name matches.",
  network: "The management server could not open a TCP connection. Check host, port, firewalls and that the SoftEther listener is enabled.",
  timeout: "The server did not respond in time.",
  auth: "The server rejected the administrator password (or hub name in hub-admin mode).",
  http: "The server returned an unexpected HTTP response; is this a SoftEther VPN Server listener?",
  protocol: "The server response was not valid JSON-RPC.",
};

export function ConnectionErrorAlert({ error, onTrust }: { error: unknown; onTrust?: (fp: string) => void }) {
  const { kind, presentedFingerprint } = connectionError(error);
  if (!kind) return <ErrorAlert error={error} />;
  return (
    <Alert color={kind === "tls-mismatch" ? "orange" : "red"} icon={<IconAlertTriangle size={18} />} title={kind === "tls-mismatch" ? "Certificate fingerprint mismatch" : "Connection failed"} my="sm" data-testid="connection-error">
      <Stack gap={6}>
        <Text size="sm">{(error as Error).message}</Text>
        {KIND_HELP[kind] && <Text size="xs" c="dimmed">{KIND_HELP[kind]}</Text>}
        {presentedFingerprint && (
          <Group gap="xs" wrap="nowrap">
            <Text size="xs" fw={600}>Presented:</Text>
            <Copyable value={presentedFingerprint} />
          </Group>
        )}
        {presentedFingerprint && onTrust && (
          <Text size="sm"><Text span c="blue" style={{ cursor: "pointer", textDecoration: "underline" }} onClick={() => onTrust(presentedFingerprint)} data-testid="trust-presented">Trust the presented certificate (re-pin)</Text></Text>
        )}
      </Stack>
    </Alert>
  );
}

export function CertDetails({ probe, pinned }: { probe: ProbeResult; pinned?: string | null }) {
  const from = dayjs(probe.validFrom), to = dayjs(probe.validTo);
  const now = dayjs();
  const expired = to.isValid() && to.isBefore(now);
  const notYet = from.isValid() && from.isAfter(now);
  const soon = !expired && to.isValid() && to.diff(now, "day") < 30;
  const matches = pinned ? normFp(pinned) === normFp(probe.fingerprint) : undefined;
  return (
    <Stack gap="xs" data-testid="cert-details">
      <KeyValue rows={[
        ["Subject", <Text size="sm" style={{ wordBreak: "break-all" }}>{probe.subject || "–"}</Text>],
        ["Issuer", <Group gap={6}><Text size="sm" style={{ wordBreak: "break-all" }}>{probe.issuer || "–"}</Text>{probe.selfSigned && <Badge size="xs" color="gray" variant="light">self-signed</Badge>}</Group>],
        ["Valid from", from.isValid() ? from.format("YYYY-MM-DD HH:mm") : probe.validFrom],
        ["Valid until", <Group gap={6}>{to.isValid() ? to.format("YYYY-MM-DD HH:mm") : probe.validTo}
          {expired && <Badge size="xs" color="red">expired</Badge>}{notYet && <Badge size="xs" color="red">not yet valid</Badge>}{soon && <Badge size="xs" color="orange">expires soon</Badge>}</Group>],
        ["SHA-256 fingerprint", <Copyable value={probe.fingerprint} />],
        ...(pinned !== undefined ? [["Currently pinned", pinned ? (
          <Group gap={6}><Text size="sm" ff="monospace">{shortFp(pinned)}</Text>
            {matches ? <Badge size="xs" color="green" leftSection={<IconShieldCheck size={10} />}>matches</Badge> : <Badge size="xs" color="orange">different</Badge>}</Group>
        ) : "none"] as [string, React.ReactNode]] : []),
      ]} />
    </Stack>
  );
}
