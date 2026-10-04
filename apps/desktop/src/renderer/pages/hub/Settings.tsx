// Hub › Properties. Online state, session limit and enumeration of a Virtual Hub (GetHub / SetHub), the hub
// administrator password, and Delete Hub. Ported from apps/web/src/pages/hub/Settings.tsx.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button, NumberInput, PasswordInput, Switch } from "@mantine/core";
import { IconKey, IconTrash } from "@tabler/icons-react";
import { post, put } from "../../lib/api";
import { notifyError, useRpc, useRpcMutation } from "../../lib/hooks";
import { serverBase } from "../../sections";
import { useDocs } from "../../components/domain/hooks";
import { HUB_TYPE_LABELS } from "../../components/domain/util";
import { SaveBar } from "../../components/domain/ui";
import { confirmAction, CopyField, FormRow, FormSection, PageHeader, PropertySkeleton, QueryState, StatusBadge, Tag } from "../../design";
import { HubUnreachable, sameJson, useHubPage } from "./_hub-core/shared";

interface HubConfig {
  HubName_str: string;
  AdminPasswordPlainText_str?: string;
  HashedPassword_bin?: string;
  SecurePassword_bin?: string;
  Online_bool: boolean;
  MaxSession_u32: number;
  NoEnum_bool: boolean;
  HubType_u32: number;
  [k: string]: unknown;
}

interface Form { Online_bool: boolean; MaxSession_u32: number; NoEnum_bool: boolean }

/**
 * SetHub payload from the GetHub result, overwriting only the edited fields. GetHub returns zero-filled password
 * hashes; leaving them out (and the plain-text password empty) keeps the current hub password.
 */
function buildPayload(base: HubConfig, patch: Partial<HubConfig>): HubConfig {
  const p: HubConfig = { ...base, ...patch };
  delete p.HashedPassword_bin;
  delete p.SecurePassword_bin;
  if (!patch.AdminPasswordPlainText_str) p.AdminPasswordPlainText_str = "";
  return p;
}

const MIN_PASSWORD = 8;

export default function HubPropertiesPage() {
  const { serverId, hub, hubAdminMode, ready, server } = useHubPage();
  const nav = useNavigate();
  const doc = useDocs("VpnRpcCreateHub");
  const q = useRpc<HubConfig>(serverId, "GetHub", { HubName_str: hub }, { enabled: ready });
  const initial = useMemo<Form | null>(() => q.data ? {
    Online_bool: !!q.data.Online_bool, MaxSession_u32: Number(q.data.MaxSession_u32 ?? 0), NoEnum_bool: !!q.data.NoEnum_bool,
  } : null, [q.data]);
  const [form, setForm] = useState<Form | null>(null);
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  useEffect(() => setForm(initial), [initial]);
  const save = useRpcMutation(serverId, "SetHub", { success: "Virtual Hub properties saved" });
  const qc = useQueryClient();
  // In hub admin mode this connection logs in with the hub administrator password, so changing it on the server
  // would lock the app out: ask first, then store the new password in the connection (like Admin Password does).
  const setPw = useRpcMutation<HubConfig>(serverId, "SetHub", {
    success: "Hub administrator password changed",
    confirm: hubAdminMode ? {
      title: <>Change the administrator password of “{hub}”?</>,
      message: "This connection signs in with the hub administrator password. After the change, this app uses the new password for it. Other tools and connections that use the current password need the new one.",
      confirmLabel: "Change Password", tone: "warning", testId: "hub-admin-password-confirm-change",
    } : undefined,
    onSuccess: async (_r, p) => {
      setPw1(""); setPw2("");
      if (!hubAdminMode) return;
      try {
        await put(`/api/servers/${serverId}`, { password: p.AdminPasswordPlainText_str });
        await post(`/api/servers/${serverId}/refresh`).catch(() => undefined);
      } catch (e) {
        notifyError(e, "The hub password changed, but this app couldn’t store it. Edit the connection and enter the new password.");
      }
      void qc.invalidateQueries({ queryKey: ["server", serverId] });
      void qc.invalidateQueries({ queryKey: ["servers"] });
    },
  });
  const del = useRpcMutation(serverId, "DeleteHub", { success: `Virtual Hub “${hub}” deleted`, onSuccess: () => nav(`${serverBase(serverId)}/hubs`) });

  if (!server.data) return null;
  const dirty = !!form && !!initial && !sameJson(form, initial);
  const clustered = (q.data?.HubType_u32 ?? 0) !== 0;
  const pwShort = pw1.length > 0 && pw1.length < MIN_PASSWORD;
  const pwMismatch = pw2.length > 0 && pw1 !== pw2;

  const onSave = async () => {
    if (!form || !q.data) return;
    // Going offline drops every session: say so before applying.
    if (initial?.Online_bool && !form.Online_bool) {
      const ok = await confirmAction({
        title: <>Take “{hub}” offline?</>,
        message: "The hub refuses every VPN connection while it’s offline, and all connected sessions are disconnected now.",
        confirmLabel: "Save and Take Offline", tone: "warning", testId: "hub-offline-confirm",
      });
      if (!ok) return;
    }
    save.mutate(buildPayload(q.data, { ...form }));
  };

  return (
    <>
      <PageHeader
        title="Properties"
        meta={q.data ? <>
          <StatusBadge status={q.data.Online_bool ? "ok" : "off"}>{q.data.Online_bool ? "Online" : "Offline"}</StatusBadge>
          <span className="sem-dim">·</span><span>{HUB_TYPE_LABELS[q.data.HubType_u32] ?? `Type ${q.data.HubType_u32}`} hub</span>
        </> : undefined}
        description="Changes apply to the Virtual Hub as soon as you save them."
      />
      {!ready ? <HubUnreachable serverId={serverId} /> : (
        <QueryState query={q} skeleton={<PropertySkeleton rows={6} />}>
          {q.data && form && (
            <>
              <FormSection title="General" testId="hub-settings-form">
                <FormRow label="Name" description="A Virtual Hub can’t be renamed.">
                  <CopyField value={q.data.HubName_str} mono={false} />
                </FormRow>
                <FormRow label="Online" description="An offline hub refuses VPN connections. Taking it offline disconnects every session.">
                  <Switch checked={form.Online_bool} onChange={(e) => setForm({ ...form, Online_bool: e.currentTarget.checked })}
                    aria-label="Online" data-testid="hub-online-switch" />
                </FormRow>
                <FormRow label="Maximum sessions" description={<>{doc("MaxSession_u32", "Maximum number of VPN sessions")}. 0 means no limit. Sessions the server creates itself (SecureNAT, local bridges, cascades) don’t count.</>}>
                  {(id) => (
                    <NumberInput id={id} w={160} min={0} max={4294967295} allowDecimal={false} allowNegative={false} thousandSeparator=","
                      value={form.MaxSession_u32} onChange={(v) => setForm({ ...form, MaxSession_u32: Number(v) || 0 })} data-testid="hub-max-sessions" />
                  )}
                </FormRow>
                <FormRow label="Hide from hub list" description="SoftEther VPN Client can’t list this hub, so users must type its name.">
                  <Switch checked={form.NoEnum_bool} onChange={(e) => setForm({ ...form, NoEnum_bool: e.currentTarget.checked })}
                    aria-label="Hide from hub list" data-testid="hub-noenum-switch" />
                </FormRow>
                <FormRow label="Type" description={clustered
                  ? "Static hubs run on every cluster member; dynamic hubs are created on members on demand. The type is fixed when the hub is created."
                  : "Static and dynamic hub types exist only on a cluster controller."}>
                  <Tag testId="hub-type">{HUB_TYPE_LABELS[q.data.HubType_u32] ?? q.data.HubType_u32}</Tag>
                </FormRow>
              </FormSection>

              <FormSection
                title="Hub administrator password"
                description={hubAdminMode
                  ? "This connection signs in with this password. Setting a new one replaces it on the server and in this app."
                  : "Lets someone manage only this hub: they connect with the hub name and this password. Setting a new one replaces the current password."}
                testId="hub-admin-password-section"
                footer={(
                  <div className="sem-row-inline" style={{ justifyContent: "flex-end", width: "100%" }}>
                    <Button leftSection={<IconKey size={14} />} loading={setPw.isPending} disabled={!pw1 || pw1 !== pw2 || pwShort}
                      onClick={() => setPw.mutate(buildPayload(q.data!, { AdminPasswordPlainText_str: pw1 }))}
                      data-testid="hub-admin-password-save">Set Password</Button>
                  </div>
                )}
              >
                <form onSubmit={(e) => { e.preventDefault(); if (pw1 && pw1 === pw2 && !pwShort) setPw.mutate(buildPayload(q.data!, { AdminPasswordPlainText_str: pw1 })); }}>
                  <FormRow label="New password" error={pwShort ? `Use at least ${MIN_PASSWORD} characters.` : undefined}>
                    {(id) => <PasswordInput id={id} w={280} value={pw1} onChange={(e) => setPw1(e.currentTarget.value)} autoComplete="new-password" data-testid="hub-admin-password" />}
                  </FormRow>
                  <FormRow label="Confirm password" error={pwMismatch ? "The passwords don’t match." : undefined}>
                    {(id) => <PasswordInput id={id} w={280} value={pw2} onChange={(e) => setPw2(e.currentTarget.value)} autoComplete="new-password" data-testid="hub-admin-password-confirm" />}
                  </FormRow>
                  <button type="submit" hidden aria-hidden tabIndex={-1} />
                </form>
              </FormSection>

              {!hubAdminMode && (
                <FormSection title="Delete Virtual Hub" testId="hub-delete-section">
                  <FormRow
                    label="Delete this hub"
                    description="Disconnects every session and permanently removes the hub’s users, groups, access lists, certificates, cascades, SecureNAT and log settings."
                  >
                    <Button variant="default" c="var(--sem-red)" leftSection={<IconTrash size={14} />} loading={del.isPending}
                      onClick={() => del.mutate({ HubName_str: hub })} data-testid="delete-hub">Delete Hub…</Button>
                  </FormRow>
                </FormSection>
              )}
              <SaveBar dirty={dirty} saving={save.isPending} onReset={() => setForm(initial)} onSave={() => void onSave()} testId="hub-settings-save" />
            </>
          )}
        </QueryState>
      )}
    </>
  );
}
