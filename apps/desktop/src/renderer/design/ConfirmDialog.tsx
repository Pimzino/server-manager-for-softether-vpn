// Confirmation dialogs for dangerous actions (the replacement for the web product's RBAC).
//
//   const ok = await confirmAction({ title, message, tone: "danger", typeToConfirm: hub });
//   <ConfirmButton title=… message=… onConfirm={…}>Delete</ConfirmButton>
//   useRpcMutation(serverId, "DeleteHub")   // confirms by itself, the catalog marks DeleteHub as "danger"
import { useState, type ReactNode } from "react";
import { Button, Code, Group, Stack, Text, TextInput, type ButtonProps } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconAlertTriangleFilled, IconInfoCircleFilled, IconTrashFilled } from "@tabler/icons-react";
import type { MethodInfo, Server } from "../lib/types";

export type ConfirmTone = "danger" | "warning" | "default";

export interface ConfirmOptions {
  title: ReactNode;
  /** One or two sentences: what happens, and whether it can be undone. */
  message?: ReactNode;
  /** Extra content under the message (a list of affected objects…). */
  details?: ReactNode;
  /** Verb naming the action, e.g. "Delete Hub". Never "OK" / "Yes". */
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  /** When set the user must type this exact text (hub name, server name) to enable the button. */
  typeToConfirm?: string;
  /** Label above the typed-confirmation field. */
  typeLabel?: ReactNode;
  testId?: string;
}

export class ConfirmCancelled extends Error {
  constructor() { super("Cancelled"); this.name = "ConfirmCancelled"; }
}
export const isConfirmCancelled = (e: unknown): e is ConfirmCancelled => e instanceof ConfirmCancelled;

let seq = 0;

/** Ask for confirmation. Resolves true when confirmed, false when cancelled (Esc, Cancel, click outside). */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `sem-confirm-${++seq}`;
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      modals.close(id);
      resolve(v);
    };
    modals.open({
      modalId: id,
      withCloseButton: false,
      centered: true,
      size: 440,
      padding: 0,
      closeOnClickOutside: opts.tone !== "danger",
      classNames: { content: "sem-alert", body: "sem-alert-body" },
      onClose: () => finish(false),
      children: <ConfirmBody opts={opts} onResolve={finish} />,
    });
  });
}

function ConfirmBody({ opts, onResolve }: { opts: ConfirmOptions; onResolve: (v: boolean) => void }) {
  const [typed, setTyped] = useState("");
  const tone = opts.tone ?? "danger";
  const blocked = !!opts.typeToConfirm && typed.trim() !== opts.typeToConfirm;
  const Icon = tone === "danger" ? (opts.confirmLabel?.toLowerCase().startsWith("delete") ? IconTrashFilled : IconAlertTriangleFilled)
    : tone === "warning" ? IconAlertTriangleFilled : IconInfoCircleFilled;
  const tid = opts.testId ?? "confirm";
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (!blocked) onResolve(true); }}
      data-testid={`${tid}-dialog`}
    >
      <div className="sem-alert-main">
        <div className="sem-alert-icon" data-tone={tone}><Icon size={22} /></div>
        <Stack gap={6} style={{ minWidth: 0, flex: 1 }}>
          <Text className="sem-alert-title" component="h2">{opts.title}</Text>
          {opts.message && <Text component="div" className="sem-alert-message">{opts.message}</Text>}
          {opts.details}
          {opts.typeToConfirm && (
            <TextInput
              mt={6}
              label={opts.typeLabel ?? <>To confirm, type <Code className="sem-code-inline">{opts.typeToConfirm}</Code></>}
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
              data-autofocus
              autoComplete="off"
              spellCheck={false}
              data-testid="confirm-type"
            />
          )}
        </Stack>
      </div>
      <Group justify="flex-end" gap={8} className="sem-alert-actions">
        <Button variant="default" onClick={() => onResolve(false)} data-autofocus={opts.typeToConfirm ? undefined : true} data-testid={`${tid}-cancel`}>
          {opts.cancelLabel ?? "Cancel"}
        </Button>
        <Button type="submit" color={tone === "danger" ? "red" : undefined} disabled={blocked} data-testid={`${tid}-confirm`}>
          {opts.confirmLabel ?? "Continue"}
        </Button>
      </Group>
    </form>
  );
}

/** Hook form, for symmetry with other hooks: const confirm = useConfirm(); if (await confirm({...})) … */
export function useConfirm() {
  return confirmAction;
}

// ---------------------------------------------------------------------------------------------
// Built-in copy for the RPCs the catalog marks as "danger".

interface RpcCtx { server?: Server; info?: MethodInfo; override?: ConfirmOptions }
type P = Record<string, unknown>;
const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));

const DANGER_COPY: Record<string, (p: P, c: RpcCtx) => ConfirmOptions> = {
  DeleteHub: (p) => ({
    title: <>Delete Virtual Hub “{s(p.HubName_str)}”?</>,
    message: "Its users, groups, access lists, cascade connections and settings are deleted, and every session on it is disconnected. This can’t be undone.",
    confirmLabel: "Delete Hub",
    typeToConfirm: s(p.HubName_str) || undefined,
  }),
  RebootServer: (p, c) => ({
    title: p.IntValue_u32 ? "Reset and restart the VPN Server?" : "Restart the VPN Server?",
    message: p.IntValue_u32
      ? <>The configuration of <b>{c.server?.name ?? "this server"}</b> is erased and replaced with factory defaults, then the service restarts. Every hub, user and setting is lost.</>
      : <>Every VPN session and management connection to <b>{c.server?.name ?? "this server"}</b> drops while the service restarts.</>,
    confirmLabel: p.IntValue_u32 ? "Reset and Restart" : "Restart",
    typeToConfirm: p.IntValue_u32 ? c.server?.name : undefined,
  }),
  SetConfig: (_p, c) => ({
    title: "Replace the server configuration?",
    message: <>The whole configuration of <b>{c.server?.name ?? "this server"}</b> is overwritten and the service restarts. Settings that aren’t in the new configuration are lost.</>,
    confirmLabel: "Replace and Restart",
    typeToConfirm: c.server?.name,
    typeLabel: c.server ? <>To confirm, type the connection name <Code className="sem-code-inline">{c.server.name}</Code></> : undefined,
  }),
  SetServerCert: () => ({
    title: "Replace the server certificate?",
    message: "Clients and managers that trust the current certificate must trust the new one before they can connect. This app re-pins it for you.",
    confirmLabel: "Replace Certificate",
  }),
  RegenerateServerCert: (p) => ({
    title: "Generate a new server certificate?",
    message: <>A new self-signed certificate{p.StrValue_str ? <> for <b>{s(p.StrValue_str)}</b></> : null} replaces the current one. Clients that pinned the old certificate stop connecting until they trust the new one.</>,
    confirmLabel: "Generate Certificate",
  }),
  SetServerPassword: () => ({
    title: "Change the administrator password?",
    message: "vpncmd, other Server Manager installations and scripts that use the current password stop working. The password saved in this app is updated.",
    confirmLabel: "Change Password",
  }),
  SetServerCipher: (p) => ({
    title: "Change the TLS cipher?",
    message: <>Clients and managers that don’t support <b>{s(p.String_str) || "the selected cipher"}</b> can no longer connect.</>,
    confirmLabel: "Change Cipher",
    tone: "warning",
  }),
  DeleteListener: (p, c) => ({
    title: <>Delete the listener on port {s(p.Port_u32)}?</>,
    message: Number(p.Port_u32) === c.server?.port
      ? <>This app manages <b>{c.server?.name}</b> through port {s(p.Port_u32)}. Deleting it disconnects this app from the server.</>
      : "Clients and managers that connect on this port are refused.",
    confirmLabel: "Delete Listener",
    typeToConfirm: Number(p.Port_u32) === c.server?.port ? s(p.Port_u32) : undefined,
  }),
  SetPortsUDP: () => ({ title: "Change the UDP ports?", message: "Clients using the removed ports disconnect.", confirmLabel: "Change Ports", tone: "warning" }),
  SetSpecialListener: () => ({ title: "Change the special listeners?", message: "Turning off VPN over ICMP or DNS disconnects clients that use them.", confirmLabel: "Apply", tone: "warning" }),
  SetFarmSetting: () => ({
    title: "Change the clustering role?",
    message: "The server restarts its clustering service. Sessions on this server and on cluster members may be disconnected.",
    confirmLabel: "Change Role",
  }),
  GetConfig: () => ({
    title: "Read the full configuration?",
    message: "It contains password hashes and private keys. Treat anything you copy or save from it as a secret.",
    confirmLabel: "Show Configuration",
    tone: "warning",
  }),
  Flush: () => ({ title: "Write the configuration to disk now?", message: "The server saves its configuration file immediately.", confirmLabel: "Save Now", tone: "default" }),
  SetProtoOptions: (p) => ({
    title: <>Change {s(p.Protocol_str) || "protocol"} options?</>,
    message: "Clients using this protocol may need new settings (for example a new WireGuard key) to reconnect.",
    confirmLabel: "Apply", tone: "warning",
  }),
  SetHubAdminOptions: (p) => ({ title: <>Change administration options of “{s(p.HubName_str)}”?</>, message: "These limits apply to the hub’s own administrators.", confirmLabel: "Apply", tone: "warning" }),
  SetHubExtOptions: (p) => ({ title: <>Change extended options of “{s(p.HubName_str)}”?</>, message: "Extended options change how the hub handles traffic and sessions.", confirmLabel: "Apply", tone: "warning" }),
  AddLicenseKey: () => ({ title: "Add the license key?", message: "The server’s edition and limits may change.", confirmLabel: "Add Key", tone: "warning" }),
  DelLicenseKey: () => ({ title: "Remove the license key?", message: "Features and limits granted by this key stop working.", confirmLabel: "Remove Key" }),
  SetEnableEthVLan: () => ({ title: "Change VLAN tagging?", message: "The network adapter is reconfigured. Local bridges on it may drop traffic briefly.", confirmLabel: "Apply", tone: "warning" }),
  Crash: () => ({ title: "Crash the VPN Server process?", message: "This deliberately terminates the server for debugging. Every session is lost.", confirmLabel: "Crash Server", typeToConfirm: "CRASH" }),
  Debug: () => ({ title: "Run a debug command?", message: "Debug commands can change internal state of the server.", confirmLabel: "Run", tone: "warning" }),
};

/** Human confirmation for an RPC. Throws ConfirmCancelled when the user cancels. */
export async function confirmRpc(method: string, params: P, ctx: RpcCtx = {}): Promise<void> {
  const base: ConfirmOptions = DANGER_COPY[method]?.(params, ctx) ?? {
    title: <>Run {method}?</>,
    message: ctx.info?.doc
      ? <>{ctx.info.doc}<Text size="xs" c="dimmed" mt={6}>This operation is disruptive or security-sensitive.</Text></>
      : "This operation is disruptive or security-sensitive.",
    confirmLabel: "Run",
  };
  const ok = await confirmAction({ testId: "confirm", ...base, ...ctx.override });
  if (!ok) throw new ConfirmCancelled();
}

// ---------------------------------------------------------------------------------------------

/**
 * Button that asks before running `onConfirm` (drop-in for the web product's ConfirmButton).
 * Errors thrown by onConfirm are left to the caller (hooks already toast them).
 */
export function ConfirmButton({
  children, title, message, onConfirm, typeToConfirm, color = "red", loading, disabled, variant = "default", size, leftSection,
  confirmLabel, tone, testId, "data-testid": dataTestId,
}: {
  children: ReactNode; title: ReactNode; message?: ReactNode; onConfirm: () => unknown | Promise<unknown>; typeToConfirm?: string;
  color?: string; loading?: boolean; disabled?: boolean; variant?: ButtonProps["variant"]; size?: ButtonProps["size"]; leftSection?: ReactNode;
  confirmLabel?: string; tone?: ConfirmTone; testId?: string; "data-testid"?: string;
}) {
  const tid = testId ?? dataTestId;
  const [busy, setBusy] = useState(false);
  return (
    <Button
      color={variant === "default" ? undefined : color}
      c={variant === "default" && color === "red" ? "var(--sem-red)" : undefined}
      variant={variant} size={size} loading={loading || busy} disabled={disabled} leftSection={leftSection} data-testid={tid}
      onClick={async () => {
        const ok = await confirmAction({ title, message, typeToConfirm, confirmLabel: confirmLabel ?? (typeof children === "string" ? children : "Confirm"), tone: tone ?? (color === "red" ? "danger" : "warning"), testId: tid ? tid : undefined });
        if (!ok) return;
        setBusy(true);
        try { await onConfirm(); } catch { /* caller notifies */ } finally { setBusy(false); }
      }}
    >
      {children}
    </Button>
  );
}
