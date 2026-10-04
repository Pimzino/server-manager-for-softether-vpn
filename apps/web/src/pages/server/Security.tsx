import { useState } from "react";
import { Alert, Button, Checkbox, Group, List, PasswordInput, Progress, Stack, Stepper, Text, TextInput } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconLock, IconRefresh, IconX } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { PageHeader, ReadOnlyNotice, Section } from "../../components/common";
import { useServerAccess } from "../../components/server-b/ui";
import { post, put, rpc } from "../../lib/api";
import { notifyError, useScope } from "../../lib/hooks";
import type { Server } from "../../lib/types";

function strength(pw: string): { score: number; label: string; color: string } {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (pw.length >= 16) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  const pct = Math.min(100, Math.round((s / 6) * 100));
  if (pct < 40) return { score: pct, label: "Weak", color: "red" };
  if (pct < 70) return { score: pct, label: "Fair", color: "orange" };
  if (pct < 90) return { score: pct, label: "Good", color: "yellow" };
  return { score: pct, label: "Strong", color: "green" };
}

function generatePassword(len = 20) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%+-=?@_";
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join("");
}

type StepState = "idle" | "running" | "ok" | "error";

function ChangePasswordFlow({ server }: { server: Server }) {
  const qc = useQueryClient();
  const [active, setActive] = useState(0);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState("");
  const [serverStep, setServerStep] = useState<StepState>("idle");
  const [managerStep, setManagerStep] = useState<StepState>("idle");
  const [verifyStep, setVerifyStep] = useState<StepState>("idle");
  const [error, setError] = useState<string | null>(null);

  const st = strength(pw);
  const pwError = pw && pw.length < 8 ? "Use at least 8 characters" : undefined;
  const mismatch = pw2 && pw !== pw2 ? "Passwords do not match" : undefined;
  const step1Ok = pw.length >= 8 && pw === pw2 && ack;

  const updateManager = async () => {
    setManagerStep("running");
    try {
      await put(`/api/servers/${server.id}`, { password: pw });
      setManagerStep("ok");
    } catch (e) {
      setManagerStep("error");
      throw e;
    }
  };

  const verify = async () => {
    setVerifyStep("running");
    try {
      const s = await post<Server>(`/api/servers/${server.id}/refresh`);
      if (s.state?.ok) setVerifyStep("ok");
      else { setVerifyStep("error"); setError(s.state?.error ?? "The manager could not connect with the new password"); }
    } catch (e) {
      setVerifyStep("error");
      setError(e instanceof Error ? e.message : String(e));
    }
    void qc.invalidateQueries({ queryKey: ["server", server.id] });
    void qc.invalidateQueries({ queryKey: ["servers"] });
    void qc.invalidateQueries({ queryKey: ["rpc", server.id] });
  };

  const run = async () => {
    setError(null);
    setActive(2);
    // Step 1: change on the VPN server
    setServerStep("running");
    try {
      await rpc(server.id, "SetServerPassword", { PlainTextPassword_str: pw });
      setServerStep("ok");
    } catch (e) {
      setServerStep("error");
      setError(`The server password was NOT changed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // Step 2: update the manager's stored credential
    try {
      await updateManager();
    } catch (e) {
      setError(`The VPN Server password HAS been changed, but the manager could not store it: ${e instanceof Error ? e.message : String(e)}. Retry below — until then the manager cannot reach this server.`);
      return;
    }
    await verify();
    notifications.show({ color: "green", message: "Administrator password changed and manager updated" });
  };

  const retryManager = async () => {
    setError(null);
    try { await updateManager(); await verify(); } catch (e) { notifyError(e, "Update manager credential"); setError(`Still failing: ${e instanceof Error ? e.message : String(e)}`); }
  };

  const reset = () => { setActive(0); setPw(""); setPw2(""); setAck(false); setTyped(""); setServerStep("idle"); setManagerStep("idle"); setVerifyStep("idle"); setError(null); };

  const icon = (s: StepState) => s === "ok" ? <IconCheck size={16} color="var(--mantine-color-green-6)" /> : s === "error" ? <IconX size={16} color="var(--mantine-color-red-6)" /> : undefined;

  return (
    <Stepper active={active} allowNextStepsSelect={false} onStepClick={(i) => { if (serverStep === "idle" && i < active) setActive(i); }}>
      <Stepper.Step label="New password" description="Choose and confirm">
        <Stack mt="md" maw={560}>
          <PasswordInput label="New administrator password" value={pw} onChange={(e) => setPw(e.currentTarget.value)} autoComplete="new-password" error={pwError} data-autofocus data-testid="new-password" />
          {pw && (
            <Group gap="xs">
              <Progress value={st.score} color={st.color} w={200} size="sm" />
              <Text size="xs" c="dimmed">{st.label}</Text>
            </Group>
          )}
          <PasswordInput label="Confirm new password" value={pw2} onChange={(e) => setPw2(e.currentTarget.value)} autoComplete="new-password" error={mismatch} data-testid="confirm-password" />
          <Group>
            <Button variant="subtle" size="xs" leftSection={<IconRefresh size={14} />} onClick={() => { const g = generatePassword(); setPw(g); setPw2(g); }}>Generate a strong password</Button>
          </Group>
          <Text size="xs" c="dimmed">Store the new password in your password manager before continuing — the VPN Server cannot recover it.</Text>
          <Checkbox checked={ack} onChange={(e) => setAck(e.currentTarget.checked)} data-testid="ack-password"
            label="I understand that vpncmd, the SoftEther Server Manager and any other tool using the current password will need the new one." />
          <Group justify="flex-end"><Button disabled={!step1Ok} onClick={() => setActive(1)} data-testid="password-next">Continue</Button></Group>
        </Stack>
      </Stepper.Step>
      <Stepper.Step label="Confirm" description="Review the impact">
        <Stack mt="md" maw={640}>
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="This changes the VPN Server administrator password">
            <List size="sm" spacing={4}>
              <List.Item>The password of <b>{server.name}</b> ({server.host}:{server.port}) is replaced immediately.</List.Item>
              <List.Item>Other administration sessions (vpncmd, Server Manager, scripts, other management tools) will need the new password on their next connection.</List.Item>
              <List.Item>If this server is a cluster controller, cluster members use this password to join; update their member password too.</List.Item>
              <List.Item>The manager then stores the new password for this server and verifies that it can connect.</List.Item>
            </List>
          </Alert>
          <TextInput label={<>Type the server name <b>{server.name}</b> to confirm</>} value={typed} onChange={(e) => setTyped(e.currentTarget.value)} data-testid="password-type-confirm" />
          <Group justify="space-between">
            <Button variant="default" onClick={() => setActive(0)}>Back</Button>
            <Button color="red" leftSection={<IconLock size={16} />} disabled={typed !== server.name} onClick={run} data-testid="change-password">
              Change password on server and update manager
            </Button>
          </Group>
        </Stack>
      </Stepper.Step>
      <Stepper.Step label="Apply" description="Server, manager, verify">
        <Stack mt="md" maw={640} data-testid="password-progress">
          <Group gap="xs">{icon(serverStep) ?? <Text size="sm" c="dimmed">1.</Text>}<Text size="sm">Change the password on the VPN Server (SetServerPassword){serverStep === "running" && " …"}</Text></Group>
          <Group gap="xs">{icon(managerStep) ?? <Text size="sm" c="dimmed">2.</Text>}<Text size="sm">Store the new password in the manager{managerStep === "running" && " …"}</Text></Group>
          <Group gap="xs">{icon(verifyStep) ?? <Text size="sm" c="dimmed">3.</Text>}<Text size="sm">Verify the manager can connect{verifyStep === "running" && " …"}</Text></Group>
          {error && <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>{error}</Alert>}
          {serverStep === "ok" && managerStep === "error" && (
            <Group><Button color="red" onClick={retryManager} data-testid="retry-manager-update">Retry updating the manager</Button></Group>
          )}
          {verifyStep === "ok" && <Alert color="green" variant="light" icon={<IconCheck size={16} />}>Done. The manager is connected with the new password.</Alert>}
          {(verifyStep === "ok" || serverStep === "error" || verifyStep === "error") && <Group><Button variant="default" onClick={reset}>Start over</Button></Group>}
        </Stack>
      </Stepper.Step>
    </Stepper>
  );
}

/** Update only the manager's stored password (e.g. after the password was changed with vpncmd). */
function StoredCredential({ server }: { server: Server }) {
  const qc = useQueryClient();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const s = await put<Server>(`/api/servers/${server.id}`, { password: pw });
      await qc.invalidateQueries();
      setPw("");
      notifications.show({ color: s.state?.ok ? "green" : "orange", message: s.state?.ok ? "Stored password updated; connection OK" : `Stored password updated, but the connection failed: ${s.state?.error ?? "unknown error"}` });
    } catch (e) {
      notifyError(e, "Update stored password");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Manager's stored credential" description="Use this only if the administrator password was already changed outside the manager (e.g. with vpncmd). It does not change the password on the VPN Server.">
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Group align="flex-end">
          <PasswordInput label="Current VPN Server administrator password" value={pw} onChange={(e) => setPw(e.currentTarget.value)} autoComplete="off" w={360} data-testid="stored-password" />
          <Button type="submit" variant="light" loading={busy} disabled={!pw} data-testid="save-stored-password">Update stored password</Button>
        </Group>
      </form>
    </Section>
  );
}

export default function SecurityPage() {
  const { serverId } = useScope();
  const { server, role, isAdmin } = useServerAccess(serverId);
  const s = server.data;
  return (
    <>
      <PageHeader title="Administrator password" description="Change the VPN Server administrator password and keep the manager's stored credential in sync in a single guided flow." />
      {!isAdmin && <ReadOnlyNotice role={role} />}
      {s?.hub && (
        <Alert color="gray" variant="light" mb="md">
          The manager connects to this server in Virtual Hub admin mode ({s.hub}); the server administrator password cannot be changed from here.
        </Alert>
      )}
      {isAdmin && s && (
        <>
          <Section title="Change password on server and update manager" description="The password is changed on the VPN Server first; the manager's stored credential is updated right after, then the connection is verified.">
            <ChangePasswordFlow server={s} />
          </Section>
          <StoredCredential server={s} />
        </>
      )}
    </>
  );
}
