// Compares the certificate the server presents right now with the fingerprint this app trusts for the
// connection, and lets the user trust the new one (POST /api/servers/probe + PUT /api/servers/:id { fingerprint }).
// Used by the server certificate page after the certificate was replaced or regenerated.
import { useEffect, useState } from "react";
import { Button, Group } from "@mantine/core";
import { IconPin, IconRadar, IconShieldCheck, IconShieldExclamation } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { post, put } from "../../lib/api";
import { dt, normFp } from "../../lib/format";
import { notifyError, notifySuccess, useServer } from "../../lib/hooks";
import type { ProbeResult } from "../../lib/types";
import { confirmAction, FingerprintField, PropertyList, Tag } from "../../design";
import { Callout } from "./ui";

/** Node's "Sep 27 12:00:00 2026 GMT" (or ISO) as "2026-09-27 14:00:00" local time; the raw text when unparseable. */
const certDate = (v: string) => (Number.isNaN(new Date(v).getTime()) ? v : dt(new Date(v).toISOString()));

const MODE: Record<string, { label: string; color: "accent" | "teal" | "orange" }> = {
  pin: { label: "Trusted fingerprint", color: "accent" },
  ca: { label: "CA certificate", color: "teal" },
  insecure: { label: "Not verified", color: "orange" },
};

/**
 * `expectedFp`: the fingerprint of a certificate the user just installed; the panel then says whether the
 * server presents that one. `autoProbe` checks as soon as the connection is loaded.
 * Test ids: repin-panel, pinned-fp, probe-cert, presented-fp, repin-confirm (+ -confirm / -cancel on the dialog).
 */
export function RepinPanel({ serverId, expectedFp, autoProbe }: { serverId: number; expectedFp?: string | null; autoProbe?: boolean }) {
  const qc = useQueryClient();
  const server = useServer(serverId);
  const s = server.data;
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const doProbe = async () => {
    if (!s) return;
    setBusy(true);
    try {
      setProbe(await post<ProbeResult>("/api/servers/probe", { host: s.host, port: s.port }));
    } catch (e) {
      notifyError(e, "Couldn’t get the server’s certificate");
    } finally {
      setBusy(false);
    }
  };
  const ready = !!s;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (autoProbe && ready) void doProbe(); }, [autoProbe, ready]);

  if (!s) return null;
  const pinned = normFp(s.fingerprint);
  const presented = probe ? normFp(probe.fingerprint) : "";
  const matchesPin = !!probe && presented === pinned;
  const matchesExpected = expectedFp ? presented === normFp(expectedFp) : undefined;
  const mode = MODE[s.tlsMode] ?? { label: s.tlsMode, color: "orange" as const };

  const repin = async () => {
    const ok = await confirmAction({
      title: <>Trust this certificate for “{s.name}”?</>,
      message: "From now on this app connects to the server only when it presents this certificate. Compare the fingerprint with the one the server shows (vpncmd ServerCertGet) if you’re unsure.",
      details: <FingerprintField value={probe!.fingerprint} />,
      confirmLabel: "Trust Certificate",
      tone: matchesExpected === false ? "danger" : "warning",
      testId: "repin-confirm",
    });
    if (!ok) return;
    setSaving(true);
    try {
      await put(`/api/servers/${serverId}`, { fingerprint: probe!.fingerprint });
      notifySuccess("This app now trusts the new certificate.");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["server", serverId] }),
        qc.invalidateQueries({ queryKey: ["servers"] }),
        qc.invalidateQueries({ queryKey: ["rpc", serverId] }),
      ]);
    } catch (e) {
      notifyError(e, "Couldn’t update the trusted fingerprint");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sem-stack" data-testid="repin-panel">
      <PropertyList items={[
        { label: "Certificate check", value: <Tag color={mode.color}>{mode.label}</Tag> },
        {
          label: "Trusted fingerprint (SHA-256)",
          value: s.fingerprint ? <span data-testid="pinned-fp"><FingerprintField value={s.fingerprint} compare={probe ? probe.fingerprint : undefined} /></span> : <span className="sem-dim">None</span>,
        },
      ]} />
      {s.tlsMode === "ca" && (
        <Callout tone="gray">This app trusts the server through a CA certificate. A new server certificate must be issued by that CA and match the host name; otherwise change the connection’s certificate settings.</Callout>
      )}
      {s.tlsMode === "insecure" && (
        <Callout tone="yellow">This app doesn’t verify the server’s certificate. To protect the administrator password from interception, edit the connection and turn certificate checking on.</Callout>
      )}
      <Group>
        <Button variant="default" leftSection={<IconRadar size={14} />} loading={busy} onClick={doProbe} data-testid="probe-cert">
          Check Certificate on {s.host}:{s.port}
        </Button>
      </Group>
      {probe && (
        <Callout
          tone={matchesPin ? "green" : matchesExpected === false ? "red" : "yellow"}
          icon={matchesPin ? <IconShieldCheck size={16} stroke={1.7} /> : <IconShieldExclamation size={16} stroke={1.7} />}
          title={matchesPin ? "The server presents the trusted certificate" : "The server presents a different certificate"}
          testId="probe-result"
        >
          <div className="sem-stack" style={{ gap: "var(--sem-space-4)", marginTop: "var(--sem-space-3)" }}>
            <span data-testid="presented-fp"><FingerprintField value={probe.fingerprint} label="Presented fingerprint (SHA-256)" compare={expectedFp ?? undefined} /></span>
            <PropertyList dense labelWidth={110} items={[
              { label: "Subject", value: probe.subject },
              { label: "Issuer", value: <>{probe.issuer}{probe.selfSigned && <> <Tag>Self-signed</Tag></>}</> },
              { label: "Valid", value: `${certDate(probe.validFrom)} – ${certDate(probe.validTo)}` },
            ]} />
            {matchesExpected === true && !matchesPin && <div>This is the certificate you just installed.</div>}
            {matchesExpected === false && (
              <div className="sem-strong sem-text-red">
                This isn’t the certificate you just installed. Don’t trust it unless you know why: a proxy or an attacker could be presenting it.
              </div>
            )}
            {!matchesPin && s.tlsMode !== "ca" && (
              <Group>
                <Button color={matchesExpected === false ? "red" : undefined} leftSection={<IconPin size={14} />} loading={saving} onClick={repin} data-testid="repin-confirm">
                  Trust This Certificate…
                </Button>
              </Group>
            )}
          </div>
        </Callout>
      )}
    </div>
  );
}
