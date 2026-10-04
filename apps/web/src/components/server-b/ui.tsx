import { useState, type ReactNode } from "react";
import { ActionIcon, Alert, Code, Group, Text, Tooltip } from "@mantine/core";
import { IconEye, IconEyeOff, IconInfoCircle, IconInfoSquareRounded } from "@tabler/icons-react";
import { ApiError } from "../../lib/api";
import { can, useServer } from "../../lib/hooks";
import { Copyable, ErrorAlert } from "../common";
import type { Role } from "../../lib/types";

/** Role helpers for server-level pages. Hub-admin-mode connections cannot use server-level RPCs. */
export function useServerAccess(serverId: number) {
  const server = useServer(serverId);
  const role: Role = server.data?.myRole ?? "none";
  const hubMode = !!server.data?.hub;
  return {
    server,
    role,
    hubMode,
    isOperator: can(role, "operator") && !hubMode,
    isAdmin: can(role, "admin") && !hubMode,
  };
}

/** Label with an info tooltip carrying the catalog documentation. */
export function HelpLabel({ label, doc }: { label: ReactNode; doc?: string }) {
  if (!doc) return <>{label}</>;
  return (
    <Group gap={4} wrap="nowrap" component="span" style={{ display: "inline-flex" }}>
      <span>{label}</span>
      <Tooltip label={doc} multiline w={380} withArrow>
        <ActionIcon component="span" variant="transparent" size="xs" c="dimmed" aria-label="Help"><IconInfoCircle size={14} /></ActionIcon>
      </Tooltip>
    </Group>
  );
}

/** Masked secret with an optional reveal toggle (only offered when `canReveal`). */
export function SecretText({ value, canReveal, testId }: { value: string; canReveal: boolean; testId?: string }) {
  const [shown, setShown] = useState(false);
  if (!value) return <Text size="sm" c="dimmed">(not set)</Text>;
  return (
    <Group gap={4} wrap="nowrap" data-testid={testId}>
      {shown ? <Copyable value={value} /> : <Code>{"•".repeat(Math.min(24, Math.max(8, value.length)))}</Code>}
      {canReveal && (
        <Tooltip label={shown ? "Hide" : "Reveal"}>
          <ActionIcon variant="subtle" size="sm" onClick={() => setShown((s) => !s)} aria-label={shown ? "Hide secret" : "Reveal secret"} data-testid={testId ? `${testId}-reveal` : undefined}>
            {shown ? <IconEyeOff size={14} /> : <IconEye size={14} />}
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );
}

export function isUnsupported(e: unknown) {
  return e instanceof ApiError && e.softEtherCode === 33;
}

/** Friendly "not applicable" state for SoftEther error 33 (feature absent on this edition / OS); other errors fall back to ErrorAlert. */
export function NotApplicable({ error, title, children }: { error: unknown; title: string; children: ReactNode }) {
  if (!isUnsupported(error)) return <ErrorAlert error={error} />;
  return (
    <Alert color="gray" variant="light" icon={<IconInfoSquareRounded size={18} />} title={title} my="sm">
      <Text size="sm" component="div">{children}</Text>
      <Text size="xs" c="dimmed" mt={6}>The server answered with SoftEther error 33 (Unsupported).</Text>
    </Alert>
  );
}
