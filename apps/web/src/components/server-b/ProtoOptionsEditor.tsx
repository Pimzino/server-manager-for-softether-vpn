import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Group, List, NumberInput, PasswordInput, Stack, Switch, Table, Text, TextInput, Textarea } from "@mantine/core";
import { IconDeviceFloppy, IconRestore } from "@tabler/icons-react";
import { ConfirmButton, Empty, QueryState } from "../common";
import { useRpc, useRpcMutation } from "../../lib/hooks";
import {
  PROTO_TYPE, PROTO_TYPE_LABEL, decodeProtoOptions, encodeProtoOptions, encodeValue, isSecretOption, optionMeta,
  type ProtoOption, type ProtoOptionsRaw,
} from "./proto";
import { HelpLabel, NotApplicable, SecretText } from "./ui";

interface Props {
  serverId: number;
  protocol: string;
  /** Whether the current user may save (admin). */
  canEdit: boolean;
  /** Whether secrets may be revealed (admin). */
  canReveal: boolean;
  /** Restrict the visible options; hidden options are still sent back unchanged. */
  only?: string[];
  testId?: string;
  /** Extra warning shown in the save confirmation. */
  saveWarning?: string;
}

function valueLabel(o: ProtoOption) {
  if (isSecretOption(o.name)) return "••••••";
  if (o.type === PROTO_TYPE.BOOL) return o.value ? "on" : "off";
  const s = String(o.value);
  return s === "" ? "(empty)" : s.length > 60 ? s.slice(0, 60) + "…" : s;
}

/**
 * Typed editor for GetProtoOptions / SetProtoOptions. Decodes Value_bin per Type_u32 and
 * re-encodes the complete option list on save.
 */
export function ProtoOptionsEditor({ serverId, protocol, canEdit, canReveal, only, testId, saveWarning }: Props) {
  const q = useRpc<ProtoOptionsRaw>(serverId, "GetProtoOptions", { Protocol_str: protocol });
  const original = useMemo(() => decodeProtoOptions(q.data), [q.data]);
  const [opts, setOpts] = useState<ProtoOption[]>(original);
  useEffect(() => setOpts(original), [original]);
  const save = useRpcMutation(serverId, "SetProtoOptions", { success: `${protocol} options saved` });

  const changed = opts.filter((o, i) => encodeValue(o.type, o.value, o.raw) !== original[i]?.raw);
  const visible = opts.filter((o) => !only || only.includes(o.name));
  const set = (name: string, value: ProtoOption["value"]) => setOpts((s) => s.map((o) => (o.name === name ? { ...o, value } : o)));

  if (q.error) {
    return (
      <NotApplicable error={q.error} title={`${protocol} options are not available`}>
        This server does not expose per-protocol options for {protocol} (older SoftEther builds, or the protocol is not compiled in).
      </NotApplicable>
    );
  }

  const editor = (o: ProtoOption) => {
    const meta = optionMeta(protocol, o.name);
    const disabled = !canEdit;
    const aria = `${protocol} ${meta.label}`;
    if (o.type === PROTO_TYPE.BOOL) {
      return <Switch checked={!!o.value} onChange={(e) => set(o.name, e.currentTarget.checked)} disabled={disabled} aria-label={aria} data-testid={`proto-${protocol}-${o.name}`} />;
    }
    if (o.type === PROTO_TYPE.UINT32) {
      return (
        <NumberInput value={Number(o.value)} onChange={(v) => set(o.name, Number(v) || 0)} min={0} max={4294967295} allowDecimal={false} allowNegative={false}
          readOnly={disabled} w={200} rightSection={meta.unit ? <Text size="xs" c="dimmed">{meta.unit}</Text> : undefined} aria-label={aria} data-testid={`proto-${protocol}-${o.name}`} />
      );
    }
    if (o.type === PROTO_TYPE.STRING) {
      if (isSecretOption(o.name)) {
        if (!canEdit) return <SecretText value={String(o.value)} canReveal={canReveal} />;
        return <PasswordInput value={String(o.value)} onChange={(e) => set(o.name, e.currentTarget.value)} autoComplete="off" aria-label={aria} ff="monospace" data-testid={`proto-${protocol}-${o.name}`} />;
      }
      const long = String(o.value).length > 60 || o.name === "DefaultClientOption";
      return long
        ? <Textarea value={String(o.value)} onChange={(e) => set(o.name, e.currentTarget.value)} readOnly={disabled} autosize minRows={2} maxRows={6} ff="monospace" aria-label={aria} data-testid={`proto-${protocol}-${o.name}`} />
        : <TextInput value={String(o.value)} onChange={(e) => set(o.name, e.currentTarget.value)} readOnly={disabled} aria-label={aria} data-testid={`proto-${protocol}-${o.name}`} />;
    }
    return <Text size="xs" c="dimmed" ff="monospace">Unknown type {o.type} (raw: {o.raw}) – sent back unchanged</Text>;
  };

  return (
    <QueryState query={q}>
      {visible.length === 0 ? <Empty>No options reported for {protocol}</Empty> : (
        <Stack gap="sm" data-testid={testId}>
          <Table verticalSpacing="sm" withRowBorders>
            <Table.Thead>
              <Table.Tr><Table.Th w={280}>Option</Table.Th><Table.Th>Value</Table.Th></Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {visible.map((o) => {
                const meta = optionMeta(protocol, o.name);
                return (
                  <Table.Tr key={o.name}>
                    <Table.Td style={{ verticalAlign: "top" }}>
                      <Text size="sm" fw={500} component="div"><HelpLabel label={meta.label} doc={meta.doc} /></Text>
                      <Group gap={6} mt={2}>
                        <Text size="xs" c="dimmed" ff="monospace">{o.name}</Text>
                        <Badge size="xs" variant="outline" color="gray">{PROTO_TYPE_LABEL[o.type] ?? `type ${o.type}`}</Badge>
                        {changed.includes(o) && <Badge size="xs" color="yellow" variant="light">modified</Badge>}
                      </Group>
                    </Table.Td>
                    <Table.Td>{editor(o)}</Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
          {canEdit && (
            <Group justify="flex-end">
              <Button variant="default" size="sm" leftSection={<IconRestore size={16} />} disabled={changed.length === 0} onClick={() => setOpts(original)}>Reset</Button>
              <ConfirmButton
                title={`Apply ${protocol} options?`}
                color="blue" variant="filled" size="sm" confirmLabel="Apply"
                disabled={changed.length === 0}
                leftSection={<IconDeviceFloppy size={16} />}
                message={
                  <Stack gap="xs">
                    <Text size="sm">The following options will be changed on the server (all other options are sent back unchanged):</Text>
                    <List size="sm">
                      {changed.map((o) => {
                        const before = original.find((x) => x.name === o.name);
                        return <List.Item key={o.name}><b>{optionMeta(protocol, o.name).label}</b>: {before ? valueLabel(before) : "?"} → {valueLabel(o)}</List.Item>;
                      })}
                    </List>
                    {saveWarning && <Text size="sm" c="orange">{saveWarning}</Text>}
                  </Stack>
                }
                onConfirm={() => save.mutateAsync(encodeProtoOptions(protocol, opts))}
              >
                <span data-testid={`save-proto-${protocol}`}>Save {protocol} options</span>
              </ConfirmButton>
            </Group>
          )}
        </Stack>
      )}
    </QueryState>
  );
}
