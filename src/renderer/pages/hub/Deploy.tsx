// Virtual Hub › Client Deployment: the hub's live connection profile (template, public endpoint, name),
// a hub-wide package, one package per user (.vpn, MSI, setup.exe) and the packages built recently.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ActionIcon, Button, Menu, NumberInput, Select, TextInput, Tooltip } from "@mantine/core";
import {
  IconBrandWindows, IconChevronDown, IconCopy, IconDownload, IconEye, IconFileCertificate, IconHammer, IconPackage, IconPackageExport, IconPalette, IconUsers,
} from "@tabler/icons-react";
import { ApiError, get, post, put } from "../../lib/api";
import { agoShort, bytes, dt, num } from "../../lib/format";
import { notifyError, notifySuccess, useScope } from "../../lib/hooks";
import { deployBase } from "../../sections";
import {
  DataTable, ErrorState, FormActions, FormRow, FormSection, Mono, PageHeader, PropertySkeleton, Section, Sheet, Tag, type ContextMenuItem,
} from "../../design";
import {
  BuildResultSheet, downloadBuild, KIND_LABEL, PolicyBadge, POLICY_LABEL, useTemplates, type BuiltPackage, type HubBuild, type HubDetail, type HubUser,
} from "../../components/domain/hubdeploy";
import { Callout } from "../../components/domain/ui";
import { CodeBlock, InlineFacts, SheetFooter, SwitchRow, invalidateDeploy, useCapabilities, type Capabilities } from "../deploy/_deployment/shared";

type Kind = "vpn" | "msi" | "exe";
interface Preview { content: string; credential: string; warnings: string[]; accountName: string; template: string }

const hubPath = (serverId: number, hub: string) => `/api/deploy/hubs/${serverId}/${encodeURIComponent(hub)}`;

function saveFailed(e: unknown) {
  notifyError(e, "Couldn’t save the file");
}

// ------------------------------------------------------------------ connection profile form

function ProfileForm({ serverId, hub, detail }: { serverId: number; hub: string; detail: HubDetail }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const templates = useTemplates();
  const o = detail.profile.overrides;
  const initial = useMemo(() => ({
    templateId: o.templateId ? String(o.templateId) : null as string | null,
    host: o.publicHost ?? "", port: (o.publicPort ?? "") as number | string, accountName: o.accountName ?? "", enabled: detail.profile.enabled,
  }), [detail]);
  const [f, setF] = useState(initial);
  useEffect(() => setF(initial), [initial]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((c) => ({ ...c, [k]: v }));
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);

  const errors: Record<string, string> = {};
  if (/\s/.test(f.host.trim())) errors.host = "A host name can’t contain spaces.";
  if (f.port !== "" && !(Number(f.port) >= 1 && Number(f.port) <= 65535)) errors.port = "Enter a port from 1 to 65535.";
  if (/["`\x00-\x1f‘-‛]/.test(f.accountName)) errors.accountName = "Quotes and control characters aren’t allowed.";
  const valid = Object.keys(errors).length === 0;

  const save = useMutation({
    mutationFn: () => put(hubPath(serverId, hub), {
      templateId: f.templateId ? Number(f.templateId) : null, publicHost: f.host.trim() || null,
      publicPort: f.port === "" ? null : Number(f.port), accountName: f.accountName.trim() || null, enabled: f.enabled,
    }),
    onSuccess: () => { notifySuccess("Connection profile saved"); void invalidateDeploy(qc); },
    onError: (e) => notifyError(e, "Couldn’t save the connection profile"),
  });
  const defaultT = templates.data?.find((t) => t.isDefault);

  return (
    <>
      <FormSection
        title="Connection profile"
        description="Every user of this hub gets a profile built from this template and endpoint. Empty fields inherit from the template and the server’s address."
        testId="hub-profile-form"
      >
        <FormRow label="Template" description={<>Credentials, installer behaviour and branding. <a href={`#${deployBase}/templates`} onClick={(e) => { e.preventDefault(); nav(`${deployBase}/templates`); }}>Manage templates</a></>}>
          {(id) => (
            <Select
              id={id} data-testid="hub-template" clearable w={300}
              data={(templates.data ?? []).map((t) => ({ value: String(t.id), label: `${t.name}${t.isDefault ? " (default)" : ""}` }))}
              value={f.templateId} onChange={(v) => set("templateId", v)} placeholder={`Default${defaultT ? `: ${defaultT.name}` : ""}`}
            />
          )}
        </FormRow>
        <FormRow label="Connection name" description="Shown to users in the VPN Client Manager." error={errors.accountName}>
          {(id) => <TextInput id={id} w={300} placeholder={detail.profile.accountName} value={f.accountName} onChange={(e) => set("accountName", e.currentTarget.value)} data-testid="hub-account-name" />}
        </FormRow>
        <FormRow label="Public host" description="The address clients connect to, often different from the one this app uses." error={errors.host}>
          {(id) => <TextInput id={id} w={300} placeholder={detail.profile.host} value={f.host} onChange={(e) => set("host", e.currentTarget.value)} data-testid="hub-public-host" />}
        </FormRow>
        <FormRow label="Public port" error={errors.port}>
          {(id) => <NumberInput id={id} w={120} placeholder={String(detail.profile.port)} value={f.port} onChange={(v) => set("port", v)} min={1} max={65535} allowDecimal={false} data-testid="hub-public-port" />}
        </FormRow>
        <SwitchRow label="Client deployment" description="When off, no packages can be built for this hub." checked={f.enabled} onChange={(v) => set("enabled", v)} testId="hub-deploy-enabled" />
      </FormSection>
      <FormActions dirty={dirty} valid={valid} saving={save.isPending} onSave={() => save.mutate()} onDiscard={() => setF(initial)} testId="hub-profile" />
    </>
  );
}

// ------------------------------------------------------------------ preview

function PreviewSheet({ serverId, hub, user, onClose }: { serverId: number; hub: string; user: string | null | undefined; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["deploy", "preview", serverId, hub, user],
    queryFn: () => get<Preview>(`${hubPath(serverId, hub)}/preview${user ? `?user=${encodeURIComponent(user)}` : ""}`),
    enabled: user !== undefined,
  });
  return (
    <Sheet
      opened={user !== undefined} onClose={onClose} size={760} testId="preview-sheet"
      icon={<IconEye size={19} stroke={1.5} />}
      title={user ? `Profile for “${user}”` : "Hub-wide profile"}
      subtitle={user ? `${hub} · generated for this user` : `${hub} · the user enters their own credentials`}
      footer={<SheetFooter><Button onClick={onClose}>Done</Button></SheetFooter>}
    >
      {q.error ? <ErrorState error={q.error} inline onRetry={() => void q.refetch()} /> : !q.data ? <PropertySkeleton rows={3} /> : (
        <div className="sem-stack">
          <InlineFacts items={[["Credential", <PolicyBadge key="p" value={q.data.credential} />], ["Template", q.data.template], ["Connection", <Mono key="a">{q.data.accountName}</Mono>]]} />
          {q.data.warnings.map((w) => <Callout key={w} tone="yellow">{w}</Callout>)}
          <CodeBlock text={q.data.content.replace(/\r\n/g, "\n")} maxHeight="52vh" testId="preview-content" />
          <div className="sem-dim">Password hashes aren’t shown here; they’re embedded when the package is built.</div>
        </div>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ page

export default function HubDeployPage() {
  const { serverId, hub: hubParam } = useScope();
  const hub = hubParam!;
  const qc = useQueryClient();
  const nav = useNavigate();
  const detail = useQuery({ queryKey: ["deploy", "hub", serverId, hub], queryFn: () => get<HubDetail>(hubPath(serverId, hub)) });
  const caps = useCapabilities();
  const [result, setResult] = useState<BuiltPackage | null>(null);
  const [preview, setPreview] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const d = detail.data;
  const enabled = !!d?.profile.enabled;

  const build = async (user: string | null, kind: Kind) => {
    setBusy(`${user ?? ""}:${kind}`);
    try {
      const r = await post<BuiltPackage>(`${hubPath(serverId, hub)}/packages`, { user, kind });
      setResult(r);
      void qc.invalidateQueries({ queryKey: ["deploy"] });
    } catch (e) {
      notifyError(e, e instanceof ApiError && e.status === 409 ? "Can’t build yet" : e instanceof ApiError && e.status === 503 ? "MSI tools are missing" : "Build failed");
    } finally {
      setBusy(null);
    }
  };
  const save = async (id: number) => {
    try {
      const r = await downloadBuild(id);
      if (r.saved) notifySuccess(`Saved ${r.filePath?.split(/[\\/]/).pop() ?? "package"}`);
    } catch (e) { saveFailed(e); }
  };

  const kindItems = (): { kind: Kind; label: string; icon: ReactNode; off?: string }[] => {
    const c: Capabilities | undefined = caps.data;
    const noMsi = c && !c.msi.available ? c.msi.hint : undefined;
    const noExe = c && !c.setupExe.available ? c.setupExe.hint : undefined;
    return [
      { kind: "vpn", label: ".vpn Connection Profile", icon: <IconFileCertificate size={14} /> },
      { kind: "msi", label: "MSI Installer (Intune, GPO)", icon: <IconPackage size={14} />, off: noMsi },
      { kind: "exe", label: "setup.exe (Double-Click Install)", icon: <IconBrandWindows size={14} />, off: noExe },
    ];
  };

  const BuildMenu = ({ user, disabled, variant = "subtle" }: { user: string | null; disabled?: boolean; variant?: "subtle" | "default" | "filled" }) => {
    const id = user ?? "hub";
    return (
      <Menu position="bottom-end" withinPortal shadow="md">
        <Menu.Target>
          <Button
            size={variant === "subtle" ? "xs" : "sm"} variant={variant} rightSection={<IconChevronDown size={12} />}
            leftSection={variant === "subtle" ? undefined : <IconHammer size={14} />}
            disabled={disabled} loading={!!busy && busy.startsWith(`${user ?? ""}:`)} data-testid={`build-${id}`}
            onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
          >{variant === "subtle" ? "Build" : "Build Hub Package"}</Button>
        </Menu.Target>
        <Menu.Dropdown>
          {kindItems().map((k) => (
            <Tooltip key={k.kind} label={k.off} disabled={!k.off} multiline maw={320} position="left">
              <div>
                <Menu.Item leftSection={k.icon} disabled={!!k.off} onClick={() => void build(user, k.kind)} data-testid={`build-${k.kind}-${id}`}>{k.label}</Menu.Item>
              </div>
            </Tooltip>
          ))}
        </Menu.Dropdown>
      </Menu>
    );
  };

  const userMenu = (u: HubUser): ContextMenuItem[] => {
    const off = !u.deployable || !enabled;
    const c = caps.data;
    return [
      { label: "Preview Profile…", icon: <IconEye size={14} />, disabled: !u.deployable, onClick: () => setPreview(u.name), testId: "ctx-preview" },
      "divider",
      { label: "Build .vpn Profile", icon: <IconFileCertificate size={14} />, disabled: off, onClick: () => void build(u.name, "vpn"), testId: "ctx-build-vpn" },
      { label: "Build MSI Installer", icon: <IconPackage size={14} />, disabled: off || (c ? !c.msi.available : false), onClick: () => void build(u.name, "msi") },
      { label: "Build setup.exe", icon: <IconBrandWindows size={14} />, disabled: off || (c ? !c.setupExe.available : false), onClick: () => void build(u.name, "exe") },
      "divider",
      { label: "Save Last Package…", icon: <IconDownload size={14} />, disabled: !u.lastBuild, onClick: () => u.lastBuild && void save(u.lastBuild.id) },
    ];
  };

  return (
    <>
      <PageHeader
        title="Client Deployment"
        meta={d ? (
          <>
            <Mono>{d.profile.accountName}</Mono><span className="sem-dim">→</span><Mono>{d.profile.host}:{d.profile.port}</Mono>
            <span className="sem-dim">·</span>{d.profile.template.name}
            <span className="sem-dim">·</span><PolicyBadge value={d.credentialPolicy} />
          </>
        ) : undefined}
        description="Profiles are always live: every user below has one. Build a .vpn file, MSI or setup.exe on request and send it to the user."
        actions={d && (
          <>
            <Button variant="default" leftSection={<IconEye size={14} />} onClick={() => setPreview(null)} data-testid="preview-hub">Preview…</Button>
            <BuildMenu user={null} disabled={!enabled} variant="filled" />
          </>
        )}
      />

      {detail.error && !d ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} testId="deploy-error" />
      ) : !d ? (
        <FormSection title="Connection profile"><PropertySkeleton rows={5} /></FormSection>
      ) : (
        <>
          <div className="sem-callouts">
            {!enabled && (
              <Callout tone="gray" title="Client deployment is off for this hub." testId="deploy-disabled">
                Turn on Client deployment below to build packages.
              </Callout>
            )}
            {caps.data && !caps.data.msi.available && (
              <Callout tone="yellow" title="MSI and setup.exe builds aren’t available on this computer." testId="deploy-no-msi">
                {caps.data.msi.hint} .vpn profiles still work.
              </Callout>
            )}
          </div>

          <ProfileForm serverId={serverId} hub={hub} detail={d} />

          <Section
            title="Users"
            description={<>Password users: {POLICY_LABEL[d.credentialPolicy]?.label ?? d.credentialPolicy}. {POLICY_LABEL[d.credentialPolicy]?.help}</>}
            actions={<Button size="xs" variant="default" leftSection={<IconUsers size={14} />} onClick={() => nav(`/servers/${serverId}/hubs/${encodeURIComponent(hub)}/users`)}>Manage Users…</Button>}
          >
            <DataTable<HubUser>
              testId="deploy-users-table"
              aria-label="Users"
              data={d.users}
              rowKey={(u) => u.name}
              rowTestId={(u) => `deploy-user-${u.name}`}
              selectable="single"
              initialSort={{ key: "name", dir: "asc" }}
              onRowOpen={(u) => u.deployable && setPreview(u.name)}
              contextMenu={userMenu}
              rowTone={(u) => (u.disabled ? "dim" : undefined)}
              searchable={d.users.length > 8}
              empty={{ title: "No users on this hub", description: "Add users to the hub, then build a package for each of them, or share the hub-wide package.", icon: <IconUsers size={28} stroke={1.4} /> }}
              columns={[
                { key: "name", title: "User", width: 120, truncate: true, render: (u) => <span className="sem-strong">{u.name}</span> },
                { key: "realName", title: "Full name", truncate: true, render: (u) => u.realName || <span className="sem-dim">–</span> },
                { key: "group", title: "Group", width: 96, truncate: true, render: (u) => u.group || <span className="sem-dim">–</span> },
                { key: "authLabel", title: "Authentication", width: 130, truncate: true },
                {
                  key: "credential", title: "Package credential", width: 150,
                  render: (u) => u.deployable ? <PolicyBadge value={u.credential} /> : (
                    <Tooltip label={u.reason} multiline maw={320}><span><Tag color="red">Not supported</Tag></span></Tooltip>
                  ),
                },
                {
                  key: "lastBuild", title: "Last package", width: 170, value: (u) => u.lastBuild?.createdAt ?? 0,
                  render: (u) => u.lastBuild
                    ? (
                      <span className="sem-row-inline" style={{ flexWrap: "nowrap", gap: "var(--sem-space-2)" }}>
                        <span title={dt(u.lastBuild.createdAt)} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{KIND_LABEL[u.lastBuild.kind]} · <span className="sem-dim">{agoShort(u.lastBuild.createdAt)}</span></span>
                        <Tooltip label="Save last package…">
                          <ActionIcon size="sm" variant="subtle" aria-label={`Save the last package for ${u.name}`} data-testid={`save-last-${u.name}`}
                            onClick={(e) => { e.stopPropagation(); void save(u.lastBuild!.id); }} onDoubleClick={(e) => e.stopPropagation()}>
                            <IconDownload size={13} />
                          </ActionIcon>
                        </Tooltip>
                      </span>
                    )
                    : <span className="sem-dim">–</span>,
                },
                {
                  key: "actions", title: "", sortable: false, align: "right", width: 84,
                  render: (u) => <BuildMenu user={u.name} disabled={!u.deployable || !enabled} />,
                },
              ]}
            />
          </Section>

          <Section title="Recent packages" description="Per-user packages contain credentials. They’re deleted automatically after the retention period in Preferences.">
            <DataTable<HubBuild>
              testId="deploy-builds-table"
              aria-label="Recent packages"
              data={d.builds}
              rowKey={(b) => b.id}
              rowTestId={(b) => `deploy-build-${b.id}`}
              selectable="single"
              initialSort={{ key: "createdAt", dir: "desc" }}
              onRowOpen={(b) => void save(b.id)}
              searchable={d.builds.length > 8}
              empty={{ title: "No packages yet", description: "Packages you build for this hub are listed here.", icon: <IconPackageExport size={28} stroke={1.4} /> }}
              contextMenu={(b) => [
                { label: "Save…", icon: <IconDownload size={14} />, onClick: () => void save(b.id), testId: "ctx-save" },
                { label: "Copy SHA-256", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(b.sha256) },
              ]}
              columns={[
                { key: "fileName", title: "File", truncate: true, render: (b) => <Mono>{b.fileName}</Mono> },
                { key: "kind", title: "Type", width: 110, render: (b) => KIND_LABEL[b.kind] ?? b.kind },
                { key: "username", title: "User", width: 120, truncate: true, render: (b) => b.username ?? <span className="sem-dim">Hub-wide</span> },
                { key: "productVersion", title: "Version", width: 80, render: (b) => b.productVersion || <span className="sem-dim">–</span> },
                { key: "size", title: "Size", align: "right", width: 80, render: (b) => <span className="sem-num">{bytes(b.size)}</span> },
                { key: "createdAt", title: "Built", width: 100, render: (b) => <span className="sem-dim" title={`${dt(b.createdAt)} by ${b.createdBy}`}>{agoShort(b.createdAt)}</span> },
              ]}
            />
          </Section>
          <div className="sem-dim" style={{ marginTop: "var(--sem-space-5)" }}>
            {num(d.users.length)} users · {num(d.users.filter((u) => u.deployable).length)} can get a package. Templates decide what a package contains:{" "}
            <a href={`#${deployBase}/templates`} onClick={(e) => { e.preventDefault(); nav(`${deployBase}/templates`); }}><IconPalette size={12} style={{ verticalAlign: -1 }} /> Templates & Branding</a>
          </div>
        </>
      )}
      <PreviewSheet serverId={serverId} hub={hub} user={preview} onClose={() => setPreview(undefined)} />
      <BuildResultSheet result={result} onClose={() => setResult(null)} />
    </>
  );
}
