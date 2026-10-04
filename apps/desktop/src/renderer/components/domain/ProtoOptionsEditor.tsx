// Typed editor for GetProtoOptions / SetProtoOptions (OpenVPN, SSTP, WireGuard…). Decodes Value_bin per Type_u32,
// shows one grouped settings box, and re-encodes the complete option list on save (the server expects all of it).
// SetProtoOptions is a "danger" RPC: the save confirmation lists every changed option (old → new).
import { useEffect, useMemo, useState } from "react";
import { Button, Group, NumberInput, PasswordInput, Switch, TextInput, Textarea } from "@mantine/core";
import { IconSettingsOff } from "@tabler/icons-react";
import { useRpc, useRpcMutation } from "../../lib/hooks";
import { EmptyState, FormRow, FormSection, Mono, PropertySkeleton, Tag } from "../../design";
import {
  PROTO_TYPE, PROTO_TYPE_LABEL, decodeProtoOptions, encodeProtoOptions, encodeValue, isSecretOption, optionMeta,
  type ProtoOption, type ProtoOptionsRaw,
} from "./proto";
import { NotApplicable, SecretText } from "./ui";

interface Props {
  serverId: number;
  protocol: string;
  /** Show values without editing them (e.g. while the protocol is turned off elsewhere). */
  readOnly?: boolean;
  /** Restrict the visible options; hidden options are still sent back unchanged. */
  only?: string[];
  /** Box title; defaults to "<protocol> options". Pass null for none. */
  title?: string | null;
  description?: string;
  testId?: string;
  /** Extra warning shown in the save confirmation. */
  saveWarning?: string;
}

function valueLabel(o: ProtoOption) {
  if (isSecretOption(o.name)) return "••••••";
  if (o.type === PROTO_TYPE.BOOL) return o.value ? "On" : "Off";
  const s = String(o.value);
  return s === "" ? "empty" : s.length > 60 ? s.slice(0, 60) + "…" : s;
}

export function ProtoOptionsEditor({ serverId, protocol, readOnly, only, title, description, testId, saveWarning }: Props) {
  const q = useRpc<ProtoOptionsRaw>(serverId, "GetProtoOptions", { Protocol_str: protocol });
  const original = useMemo(() => decodeProtoOptions(q.data), [q.data]);
  const [opts, setOpts] = useState<ProtoOption[]>(original);
  useEffect(() => setOpts(original), [original]);

  const changed = opts.filter((o, i) => encodeValue(o.type, o.value, o.raw) !== original[i]?.raw);
  const save = useRpcMutation<ReturnType<typeof encodeProtoOptions>>(serverId, "SetProtoOptions", {
    success: `${protocol} options saved`,
    confirm: () => ({
      title: <>Change {protocol} options?</>,
      message: "Only these options change. Clients using this protocol may need new settings to reconnect.",
      details: (
        <ul style={{ margin: "var(--sem-space-2) 0 0", paddingLeft: "var(--sem-space-7)" }} data-testid={`proto-${protocol}-changes`}>
          {changed.map((o) => {
            const before = original.find((x) => x.name === o.name);
            return <li key={o.name}><span className="sem-strong">{optionMeta(protocol, o.name).label}</span>: {before ? valueLabel(before) : "?"} → {valueLabel(o)}</li>;
          })}
          {saveWarning && <li style={{ listStyle: "none", marginLeft: "calc(-1 * var(--sem-space-7))", marginTop: "var(--sem-space-3)", color: "var(--sem-orange)" }}>{saveWarning}</li>}
        </ul>
      ),
      confirmLabel: "Apply",
      tone: "warning",
      testId: `save-proto-${protocol}`,
    }),
  });

  const visible = opts.filter((o) => !only || only.includes(o.name));
  const set = (name: string, value: ProtoOption["value"]) => setOpts((s) => s.map((o) => (o.name === name ? { ...o, value } : o)));
  const boxTitle = title === null ? undefined : title ?? `${protocol} options`;

  if (q.error) {
    return (
      <NotApplicable error={q.error} title={`${protocol} options aren’t available`} onRetry={() => void q.refetch()}>
        This server doesn’t expose per-protocol options for {protocol}. Older SoftEther builds don’t have them, or the protocol isn’t compiled in.
      </NotApplicable>
    );
  }
  if (q.isLoading) return <FormSection title={boxTitle}><PropertySkeleton rows={3} /></FormSection>;
  if (visible.length === 0) {
    return <EmptyState compact icon={<IconSettingsOff size={24} stroke={1.4} />} title={`No options for ${protocol}`} description="The server didn’t report any settings for this protocol." />;
  }

  const editor = (o: ProtoOption, id: string) => {
    const meta = optionMeta(protocol, o.name);
    const aria = `${protocol} ${meta.label}`;
    const tid = `proto-${protocol}-${o.name}`;
    if (o.type === PROTO_TYPE.BOOL) {
      return <Switch id={id} checked={!!o.value} onChange={(e) => set(o.name, e.currentTarget.checked)} disabled={readOnly} aria-label={aria} data-testid={tid} />;
    }
    if (o.type === PROTO_TYPE.UINT32) {
      return (
        <NumberInput id={id} value={Number(o.value)} onChange={(v) => set(o.name, Number(v) || 0)} min={0} max={4294967295} allowDecimal={false} allowNegative={false}
          readOnly={readOnly} w={180} rightSection={meta.unit ? <span className="sem-input-unit">{meta.unit}</span> : undefined}
          aria-label={aria} data-testid={tid} />
      );
    }
    if (o.type === PROTO_TYPE.STRING) {
      if (isSecretOption(o.name)) {
        if (readOnly) return <SecretText value={String(o.value)} />;
        return <PasswordInput id={id} value={String(o.value)} onChange={(e) => set(o.name, e.currentTarget.value)} autoComplete="off" aria-label={aria}
          styles={{ input: { fontFamily: "var(--sem-font-mono)" } }} data-testid={tid} />;
      }
      const long = String(o.value).length > 60 || o.name === "DefaultClientOption";
      return long
        ? <Textarea id={id} value={String(o.value)} onChange={(e) => set(o.name, e.currentTarget.value)} readOnly={readOnly} autosize minRows={2} maxRows={6}
            styles={{ input: { fontFamily: "var(--sem-font-mono)" } }} aria-label={aria} data-testid={tid} spellCheck={false} />
        : <TextInput id={id} value={String(o.value)} onChange={(e) => set(o.name, e.currentTarget.value)} readOnly={readOnly} aria-label={aria} data-testid={tid} spellCheck={false} />;
    }
    return <span className="sem-dim">Unknown type {o.type}. The raw value <Mono>{o.raw}</Mono> is sent back unchanged.</span>;
  };

  return (
    <div data-testid={testId}>
      <FormSection title={boxTitle} description={description}>
        {visible.map((o) => {
          const meta = optionMeta(protocol, o.name);
          const long = o.type === PROTO_TYPE.STRING && !isSecretOption(o.name) && (String(o.value).length > 60 || o.name === "DefaultClientOption");
          return (
            <FormRow
              key={o.name}
              stacked={long}
              align="start"
              testId={`proto-row-${protocol}-${o.name}`}
              label={<span className="sem-row-inline">{meta.label}{changed.includes(o) && <Tag color="orange">Modified</Tag>}</span>}
              description={<>
                {meta.doc && <div>{meta.doc}</div>}
                <div className="sem-row-inline" style={{ marginTop: "var(--sem-space-1)" }}>
                  <Mono dim>{o.name}</Mono><Tag variant="outline">{PROTO_TYPE_LABEL[o.type] ?? `type ${o.type}`}</Tag>
                </div>
              </>}
            >
              {(id) => editor(o, id)}
            </FormRow>
          );
        })}
      </FormSection>
      {!readOnly && (
        <Group justify="flex-end" gap={8} mt={10}>
          <Button variant="default" disabled={changed.length === 0 || save.isPending} onClick={() => setOpts(original)} data-testid={`revert-proto-${protocol}`}>Revert</Button>
          <Button disabled={changed.length === 0} loading={save.isPending} onClick={() => save.mutate(encodeProtoOptions(protocol, opts))} data-testid={`save-proto-${protocol}`}>
            Save {protocol} Options
          </Button>
        </Group>
      )}
    </div>
  );
}
