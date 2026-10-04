import { useState, type ReactNode } from "react";
import {
  Alert, Badge, Button, Card, Center, Code, Group, Loader, Modal, Stack, Table, Text, TextInput, Title, CopyButton, ActionIcon, Tooltip,
} from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconCopy, IconLock } from "@tabler/icons-react";
import { ApiError } from "../lib/api";

export function PageHeader({ title, description, actions, badge }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; badge?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-start" mb="md" wrap="wrap">
      <div>
        <Group gap="xs"><Title order={2}>{title}</Title>{badge}</Group>
        {description && <Text c="dimmed" size="sm" mt={4} maw={820}>{description}</Text>}
      </div>
      {actions && <Group gap="xs">{actions}</Group>}
    </Group>
  );
}

export function Section({ title, description, children, actions }: { title: ReactNode; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <Card withBorder radius="md" padding="lg" mb="md">
      <Group justify="space-between" mb="sm" align="flex-start">
        <div>
          <Title order={4}>{title}</Title>
          {description && <Text size="sm" c="dimmed" mt={2}>{description}</Text>}
        </div>
        {actions && <Group gap="xs">{actions}</Group>}
      </Group>
      {children}
    </Card>
  );
}

/** Render loading / error states for a query-like object, else children. */
export function QueryState({ query, children }: { query: { isLoading: boolean; error: unknown }; children: ReactNode }) {
  if (query.isLoading) return <Center py="xl"><Loader /></Center>;
  if (query.error) return <ErrorAlert error={query.error} />;
  return <>{children}</>;
}

export function ErrorAlert({ error }: { error: unknown }) {
  const e = error as ApiError | Error;
  const code = e instanceof ApiError ? e.softEtherCode : undefined;
  const unsupported = code === 33;
  return (
    <Alert color={unsupported ? "gray" : "red"} icon={<IconAlertTriangle size={18} />} title={unsupported ? "Not supported by this server" : "Request failed"} my="sm">
      {e?.message ?? String(error)}
      {code !== undefined && <Text size="xs" c="dimmed" mt={4}>SoftEther error code {code}</Text>}
    </Alert>
  );
}

export function KeyValue({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <Table withRowBorders={false} verticalSpacing={4}>
      <Table.Tbody>
        {rows.map(([k, v], i) => (
          <Table.Tr key={i}>
            <Table.Td w={260}><Text size="sm" c="dimmed">{k}</Text></Table.Td>
            <Table.Td><Text size="sm" component="div">{v}</Text></Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export function OnlineBadge({ online, onLabel = "Online", offLabel = "Offline" }: { online: boolean | null | undefined; onLabel?: string; offLabel?: string }) {
  if (online === null || online === undefined) return <Badge color="gray" variant="light">Unknown</Badge>;
  return <Badge color={online ? "green" : "red"} variant="light">{online ? onLabel : offLabel}</Badge>;
}

export function Copyable({ value, mono = true }: { value: string; mono?: boolean }) {
  return (
    <Group gap={4} wrap="nowrap">
      {mono ? <Code style={{ wordBreak: "break-all" }}>{value}</Code> : <Text size="sm">{value}</Text>}
      <CopyButton value={value}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? "Copied" : "Copy"}>
            <ActionIcon variant="subtle" size="sm" onClick={copy} aria-label="Copy">{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}</ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

/**
 * Confirmation dialog for destructive actions. When `typeToConfirm` is set the user must
 * type that exact text (e.g. the hub name) to enable the button.
 */
export function ConfirmButton({
  children, title, message, onConfirm, typeToConfirm, color = "red", loading, disabled, variant = "light", size = "xs", leftSection, confirmLabel = "Confirm", testId, "data-testid": dataTestId,
}: {
  children: ReactNode; title: string; message: ReactNode; onConfirm: () => unknown | Promise<unknown>; typeToConfirm?: string;
  color?: string; loading?: boolean; disabled?: boolean; variant?: string; size?: string; leftSection?: ReactNode; confirmLabel?: string;
  /** data-testid for the trigger button; the modal's confirm button gets `${testId}-confirm`. */
  testId?: string; "data-testid"?: string;
}) {
  const tid = testId ?? dataTestId;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button color={color} variant={variant} size={size} onClick={() => { setTyped(""); setOpen(true); }} loading={loading} disabled={disabled} leftSection={leftSection} data-testid={tid}>
        {children}
      </Button>
      <Modal opened={open} onClose={() => setOpen(false)} title={title} centered>
        <Stack>
          <Text size="sm" component="div">{message}</Text>
          {typeToConfirm && (
            <TextInput label={<>Type <Code>{typeToConfirm}</Code> to confirm</>} value={typed} onChange={(e) => setTyped(e.currentTarget.value)} data-autofocus data-testid="confirm-type" />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              color={color}
              data-testid={tid ? `${tid}-confirm` : "confirm-action"}
              loading={busy}
              disabled={!!typeToConfirm && typed !== typeToConfirm}
              onClick={async () => {
                setBusy(true);
                try { await onConfirm(); setOpen(false); } catch { /* caller notifies */ } finally { setBusy(false); }
              }}
            >
              {confirmLabel}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

export function ReadOnlyNotice({ role }: { role: string }) {
  return (
    <Alert color="gray" icon={<IconLock size={16} />} mb="md" variant="light">
      You have <b>{role}</b> access here; changes are disabled.
    </Alert>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <Center py="xl"><Text c="dimmed">{children}</Text></Center>;
}
