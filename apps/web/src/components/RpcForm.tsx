import { useEffect, useMemo, useState } from "react";
import {
  Button, FileButton, Group, JsonInput, NumberInput, Select, Stack, Switch, Text, TextInput, Tooltip, ActionIcon,
} from "@mantine/core";
import { IconInfoCircle, IconUpload } from "@tabler/icons-react";
import type { Catalog, CatalogField } from "../lib/types";
import { fileToB64 } from "../lib/format";

/** "MaxSession_u32" -> "Max session", "SecureNAT_Ex_bool" -> "Secure NAT ex" */
export function fieldLabel(name: string): string {
  const base = name.replace(/_(str|utf|u32|u64|bool|ip|dt|bin)$/, "").replace(/_/g, " ");
  const spaced = base.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function defaultValue(f: CatalogField): unknown {
  switch (f.kind) {
    case "number": case "enum": return 0;
    case "boolean": return false;
    case "array": return [];
    case "object": return {};
    case "datetime": return "1970-01-01T00:00:00.000Z";
    default: return "";
  }
}

export function emptyParams(catalog: Catalog, typeName: string | null): Record<string, unknown> {
  if (!typeName) return {};
  const t = catalog.types[typeName];
  return Object.fromEntries((t?.fields ?? []).map((f) => [f.name, defaultValue(f)]));
}

interface FieldProps {
  field: CatalogField;
  catalog: Catalog;
  value: unknown;
  onChange: (v: unknown) => void;
  readOnly?: boolean;
}

function DocIcon({ doc }: { doc: string }) {
  if (!doc) return null;
  return (
    <Tooltip label={doc} multiline w={360} withArrow>
      <ActionIcon variant="transparent" size="xs" c="dimmed" aria-label="Field help"><IconInfoCircle size={14} /></ActionIcon>
    </Tooltip>
  );
}

export function RpcField({ field, catalog, value, onChange, readOnly }: FieldProps) {
  const label = (
    <Group gap={4} wrap="nowrap" component="span" style={{ display: "inline-flex" }}>
      <span>{fieldLabel(field.name)}</span>
      <Text span size="xs" c="dimmed" ff="monospace">{field.name}</Text>
      <DocIcon doc={field.doc} />
    </Group>
  );
  switch (field.kind) {
    case "boolean":
      return <Switch label={label} checked={!!value} onChange={(e) => onChange(e.currentTarget.checked)} disabled={readOnly} />;
    case "number":
      return <NumberInput label={label} value={Number(value ?? 0)} onChange={(v) => onChange(Number(v) || 0)} min={0} readOnly={readOnly} allowDecimal={false} />;
    case "enum": {
      const e = catalog.enums[field.enum!];
      return (
        <Select
          label={label}
          data={(e?.values ?? []).map((v) => ({ value: String(v.value), label: `${v.key} (${v.value})` }))}
          value={String(value ?? 0)}
          onChange={(v) => onChange(Number(v ?? 0))}
          readOnly={readOnly}
          allowDeselect={false}
        />
      );
    }
    case "binary":
      return (
        <Stack gap={4}>
          <TextInput label={label} description="Base64-encoded bytes" value={String(value ?? "")} onChange={(e) => onChange(e.currentTarget.value.trim())} readOnly={readOnly} ff="monospace" />
          {!readOnly && (
            <FileButton onChange={async (f) => f && onChange(await fileToB64(f))}>
              {(props) => <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />} w="fit-content">Load from file…</Button>}
            </FileButton>
          )}
        </Stack>
      );
    case "array":
    case "object":
      return (
        <JsonInput
          label={label}
          description={field.kind === "array" ? `Array of ${field.items}` : `Object ${field.type}`}
          value={JSON.stringify(value ?? (field.kind === "array" ? [] : {}), null, 2)}
          onChange={(s) => { try { onChange(JSON.parse(s)); } catch { /* keep typing */ } }}
          autosize minRows={3} maxRows={16} formatOnBlur validationError="Invalid JSON" readOnly={readOnly}
        />
      );
    default:
      return (
        <TextInput
          label={label}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.currentTarget.value)}
          readOnly={readOnly}
          placeholder={field.kind === "ip" ? "0.0.0.0" : field.kind === "datetime" ? "ISO 8601" : undefined}
          type={/password/i.test(field.name) ? "password" : "text"}
          autoComplete="off"
        />
      );
  }
}

interface FormProps {
  catalog: Catalog;
  typeName: string;
  initial?: Record<string, unknown>;
  /** Fields to hide (e.g. the hub name, which comes from the route). */
  hidden?: string[];
  readOnlyFields?: string[];
  submitLabel?: string;
  onSubmit: (values: Record<string, unknown>) => void;
  loading?: boolean;
  disabled?: boolean;
}

/** Generic form for any catalog type; every RPC can be driven from it. */
export function RpcForm({ catalog, typeName, initial, hidden = [], readOnlyFields = [], submitLabel = "Save", onSubmit, loading, disabled }: FormProps) {
  const t = catalog.types[typeName];
  const base = useMemo(() => ({ ...emptyParams(catalog, typeName), ...(initial ?? {}) }), [catalog, typeName, initial]);
  const [values, setValues] = useState<Record<string, unknown>>(base);
  useEffect(() => setValues(base), [base]);
  if (!t) return <Text c="red">Unknown type {typeName}</Text>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(values); }}>
      <Stack gap="sm">
        {t.fields.filter((f) => !hidden.includes(f.name)).map((f) => (
          <RpcField key={f.name} field={f} catalog={catalog} value={values[f.name]}
            readOnly={disabled || readOnlyFields.includes(f.name)}
            onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
        ))}
        {!disabled && (
          <Group justify="flex-end"><Button type="submit" loading={loading}>{submitLabel}</Button></Group>
        )}
      </Stack>
    </form>
  );
}
