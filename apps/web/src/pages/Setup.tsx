import { useState } from "react";
import { Alert, Button, Card, Center, Code, List, PasswordInput, Stack, Text, TextInput, Title, Group } from "@mantine/core";
import { IconShieldLock } from "@tabler/icons-react";
import { ApiError, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { User } from "../lib/types";

interface Policy { minLength: number; requireMixed: boolean }

/**
 * First-run setup: shown only while the server reports setupRequired. It needs the one-time
 * setup token from the server log / data directory, creates the first administrator and signs
 * them in. The backend closes setup permanently once it succeeds.
 */
export function SetupPage({ policy, onDone }: { policy?: Policy; onDone: () => void }) {
  const { setUser } = useAuth();
  const [setupToken, setSetupToken] = useState("");
  const [username, setUsername] = useState("admin");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;
  const submit = async () => {
    if (password !== confirm) return setError("Passwords do not match");
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ user: User }>("/api/setup", { setupToken, username, displayName, email, password });
      setUser(r.user);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // Someone completed setup in the meantime
        onDone();
        return;
      }
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center mih="100vh" bg="var(--mantine-color-gray-light)" p="md">
      <Card withBorder shadow="sm" radius="md" p="xl" w={520} data-testid="setup-page">
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Stack>
            <Group gap="xs">
              <IconShieldLock size={30} color="var(--mantine-color-blue-6)" />
              <div>
                <Title order={3}>Welcome to SoftEther Manager</Title>
                <Text size="xs" c="dimmed">First-run setup: create the first administrator</Text>
              </div>
            </Group>
            <Alert color="blue" variant="light" title="Setup token required">
              <Text size="sm">
                To prove you control this installation, enter the one-time setup token printed in the server log
                at startup. It is also stored in <Code>setup-token.txt</Code> in the data directory.
                This page disappears for good once the administrator is created.
              </Text>
            </Alert>
            {error && <Alert color="red" data-testid="setup-error">{error}</Alert>}
            <TextInput label="Setup token" required value={setupToken} onChange={(e) => setSetupToken(e.currentTarget.value)}
              autoComplete="off" spellCheck={false} styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }} data-autofocus data-testid="setup-token" />
            <TextInput label="Administrator username" required value={username} onChange={(e) => setUsername(e.currentTarget.value)}
              autoComplete="username" data-testid="setup-username" />
            <Group grow>
              <TextInput label="Display name" value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} data-testid="setup-display-name" />
              <TextInput label="Email" type="email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} data-testid="setup-email" />
            </Group>
            <PasswordInput label="Password" required value={password} onChange={(e) => setPassword(e.currentTarget.value)}
              autoComplete="new-password" data-testid="setup-password"
              description={policy && (
                <List size="xs" spacing={0}>
                  <List.Item>At least {policy.minLength} characters, not containing the username</List.Item>
                  {policy.requireMixed && <List.Item>Three of: lowercase, uppercase, digits, symbols</List.Item>}
                </List>
              )} />
            <PasswordInput label="Confirm password" required value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)}
              autoComplete="new-password" error={mismatch ? "Passwords do not match" : undefined} data-testid="setup-confirm" />
            <Button type="submit" loading={busy} disabled={!setupToken || !username || !password || mismatch} data-testid="setup-submit">
              Create administrator
            </Button>
          </Stack>
        </form>
      </Card>
    </Center>
  );
}
