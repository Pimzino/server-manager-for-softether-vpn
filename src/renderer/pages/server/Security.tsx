// Server › Admin Password: change the VPN Server administrator password (SetServerPassword) and keep the password
// this app uses in sync (PUT /api/servers/:id { password }), then verify the connection. Also: update only the
// password this app uses, after it was changed elsewhere (vpncmd, Server Manager).
import { useState, type ReactNode } from "react";
import { Button, Checkbox, Group, PasswordInput } from "@mantine/core";
import { IconCheck, IconCircleDashed, IconKey, IconLoader2, IconRefresh, IconX } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { post, put, rpc } from "../../lib/api";
import { notifyError, notifySuccess } from "../../lib/hooks";
import { secretStore } from "../../lib/platform";
import type { Server } from "../../lib/types";
import { confirmAction, ErrorState, FormRow, FormSection, PageHeader, Sheet } from "../../design";
import { generatePassword } from "../../components/domain/util";
import { HubModeNotice, Unreachable, useServerPage } from "./_server-protocols-security/shared";

/** Password strength bar: unlike Meter (a usage gauge that turns red when full), green means good here. */
function StrengthBar({ score, label }: { score: number; label: string }) {
  const color = score < 40 ? "var(--sem-red-dot)" : score < 70 ? "var(--sem-orange-dot)" : score < 90 ? "var(--sem-yellow-dot)" : "var(--sem-green-dot)";
  return (
    <div className="sem-meter" data-testid="password-strength">
      <div className="sem-meter-head"><span className="sem-meter-label">Strength</span><span className="sem-meter-detail">{label}</span></div>
      <div className="sem-meter-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-label="Password strength">
        <div className="sem-meter-fill" style={{ width: `${Math.max(8, score)}%`, background: color }} />
      </div>
    </div>
  );
}

function strength(pw: string): { score: number; label: string } {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (pw.length >= 16) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  const pct = Math.min(100, Math.round((s / 6) * 100));
  return { score: pct, label: pct < 40 ? "Weak" : pct < 70 ? "Fair" : pct < 90 ? "Good" : "Strong" };
}

/** "saved in Keychain" / "saved (protected by Windows DPAPI)". */
const savedWhere = () => secretStore().saved.replace(/^Saved/, "saved");

type StepState = "idle" | "running" | "ok" | "error";

function Step({ state, children, testId }: { state: StepState; children: ReactNode; testId?: string }) {
  const icon = state === "ok" ? <IconCheck size={16} /> : state === "error" ? <IconX size={16} style={{ color: "var(--sem-red)" }} />
    : state === "running" ? <IconLoader2 size={16} className="sem-spin" /> : <IconCircleDashed size={16} />;
  return (
    <div className="sem-progress-row" data-state={state === "running" ? "active" : state === "ok" ? "done" : state === "error" ? "active" : undefined} data-testid={testId} data-step={state}>
      {icon}<span>{children}</span>
    </div>
  );
}

function ChangePassword({ server }: { server: Server }) {
  const qc = useQueryClient();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [ack, setAck] = useState(false);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<{ server: StepState; app: StepState; verify: StepState }>({ server: "idle", app: "idle", verify: "idle" });
  const [error, setError] = useState<string | null>(null);
  const st = strength(pw);
  const pwError = pw && pw.length < 8 ? "Use at least 8 characters." : undefined;
  const mismatch = pw2 && pw !== pw2 ? "The passwords don’t match." : undefined;
  const ready = pw.length >= 8 && pw === pw2 && ack;
  const where = server.passwordSaved ? savedWhere() : "entered for this session";

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ["server", server.id] });
    void qc.invalidateQueries({ queryKey: ["servers"] });
    void qc.invalidateQueries({ queryKey: ["rpc", server.id] });
  };
  const updateApp = async (password: string) => {
    setSteps((x) => ({ ...x, app: "running" }));
    try { await put(`/api/servers/${server.id}`, { password }); setSteps((x) => ({ ...x, app: "ok" })); } catch (e) { setSteps((x) => ({ ...x, app: "error" })); throw e; }
  };
  const verify = async () => {
    setSteps((x) => ({ ...x, verify: "running" }));
    try {
      const s = await post<Server>(`/api/servers/${server.id}/refresh`);
      if (s.state?.ok) setSteps((x) => ({ ...x, verify: "ok" }));
      else { setSteps((x) => ({ ...x, verify: "error" })); setError(s.state?.error ?? "This app couldn’t connect with the new password."); }
    } catch (e) {
      setSteps((x) => ({ ...x, verify: "error" }));
      setError(e instanceof Error ? e.message : String(e));
    }
    refreshAll();
  };

  const run = async () => {
    const ok = await confirmAction({
      title: <>Change the administrator password of “{server.name}”?</>,
      message: "The password changes on the VPN Server immediately. vpncmd, Server Manager, scripts and cluster members that use the current password need the new one on their next connection.",
      details: <div className="sem-dim">This app then uses the new password ({where}) and checks that it can connect.</div>,
      confirmLabel: "Change Password",
      typeToConfirm: server.name,
      typeLabel: <>To confirm, type the connection name <span className="sem-code-inline">{server.name}</span></>,
      testId: "change-password",
    });
    if (!ok) return;
    const password = pw;
    setError(null);
    setSteps({ server: "running", app: "idle", verify: "idle" });
    setRunning(true);
    try {
      await rpc(server.id, "SetServerPassword", { PlainTextPassword_str: password });
      setSteps((x) => ({ ...x, server: "ok" }));
    } catch (e) {
      setSteps((x) => ({ ...x, server: "error" }));
      setError(`The server password wasn’t changed. ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    try {
      await updateApp(password);
    } catch (e) {
      setError(`The VPN Server now has the new password, but this app couldn’t store it: ${e instanceof Error ? e.message : String(e)}. Try again below; until then this app can’t reach the server.`);
      return;
    }
    await verify();
    notifySuccess("Administrator password changed");
  };
  const retry = async () => {
    setError(null);
    try { await updateApp(pw); await verify(); } catch (e) { notifyError(e, "Couldn’t update the password in this app"); setError(`Still failing: ${e instanceof Error ? e.message : String(e)}`); }
  };
  // The sheet can always be left once nothing runs: a failed app update keeps its Retry button, but must not trap
  // the user (they may want to fix the connection elsewhere, e.g. with "Password used by this app" below).
  const finished = steps.verify === "ok" || steps.server === "error" || steps.verify === "error" || steps.app === "error";
  const close = () => {
    setRunning(false);
    if (steps.verify === "ok") { setPw(""); setPw2(""); setAck(false); }
    setSteps({ server: "idle", app: "idle", verify: "idle" });
  };

  return (
    <>
      <FormSection
        title="Change password"
        description="The password changes on the VPN Server first. This app then stores the new one and checks the connection."
        testId="change-password-form"
        footer={(
          <Group justify="flex-end">
            <Button color="red" leftSection={<IconKey size={14} />} disabled={!ready} onClick={() => void run()} data-testid="change-password">Change Password…</Button>
          </Group>
        )}
      >
        <FormRow label="New password" align="start" error={pwError}
          description={pw ? undefined : "At least 8 characters. Store it in a password manager: the server can’t recover it."}>
          {(id) => (
            <div className="sem-stack" style={{ gap: "var(--sem-space-3)", width: 300 }}>
              <Group gap={8} wrap="nowrap">
                <PasswordInput id={id} style={{ flex: 1 }} value={pw} onChange={(e) => setPw(e.currentTarget.value)} autoComplete="new-password" error={!!pwError} data-autofocus data-testid="new-password" />
                <Button variant="default" leftSection={<IconRefresh size={13} />} onClick={() => { const g = generatePassword(20); setPw(g); setPw2(g); }} data-testid="generate-password">Generate</Button>
              </Group>
              {pw && <StrengthBar score={st.score} label={st.label} />}
            </div>
          )}
        </FormRow>
        <FormRow label="Confirm password" error={mismatch}>
          {(id) => <PasswordInput id={id} w={300} value={pw2} onChange={(e) => setPw2(e.currentTarget.value)} autoComplete="new-password" error={!!mismatch} data-testid="confirm-password" />}
        </FormRow>
        <FormRow label="Other tools" align="start">
          <Checkbox checked={ack} onChange={(e) => setAck(e.currentTarget.checked)} data-testid="ack-password" maw={420}
            label="I understand that vpncmd, Server Manager and other tools that use the current password will need the new one." />
        </FormRow>
      </FormSection>

      <Sheet opened={running} onClose={close} busy={!finished} title="Changing the Administrator Password" subtitle={server.name}
        icon={<IconKey size={19} stroke={1.5} />} testId="password-sheet"
        footer={(
          <Group justify="flex-end" gap={8}>
            {steps.server === "ok" && steps.app === "error" && <Button color="red" onClick={() => void retry()} data-testid="retry-manager-update">Store Password Again</Button>}
            <Button variant={steps.verify === "ok" ? "filled" : "default"} disabled={!finished} onClick={close} data-testid="password-done">{steps.verify === "ok" ? "Done" : "Close"}</Button>
          </Group>
        )}
      >
        <div className="sem-progress" data-testid="password-progress" style={{ padding: "var(--sem-space-4) 0" }}>
          <Step state={steps.server} testId="step-server">Change the password on the VPN Server</Step>
          <Step state={steps.app} testId="step-app">Store the new password in this app</Step>
          <Step state={steps.verify} testId="step-verify">Check that this app can connect</Step>
        </div>
        {error && <ErrorState error={new Error(error)} inline testId="password-error" />}
        {steps.verify === "ok" && <div className="sem-dim" data-testid="password-success">Done. This app is connected with the new password.</div>}
      </Sheet>
    </>
  );
}

/** Update only the password this app uses (after it was changed with vpncmd or Server Manager). */
function AppPassword({ server }: { server: Server }) {
  const hub = server.hub;
  const qc = useQueryClient();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const s = await put<Server>(`/api/servers/${server.id}`, { password: pw });
      await qc.invalidateQueries();
      setPw("");
      if (s.state?.ok) notifySuccess("This app now uses the new password. Connected.");
      else notifyError(new Error(s.state?.error ?? "Unknown error"), "Password updated, but the connection failed");
    } catch (e) {
      notifyError(e, "Couldn’t update the password");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (pw) void save(); }}>
      <FormSection
        title="Password used by this app"
        description={hub
          ? <>Only when the administrator password of the Virtual Hub “{hub}” was already changed elsewhere. This doesn’t change the password on the server.</>
          : "Only when the password was already changed elsewhere, for example with vpncmd. This doesn’t change the password on the server."}
        testId="app-password-form"
      >
        <FormRow label={hub ? "Current hub password" : "Current server password"} description={server.passwordSaved ? `Replaces the password ${savedWhere()}.` : "Replaces the password entered for this session."}>
          {(id) => (
            <Group gap={8} wrap="nowrap">
              <PasswordInput id={id} w={300} value={pw} onChange={(e) => setPw(e.currentTarget.value)} autoComplete="off" data-testid="stored-password" />
              <Button type="submit" variant="default" loading={busy} disabled={!pw} data-testid="save-stored-password">Update</Button>
            </Group>
          )}
        </FormRow>
      </FormSection>
    </form>
  );
}

export default function SecurityPage() {
  const { serverId, s, reachable, hubMode } = useServerPage();
  if (!s) return null;
  return (
    <>
      <PageHeader title="Admin Password" description="Change the VPN Server’s administrator password and keep the password this app uses in sync." />
      {hubMode && <HubModeNotice hub={s.hub!} what="the server administrator password can’t be changed from here." />}
      {!hubMode && !reachable && <Unreachable serverId={serverId} name={s.name} error={s.state?.error} checkedAt={s.state?.checkedAt} />}
      {!hubMode && reachable && <ChangePassword server={s} />}
      <AppPassword server={s} />
    </>
  );
}
