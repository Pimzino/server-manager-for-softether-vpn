// Password prompt for connections whose password isn't saved ("locked"). Used as a dialog (sidebar,
// Unlock… buttons) and inline in the page area of a locked server.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Group, PasswordInput } from "@mantine/core";
import { IconLock } from "@tabler/icons-react";
import { post, put } from "../lib/api";
import { notifyError, notifySuccess, useServer } from "../lib/hooks";
import { isMac, secretStore } from "../lib/platform";
import type { Server } from "../lib/types";
import { ErrorState, Sheet } from "../design";

function useUnlock(server: Server | undefined, onDone?: () => void) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    if (!server) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/api/servers/${server.id}/unlock`, { password });
      if (save) {
        await put(`/api/servers/${server.id}`, {
          name: server.name, host: server.host, port: server.port, hub: server.hub, password, savePassword: true,
          transport: server.transport, tlsMode: server.tlsMode, fingerprint: server.fingerprint, tags: server.tags, notes: server.notes,
        }).catch((e) => notifyError(e, "Unlocked, but the password couldn’t be saved"));
      }
      await qc.invalidateQueries();
      notifySuccess(`${server.name} is unlocked${save ? " and the password is saved" : " for this session"}`);
      setPassword("");
      onDone?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { password, setPassword, save, setSave, busy, error, submit };
}

/** Inline form (layout "page") or dialog body (layout "dialog"). */
export function UnlockForm({ server, layout, onDone }: { server: Server; layout: "page" | "dialog"; onDone?: () => void }) {
  const u = useUnlock(server, onDone);
  const store = secretStore();
  const form = (
    <form onSubmit={(e) => { e.preventDefault(); void u.submit(); }} className="sem-unlock-form" data-testid="unlock-form">
      <PasswordInput
        label={server.hub ? `Administrator password of hub ${server.hub}` : "Administrator password"}
        value={u.password} onChange={(e) => u.setPassword(e.currentTarget.value)} data-autofocus autoFocus={layout === "page"}
        autoComplete="current-password" data-testid="unlock-password"
      />
      <Checkbox mt={10} label={store.saveLabel} checked={u.save} onChange={(e) => u.setSave(e.currentTarget.checked)} data-testid="unlock-save" />
      {!!u.error && <div style={{ marginTop: 12 }}><ErrorState error={u.error} inline /></div>}
      <Group justify="flex-end" mt={16} gap={8}>
        {layout === "dialog" && <Button variant="default" onClick={onDone}>Cancel</Button>}
        <Button type="submit" loading={u.busy} data-testid="unlock-submit">Unlock</Button>
      </Group>
    </form>
  );
  if (layout === "dialog") return form;
  return (
    <div className="sem-unlock-page">
      <div className="sem-unlock-icon"><IconLock size={26} stroke={1.5} /></div>
      <h2 className="sem-unlock-title">{server.name} is locked</h2>
      <p className="sem-unlock-text">
        The password for {server.host}:{server.port} isn’t saved on this {isMac() ? "Mac" : "computer"}. Enter it to manage this server; it’s kept in memory until you quit.
      </p>
      {form}
    </div>
  );
}

export function UnlockDialog({ serverId, onClose }: { serverId: number | null; onClose: () => void }) {
  const server = useServer(serverId ?? undefined);
  const [shown, setShown] = useState<Server | undefined>();
  useEffect(() => { if (server.data) setShown(server.data); }, [server.data]);
  const s = serverId !== null ? server.data ?? shown : shown;
  return (
    <Sheet
      opened={serverId !== null && !!s}
      onClose={onClose}
      title={s ? <>Unlock “{s.name}”</> : "Unlock"}
      subtitle={s ? `${s.host}:${s.port}` : undefined}
      icon={<IconLock size={20} stroke={1.6} />}
      size={420}
      testId="unlock-dialog"
    >
      {s && <UnlockForm server={s} layout="dialog" onDone={onClose} />}
    </Sheet>
  );
}
