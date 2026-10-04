// Generic form for any catalog type: every RPC can be driven from it (API console, "raw" editors).
// RpcField renders one FormRow (label, field name, docs, control); RpcFieldControl renders just the control;
// RpcForm renders a FormSection of RpcFields with a submit button.
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Button, Group, JsonInput, NumberInput, PasswordInput, Select, Switch, TextInput } from "@mantine/core";
import { IconFileUpload } from "@tabler/icons-react";
import type { Catalog, CatalogField } from "../../lib/types";
import { notifyError } from "../../lib/hooks";
import { ErrorState, FormRow, FormSection, Mono } from "../../design";
import { openB64 } from "./files";
import { HelpLabel } from "./ui";

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
  /** Input id (FormRow passes it so the label is wired to the control). */
  id?: string;
}

/** Whether the control needs the full row width (JSON, binary): FormRow `stacked`. */
export const isWideField = (f: CatalogField) => f.kind === "array" || f.kind === "object" || f.kind === "binary";

/** The input for one catalog field, without a label. */
export function RpcFieldControl({ field, catalog, value, onChange, readOnly, id }: FieldProps) {
  const aria = fieldLabel(field.name);
  const testId = `rpc-field-${field.name}`;
  switch (field.kind) {
    case "boolean":
      return <Switch id={id} checked={!!value} onChange={(e) => onChange(e.currentTarget.checked)} disabled={readOnly} aria-label={aria} data-testid={testId} />;
    case "number":
      return <NumberInput id={id} w={180} value={Number(value ?? 0)} onChange={(v) => onChange(Number(v) || 0)} min={0} readOnly={readOnly} allowDecimal={false} allowNegative={false} aria-label={aria} data-testid={testId} />;
    case "enum": {
      const e = catalog.enums[field.enum!];
      return (
        <Select
          id={id} w={300} aria-label={aria} data-testid={testId}
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
        <Group gap={8} wrap="nowrap" align="center" w="100%">
          <TextInput id={id} style={{ flex: 1 }} value={String(value ?? "")} onChange={(e) => onChange(e.currentTarget.value.trim())} readOnly={readOnly}
            placeholder="Base64" styles={{ input: { fontFamily: "var(--sem-font-mono)" } }} aria-label={aria} data-testid={testId} spellCheck={false} />
          {!readOnly && (
            <Button variant="default" leftSection={<IconFileUpload size={14} />} data-testid={`${testId}-load`}
              onClick={async () => {
                try {
                  const f = await openB64({ title: `Load ${aria}` });
                  if (f) onChange(f.b64);
                } catch (e) { notifyError(e, "Couldn’t read the file"); }
              }}>Load from File…</Button>
          )}
        </Group>
      );
    case "array":
    case "object":
      return (
        <JsonInput
          id={id} w="100%" aria-label={aria} data-testid={testId}
          value={JSON.stringify(value ?? (field.kind === "array" ? [] : {}), null, 2)}
          onChange={(s) => { try { onChange(JSON.parse(s)); } catch { /* keep typing */ } }}
          autosize minRows={3} maxRows={16} formatOnBlur validationError="Not valid JSON" readOnly={readOnly}
          styles={{ input: { fontFamily: "var(--sem-font-mono)" } }}
        />
      );
    default: {
      const common = {
        id, w: "100%", value: String(value ?? ""), readOnly, autoComplete: "off", spellCheck: false, "aria-label": aria, "data-testid": testId,
        onChange: (e: ChangeEvent<HTMLInputElement>) => onChange(e.currentTarget.value),
      };
      if (/password/i.test(field.name)) return <PasswordInput {...common} />;
      return <TextInput {...common} placeholder={field.kind === "ip" ? "0.0.0.0" : field.kind === "datetime" ? "ISO 8601, e.g. 2026-01-31T00:00:00Z" : undefined}
        styles={field.kind === "ip" || field.kind === "datetime" ? { input: { fontFamily: "var(--sem-font-mono)" } } : undefined} />;
    }
  }
}

/** Describes a field type in words for the row description ("Array of VpnRpcEnumHubItem"). */
function kindNote(f: CatalogField): string | null {
  if (f.kind === "array") return `Array of ${f.items ?? "values"}`;
  if (f.kind === "object") return `Object ${f.type ?? ""}`.trim();
  if (f.kind === "binary") return "Base64-encoded bytes";
  return null;
}

/** One catalog field as a form row: friendly label, the raw field name, docs in a tooltip, and the control. */
export function RpcField(props: Omit<FieldProps, "id">) {
  const { field } = props;
  const note = kindNote(field);
  return (
    <FormRow
      label={<HelpLabel label={fieldLabel(field.name)} doc={field.doc} />}
      description={<><Mono dim>{field.name}</Mono>{note && <> · {note}</>}</>}
      stacked={isWideField(field)}
      testId={`rpc-row-${field.name}`}
    >
      {(id) => <RpcFieldControl {...props} id={id} />}
    </FormRow>
  );
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
  /** Read-only form without a submit button. */
  disabled?: boolean;
  title?: string;
  testId?: string;
}

/** Generic form for any catalog type. */
export function RpcForm({ catalog, typeName, initial, hidden = [], readOnlyFields = [], submitLabel = "Save", onSubmit, loading, disabled, title, testId }: FormProps) {
  const t = catalog.types[typeName];
  const base = useMemo(() => ({ ...emptyParams(catalog, typeName), ...(initial ?? {}) }), [catalog, typeName, initial]);
  const [values, setValues] = useState<Record<string, unknown>>(base);
  useEffect(() => setValues(base), [base]);
  if (!t) return <ErrorState inline error={new Error(`The catalog has no type named ${typeName}.`)} />;
  const fields = t.fields.filter((f) => !hidden.includes(f.name));
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(values); }} data-testid={testId}>
      <FormSection title={title}>
        {fields.length === 0
          ? <FormRow label={<span className="sem-dim">This call takes no parameters.</span>}>{null}</FormRow>
          : fields.map((f) => (
            <RpcField key={f.name} field={f} catalog={catalog} value={values[f.name]}
              readOnly={disabled || readOnlyFields.includes(f.name)}
              onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
          ))}
      </FormSection>
      {!disabled && (
        <Group justify="flex-end" mt={12}><Button type="submit" loading={loading} data-testid={testId ? `${testId}-submit` : undefined}>{submitLabel}</Button></Group>
      )}
    </form>
  );
}
