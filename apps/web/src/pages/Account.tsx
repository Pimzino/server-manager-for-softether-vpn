import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Badge, Button, Code, Group, Modal, NumberInput, PasswordInput, PinInput, Select, SimpleGrid, Stack, Stepper, Text, TextInput, Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconKey, IconLogout, IconPlus, IconShieldCheck, IconShieldOff, IconTrash } from "@tabler/icons-react";
import { DataTable } from "../components/DataTable";
import { ConfirmButton, Copyable, KeyValue, PageHeader, QueryState, Section } from "../components/common";
import { QrCode } from "../components/account/QrCode";
import { del, get, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { notifyError } from "../lib/hooks";
import { ago, dt } from "../lib/format";

interface MySession { id: string; createdAt: number; lastSeenAt: number; ip: string; userAgent: string; current: boolean }
interface MyToken { id: number; name: string; prefix: string; createdAt: number; expiresAt: number | null; lastUsedAt: number | null }

function describeUA(ua: string): string {
  if (!ua) return "Unknown client";
  if (/^curl\//i.test(ua)) return ua.split(" ")[0];
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : ua.split(/[ /]/)[0];
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

// ---------------------------------------------------------------- Password
function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const qc = useQueryClient();
  const change = useMutation({
    mutationFn: () => post("/api/auth/password", { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent(""); setNext(""); setConfirm("");
      void qc.invalidateQueries({ queryKey: ["me-sessions"] });
      notifications.show({ color: "green", title: "Password changed", message: "All your other sessions were signed out." });
    },
    onError: (e) => notifyError(e, "Password not changed"),
  });
  const mismatch = confirm.length > 0 && confirm !== next;
  const same = next.length > 0 && next === current;
  return (
    <Section title="Password" description="Changing your password signs out every other session. The password policy is set by administrators (minimum length and character classes; must not contain your username).">
      <form onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
        <Stack maw={420} data-testid="change-password-form">
          <PasswordInput label="Current password" required value={current} onChange={(e) => setCurrent(e.currentTarget.value)} autoComplete="current-password" />
          <PasswordInput label="New password" required value={next} onChange={(e) => setNext(e.currentTarget.value)} autoComplete="new-password"
            error={same ? "Must differ from the current password" : undefined} />
          <PasswordInput label="Confirm new password" required value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} autoComplete="new-password"
            error={mismatch ? "Passwords do not match" : undefined} />
          <Group><Button type="submit" loading={change.isPending} disabled={!current || !next || mismatch || same || confirm !== next} data-testid="change-password">Change password</Button></Group>
        </Stack>
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------- MFA
function MfaSetupModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { refresh, user } = useAuth();
  const [step, setStep] = useState(0);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [currentCode, setCurrentCode] = useState("");
  const setup = useMutation<{ secret: string; uri: string }, Error, void>({ mutationFn: () => post("/api/auth/mfa/setup") });
  const enable = useMutation({
    // The pending secret is held server-side on this session; re-authentication is required.
    mutationFn: () => post("/api/auth/mfa/enable", { code, password, ...(user?.mfaEnabled ? { currentCode } : {}) }),
    onSuccess: async () => {
      await refresh();
      notifications.show({ color: "green", title: "Two-factor authentication enabled", message: "You will be asked for a code at every sign-in." });
      close();
    },
    onError: (e) => { setCode(""); notifyError(e, "Code rejected"); },
  });
  const close = () => { onClose(); setTimeout(() => { setStep(0); setCode(""); setPassword(""); setCurrentCode(""); setup.reset(); enable.reset(); }, 200); };
  useEffect(() => { if (opened && setup.isIdle) setup.mutate(); }, [opened, setup.isIdle]);
  const secretGrouped = setup.data?.secret.replace(/(.{4})/g, "$1 ").trim();
  return (
    <Modal opened={opened} onClose={close} title="Set up two-factor authentication" size="lg" centered closeOnClickOutside={false}>
      <Stepper active={step} size="sm" onStepClick={(i) => i < step && setStep(i)}>
        <Stepper.Step label="Scan" description="Add to authenticator">
          <QueryState query={{ isLoading: setup.isPending, error: setup.error }}>
            {setup.data && (
              <Stack mt="md" data-testid="mfa-setup">
                <Text size="sm">Scan this QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…). If you cannot scan it, enter the secret key manually (time-based, SHA-1, 6 digits, 30 s).</Text>
                <Group align="flex-start" wrap="wrap" gap="lg">
                  <QrCode value={setup.data.uri} size={200} label="Authenticator enrolment QR code" />
                  <Stack gap="xs" style={{ flex: 1, minWidth: 240 }}>
                    <div>
                      <Text size="xs" c="dimmed" fw={600}>SECRET KEY</Text>
                      <Copyable value={setup.data.secret} />
                      <Text size="xs" c="dimmed" ff="monospace" mt={2}>{secretGrouped}</Text>
                    </div>
                    <div>
                      <Text size="xs" c="dimmed" fw={600}>OTPAUTH URI</Text>
                      <Copyable value={setup.data.uri} />
                    </div>
                  </Stack>
                </Group>
                <Group justify="flex-end"><Button onClick={() => setStep(1)} data-testid="mfa-next">I've added it</Button></Group>
              </Stack>
            )}
          </QueryState>
        </Stepper.Step>
        <Stepper.Step label="Verify" description="Enter a code">
          <form onSubmit={(e) => { e.preventDefault(); enable.mutate(); }}>
            <Stack mt="md" align="center">
              <Text size="sm">Enter the 6-digit code currently shown by your authenticator app.</Text>
              <PinInput length={6} type="number" oneTimeCode value={code} onChange={setCode} autoFocus data-testid="mfa-code"
                onComplete={() => undefined} error={!!enable.error} aria-label="Authentication code" />
              <PasswordInput label="Your current password" description="Required to change sign-in security" value={password}
                onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" w={320} data-testid="mfa-password" />
              {user?.mfaEnabled && (
                <TextInput label="Code from your existing authenticator" description="Required to replace an existing enrolment" value={currentCode}
                  onChange={(e) => setCurrentCode(e.currentTarget.value.replace(/\D/g, "").slice(0, 6))} w={320} data-testid="mfa-current-code" />
              )}
              <Group><Button variant="default" onClick={() => setStep(0)}>Back</Button>
                <Button type="submit" disabled={code.length !== 6 || !password || (!!user?.mfaEnabled && currentCode.length !== 6)} loading={enable.isPending} data-testid="mfa-enable">Enable two-factor authentication</Button></Group>
            </Stack>
          </form>
        </Stepper.Step>
      </Stepper>
    </Modal>
  );
}

function MfaSection() {
  const { user, refresh } = useAuth();
  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [password, setPassword] = useState("");
  const disable = useMutation({
    mutationFn: () => post("/api/auth/mfa/disable", { password }),
    onSuccess: async () => {
      await refresh();
      setDisableOpen(false); setPassword("");
      notifications.show({ color: "orange", message: "Two-factor authentication disabled" });
    },
    onError: (e) => notifyError(e, "Could not disable MFA"),
  });
  return (
    <Section
      title="Two-factor authentication"
      description="Protect your account with a time-based one-time password (TOTP) from an authenticator app, in addition to your password."
      actions={user?.mfaEnabled
        ? <Badge color="green" size="lg" variant="light" leftSection={<IconShieldCheck size={14} />} data-testid="mfa-status">Enabled</Badge>
        : <Badge color="gray" size="lg" variant="light" leftSection={<IconShieldOff size={14} />} data-testid="mfa-status">Not enabled</Badge>}
    >
      {user?.mfaEnabled ? (
        <Group>
          <Text size="sm" c="dimmed">A code from your authenticator is required at every sign-in.</Text>
          <Button color="red" variant="light" onClick={() => setDisableOpen(true)} data-testid="mfa-disable-open">Disable</Button>
        </Group>
      ) : (
        <Group>
          <Button leftSection={<IconShieldCheck size={16} />} onClick={() => setSetupOpen(true)} data-testid="mfa-setup-open">Set up two-factor authentication</Button>
        </Group>
      )}
      <MfaSetupModal opened={setupOpen} onClose={() => setSetupOpen(false)} />
      <Modal opened={disableOpen} onClose={() => setDisableOpen(false)} title="Disable two-factor authentication" centered>
        <form onSubmit={(e) => { e.preventDefault(); disable.mutate(); }}>
          <Stack>
            <Alert color="orange" icon={<IconAlertTriangle size={16} />}>Your account will be protected by your password only.</Alert>
            <PasswordInput label="Confirm with your password" required value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" data-autofocus />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setDisableOpen(false)}>Cancel</Button>
              <Button type="submit" color="red" disabled={!password} loading={disable.isPending} data-testid="mfa-disable">Disable</Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Section>
  );
}

// ---------------------------------------------------------------- API tokens
const EXPIRY = [
  { value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "365", label: "1 year" },
  { value: "custom", label: "Custom…" }, { value: "never", label: "Never expires" },
];

function TokensSection() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ["me-tokens"], queryFn: () => get<MyToken[]>("/api/me/tokens") });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("90");
  const [customDays, setCustomDays] = useState<number>(30);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const create = useMutation({
    mutationFn: () => post<{ id: number; token: string }>("/api/me/tokens", {
      name: name.trim(), expiresInDays: expiry === "never" ? null : expiry === "custom" ? customDays : Number(expiry),
    }),
    onSuccess: (r) => {
      setCreated({ name: name.trim(), token: r.token });
      setOpen(false); setName(""); setExpiry("90");
      void qc.invalidateQueries({ queryKey: ["me-tokens"] });
    },
    onError: (e) => notifyError(e, "Could not create token"),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => del(`/api/me/tokens/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["me-tokens"] }); notifications.show({ color: "green", message: "Token revoked" }); },
    onError: (e) => notifyError(e, "Could not revoke token"),
  });
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <Section
      title="API tokens"
      description="Personal tokens for scripts, CI and monitoring (e.g. Prometheus scraping /metrics). A token acts with your permissions; send it as “Authorization: Bearer <token>”. Tokens cannot create other tokens."
      actions={<Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setOpen(true)} data-testid="create-token">New token</Button>}
    >
      <QueryState query={tokens}>
        <DataTable
          testId="tokens-table"
          data={tokens.data}
          rowKey={(t) => t.id}
          searchable={false}
          empty="You have no API tokens"
          initialSort={{ key: "createdAt", dir: "desc" }}
          columns={[
            { key: "name", title: "Name", render: (t) => <Text fw={600} size="sm">{t.name}</Text> },
            { key: "prefix", title: "Token", render: (t) => <Code>{t.prefix}…</Code> },
            { key: "createdAt", title: "Created", render: (t) => <Tooltip label={dt(t.createdAt)}><Text size="sm">{ago(t.createdAt)}</Text></Tooltip> },
            { key: "lastUsedAt", title: "Last used", value: (t) => t.lastUsedAt ?? 0, render: (t) => <Text size="sm">{t.lastUsedAt ? ago(t.lastUsedAt) : "Never"}</Text> },
            {
              key: "expiresAt", title: "Expires", value: (t) => t.expiresAt ?? Number.MAX_SAFE_INTEGER,
              render: (t) => !t.expiresAt ? <Text size="sm" c="dimmed">Never</Text>
                : t.expiresAt < Date.now() ? <Badge color="red" variant="light">Expired {ago(t.expiresAt)}</Badge>
                : <Tooltip label={dt(t.expiresAt)}><Text size="sm">{ago(t.expiresAt)}</Text></Tooltip>,
            },
            {
              key: "actions", title: "", sortable: false, align: "right",
              render: (t) => (
                <ConfirmButton title={`Revoke token “${t.name}”?`} message="Anything using this token will immediately lose access. This cannot be undone."
                  confirmLabel="Revoke" onConfirm={() => revoke.mutateAsync(t.id)} leftSection={<IconTrash size={14} />}>Revoke</ConfirmButton>
              ),
            },
          ]}
        />
      </QueryState>

      <Modal opened={open} onClose={() => setOpen(false)} title="New API token" centered>
        <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Stack>
            <TextInput label="Name" required description="What will use it, e.g. “prometheus” or “ci-deploy”" value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={100} data-autofocus data-testid="token-name" />
            <Select label="Expiration" data={EXPIRY} value={expiry} onChange={(v) => setExpiry(v ?? "90")} allowDeselect={false} />
            {expiry === "custom" && <NumberInput label="Days until expiry" min={1} max={3650} value={customDays} onChange={(v) => setCustomDays(Number(v) || 1)} allowDecimal={false} />}
            {expiry === "never" && <Text size="xs" c="orange">Non-expiring tokens are convenient but risky; revoke them when no longer needed.</Text>}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" loading={create.isPending} disabled={!name.trim() || (expiry === "custom" && (customDays < 1 || customDays > 3650))} data-testid="token-create-submit">Create token</Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <Modal opened={!!created} onClose={() => setCreated(null)} title="Token created" size="lg" centered closeOnClickOutside={false}>
        {created && (
          <Stack data-testid="token-created">
            <Alert color="orange" icon={<IconKey size={16} />}>Copy the token for <b>{created.name}</b> now. It is shown only once and cannot be retrieved later.</Alert>
            <Copyable value={created.token} />
            <Text size="sm" fw={600}>Example</Text>
            <Code block>{`curl -H "Authorization: Bearer ${created.token}" ${origin}/api/servers\ncurl -H "Authorization: Bearer ${created.token}" ${origin}/metrics`}</Code>
            <Group justify="flex-end"><Button onClick={() => setCreated(null)} data-testid="token-done">I've copied it</Button></Group>
          </Stack>
        )}
      </Modal>
    </Section>
  );
}

// ---------------------------------------------------------------- Sessions
function SessionsSection() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["me-sessions"], queryFn: () => get<MySession[]>("/api/me/sessions"), refetchInterval: 60_000 });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/api/me/sessions/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["me-sessions"] }),
    onError: (e) => notifyError(e, "Could not sign out session"),
  });
  const others = (sessions.data ?? []).filter((s) => !s.current);
  const revokeOthers = async () => {
    await Promise.all(others.map((s) => del(`/api/me/sessions/${s.id}`)));
    await qc.invalidateQueries({ queryKey: ["me-sessions"] });
    notifications.show({ color: "green", message: `Signed out ${others.length} other session(s)` });
  };
  return (
    <Section
      title="Active sessions"
      description="Browsers and clients currently signed in to your account. Sign out any session you don't recognise and change your password."
      actions={others.length > 0 && (
        <ConfirmButton title="Sign out all other sessions?" message={`${others.length} other session(s) will be signed out immediately.`} confirmLabel="Sign out others"
          onConfirm={revokeOthers} leftSection={<IconLogout size={14} />}>Sign out all others</ConfirmButton>
      )}
    >
      <QueryState query={sessions}>
        <DataTable
          testId="sessions-table"
          data={sessions.data}
          rowKey={(s) => s.id}
          searchable={false}
          initialSort={{ key: "lastSeenAt", dir: "desc" }}
          columns={[
            { key: "client", title: "Client", value: (s) => describeUA(s.userAgent), render: (s) => (
              <Group gap={6}><Tooltip label={s.userAgent || "–"} multiline w={360}><Text size="sm" fw={500}>{describeUA(s.userAgent)}</Text></Tooltip>{s.current && <Badge size="xs" color="green">This session</Badge>}</Group>
            ) },
            { key: "ip", title: "IP address", render: (s) => <Text size="sm" ff="monospace">{s.ip}</Text> },
            { key: "createdAt", title: "Signed in", render: (s) => <Tooltip label={dt(s.createdAt)}><Text size="sm">{ago(s.createdAt)}</Text></Tooltip> },
            { key: "lastSeenAt", title: "Last active", render: (s) => <Tooltip label={dt(s.lastSeenAt)}><Text size="sm">{ago(s.lastSeenAt)}</Text></Tooltip> },
            {
              key: "actions", title: "", sortable: false, align: "right",
              render: (s) => s.current ? null : (
                <Button size="xs" variant="light" color="red" onClick={() => revoke.mutate(s.id)} loading={revoke.isPending && revoke.variables === s.id} data-testid={`session-revoke-${s.id}`}>Sign out</Button>
              ),
            },
          ]}
        />
      </QueryState>
    </Section>
  );
}

export default function AccountPage() {
  const { user } = useAuth();
  return (
    <>
      <PageHeader title="My account" description="Your profile, sign-in security, API tokens and active sessions." />
      <Section title="Profile" description="Contact an administrator to change your role, display name or e-mail address.">
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <KeyValue rows={[
            ["Username", <Text size="sm" fw={600}>{user?.username}</Text>],
            ["Display name", user?.displayName || "–"],
            ["E-mail", user?.email || "–"],
          ]} />
          <KeyValue rows={[
            ["Global role", <Badge variant="light">{user?.role}</Badge>],
            ["Last sign-in", dt(user?.lastLoginAt)],
            ["Account created", dt(user?.createdAt)],
          ]} />
        </SimpleGrid>
      </Section>
      <PasswordSection />
      <MfaSection />
      <TokensSection />
      <SessionsSection />
    </>
  );
}
