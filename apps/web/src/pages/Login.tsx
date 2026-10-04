import { useEffect, useState } from "react";
import { Alert, Button, Card, Center, PasswordInput, PinInput, Stack, Text, TextInput, Title, Group } from "@mantine/core";
import { IconShieldLock } from "@tabler/icons-react";
import { ApiError, get, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { User } from "../lib/types";

export function LoginPage() {
  const { setUser } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [mfa, setMfa] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState("");

  useEffect(() => { get<{ loginBanner: string }>("/api/auth/banner").then((r) => setBanner(r.loginBanner)).catch(() => undefined); }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!mfa) {
        const r = await post<{ user?: User; mfaRequired?: boolean }>("/api/auth/login", { username, password });
        if (r.mfaRequired) setMfa(true);
        else if (r.user) setUser(r.user);
      } else {
        const r = await post<{ user: User }>("/api/auth/mfa", { code });
        setUser(r.user);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      if (mfa) setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center mih="100vh" bg="var(--mantine-color-gray-light)">
      <Card withBorder shadow="sm" radius="md" p="xl" w={400}>
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Stack>
            <Group gap="xs">
              <IconShieldLock size={30} color="var(--mantine-color-blue-6)" />
              <div>
                <Title order={3}>SoftEther Manager</Title>
                <Text size="xs" c="dimmed">VPN fleet administration</Text>
              </div>
            </Group>
            {banner && <Alert color="blue" variant="light"><Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{banner}</Text></Alert>}
            {error && <Alert color="red" data-testid="login-error">{error}</Alert>}
            {!mfa ? (
              <>
                <TextInput label="Username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} autoComplete="username" required data-autofocus />
                <PasswordInput label="Password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" required />
              </>
            ) : (
              <Stack gap={6} align="center">
                <Text size="sm">Enter the 6-digit code from your authenticator app</Text>
                <PinInput length={6} type="number" oneTimeCode value={code} onChange={setCode} onComplete={() => undefined} autoFocus aria-label="Authentication code" />
              </Stack>
            )}
            <Button type="submit" loading={busy} fullWidth>{mfa ? "Verify" : "Sign in"}</Button>
          </Stack>
        </form>
      </Card>
    </Center>
  );
}

export function ChangePasswordPage({ forced }: { forced?: boolean }) {
  const { refresh, logout } = useAuth();
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (pw !== pw2) return setError("Passwords do not match");
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/password", { currentPassword: cur, newPassword: pw });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Center mih="100vh">
      <Card withBorder shadow="sm" radius="md" p="xl" w={420}>
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Stack>
            <Title order={3}>{forced ? "Set a new password" : "Change password"}</Title>
            {forced && <Text size="sm" c="dimmed">Your password must be changed before continuing.</Text>}
            {error && <Alert color="red">{error}</Alert>}
            <PasswordInput label="Current password" value={cur} onChange={(e) => setCur(e.currentTarget.value)} required autoComplete="current-password" />
            <PasswordInput label="New password" value={pw} onChange={(e) => setPw(e.currentTarget.value)} required autoComplete="new-password" />
            <PasswordInput label="Confirm new password" value={pw2} onChange={(e) => setPw2(e.currentTarget.value)} required autoComplete="new-password" />
            <Button type="submit" loading={busy}>Change password</Button>
            {forced && <Button variant="subtle" onClick={() => void logout()}>Sign out</Button>}
          </Stack>
        </form>
      </Card>
    </Center>
  );
}
