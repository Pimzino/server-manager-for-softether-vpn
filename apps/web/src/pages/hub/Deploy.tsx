import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActionIcon, Alert, Anchor, Badge, Button, Code, Group, Menu, Modal, NumberInput, ScrollArea, Select, SimpleGrid, Switch, Text, TextInput, Tooltip,
} from "@mantine/core";
import {
  IconBrandWindows, IconChevronDown, IconDownload, IconEye, IconFileCertificate, IconPackage, IconDeviceFloppy, IconInfoCircle,
} from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ErrorAlert, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { ApiError, get, post, put } from "../../lib/api";
import { ago, bytes } from "../../lib/format";
import { can, notifyError, useScope, useServer } from "../../lib/hooks";
import {
  BuildResultModal, downloadBuild, KIND_LABEL, PolicyBadge, POLICY_LABEL, useTemplates,
  type BuiltPackage, type HubDetail, type HubUser,
} from "../../components/deploy/hubdeploy";

function useHubDetail(serverId: number, hub: string) {
  return useQuery({ queryKey: ["deploy", "hub", serverId, hub], queryFn: () => get<HubDetail>(`/api/deploy/hubs/${serverId}/${encodeURIComponent(hub)}`) });
}

function ProfileSettings({ serverId, hub, detail, canWrite }: { serverId: number; hub: string; detail: HubDetail; canWrite: boolean }) {
  const qc = useQueryClient();
  const templates = useTemplates();
  const o = detail.profile.overrides;
  const [templateId, setTemplateId] = useState<string | null>(o.templateId ? String(o.templateId) : null);
  const [host, setHost] = useState(o.publicHost ?? "");
  const [port, setPort] = useState<number | string>(o.publicPort ?? "");
  const [accountName, setAccountName] = useState(o.accountName ?? "");
  const [enabled, setEnabled] = useState(detail.profile.enabled);
  useEffect(() => {
    setTemplateId(o.templateId ? String(o.templateId) : null); setHost(o.publicHost ?? ""); setPort(o.publicPort ?? "");
    setAccountName(o.accountName ?? ""); setEnabled(detail.profile.enabled);
  }, [detail]);
  const save = useMutation({
    mutationFn: () => put(`/api/deploy/hubs/${serverId}/${encodeURIComponent(hub)}`, {
      templateId: templateId ? Number(templateId) : null, publicHost: host.trim() || null, publicPort: port === "" ? null : Number(port),
      accountName: accountName.trim() || null, enabled,
    }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["deploy"] }),
    onError: (e) => notifyError(e, "Save failed"),
  });
  const defaultT = templates.data?.find((t) => t.isDefault);
  return (
    <Section title="Connection profile" description="Every user of this hub gets a profile built from this template and endpoint. Leave fields empty to inherit from the template (and the server's address).">
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Select label="Template" data-testid="hub-template"
          data={(templates.data ?? []).map((t) => ({ value: String(t.id), label: `${t.name}${t.isDefault ? " (default)" : ""}` }))}
          value={templateId} onChange={setTemplateId} clearable placeholder={`Default${defaultT ? `: ${defaultT.name}` : ""}`} disabled={!canWrite}
          description={<>Branding, credentials and installer behaviour. <Anchor component={Link} to="/deploy/templates" size="xs">Manage templates</Anchor></>} />
        <TextInput label="Connection name shown to users" placeholder={detail.profile.accountName} value={accountName}
          onChange={(e) => setAccountName(e.currentTarget.value)} disabled={!canWrite} description="Default comes from the template's name pattern" />
        <TextInput label="Public host clients connect to" placeholder={detail.profile.host} value={host} onChange={(e) => setHost(e.currentTarget.value)}
          disabled={!canWrite} description="Often differs from the management address (e.g. vpn.example.com)" data-testid="hub-public-host" />
        <NumberInput label="Public port" placeholder={String(detail.profile.port)} value={port} onChange={setPort} min={1} max={65535}
          allowDecimal={false} disabled={!canWrite} />
      </SimpleGrid>
      <Group justify="space-between" mt="md">
        <Switch label="Client deployment enabled for this hub" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} disabled={!canWrite} />
        {canWrite && <Button leftSection={<IconDeviceFloppy size={16} />} loading={save.isPending} onClick={() => save.mutate()} data-testid="hub-profile-save">Save</Button>}
      </Group>
      <Group gap="xs" mt="sm">
        <Text size="sm" c="dimmed">Effective:</Text>
        <Code>{detail.profile.accountName}</Code><Text size="sm" c="dimmed">→</Text><Code>{detail.profile.host}:{detail.profile.port}</Code>
        <Text size="sm" c="dimmed">template</Text><Badge variant="light">{detail.profile.template.name}</Badge>
        <Text size="sm" c="dimmed">password users:</Text><PolicyBadge value={detail.credentialPolicy} />
      </Group>
    </Section>
  );
}

function PreviewModal({ serverId, hub, user, onClose }: { serverId: number; hub: string; user: string | null | undefined; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["deploy", "preview", serverId, hub, user],
    queryFn: () => get<{ content: string; credential: string; warnings: string[]; accountName: string; template: string }>(
      `/api/deploy/hubs/${serverId}/${encodeURIComponent(hub)}/preview${user ? `?user=${encodeURIComponent(user)}` : ""}`),
    enabled: user !== undefined,
  });
  return (
    <Modal opened={user !== undefined} onClose={onClose} title={`Profile preview — ${user ?? "hub (user enters credentials)"}`} size="xl" centered>
      <QueryState query={q}>
        {q.data && (
          <>
            <Group mb="sm"><PolicyBadge value={q.data.credential} /><Text size="sm" c="dimmed">template {q.data.template}</Text></Group>
            {q.data.warnings.map((w) => <Alert key={w} color="yellow" mb="xs">{w}</Alert>)}
            <ScrollArea.Autosize mah={480}><Code block data-testid="preview-content">{q.data.content}</Code></ScrollArea.Autosize>
          </>
        )}
      </QueryState>
    </Modal>
  );
}

export default function HubDeployPage() {
  const { serverId, hub } = useScope();
  const server = useServer(serverId);
  const role = server.data?.hubRoles?.[hub!] ?? server.data?.myRole;
  const canWrite = can(role, "operator");
  const qc = useQueryClient();
  const detail = useHubDetail(serverId, hub!);
  const [result, setResult] = useState<BuiltPackage | null>(null);
  const [preview, setPreview] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);

  const build = async (user: string | null, kind: "vpn" | "msi" | "exe") => {
    setBusy(`${user ?? ""}:${kind}`);
    try {
      const r = await post<BuiltPackage>(`/api/deploy/hubs/${serverId}/${encodeURIComponent(hub!)}/packages`, { user, kind });
      setResult(r);
      void qc.invalidateQueries({ queryKey: ["deploy", "hub", serverId, hub] });
    } catch (e) {
      notifyError(e, e instanceof ApiError && e.status === 409 ? "Cannot build yet" : "Build failed");
    } finally {
      setBusy(null);
    }
  };

  const BuildMenu = ({ user, disabled }: { user: string | null; disabled?: boolean }) => (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <Button size="xs" variant="light" rightSection={<IconChevronDown size={14} />} disabled={disabled || !canWrite}
          loading={!!busy && busy.startsWith(`${user ?? ""}:`)} data-testid={`build-${user ?? "hub"}`}>Build</Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={<IconFileCertificate size={16} />} onClick={() => void build(user, "vpn")} data-testid={`build-vpn-${user ?? "hub"}`}>.vpn connection profile</Menu.Item>
        <Menu.Item leftSection={<IconPackage size={16} />} onClick={() => void build(user, "msi")} data-testid={`build-msi-${user ?? "hub"}`}>MSI installer (Intune / GPO)</Menu.Item>
        <Menu.Item leftSection={<IconBrandWindows size={16} />} onClick={() => void build(user, "exe")} data-testid={`build-exe-${user ?? "hub"}`}>setup.exe (double-click install)</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );

  return (
    <>
      <PageHeader title="Client deployment"
        description="Connection profiles for this hub are always live: every user below has one automatically. Build a .vpn file, MSI or branded setup.exe on request and send it to the user." />
      {!canWrite && role && <ReadOnlyNotice role={role} />}
      <QueryState query={detail}>
        {detail.data && (
          <>
            <ProfileSettings serverId={serverId} hub={hub!} detail={detail.data} canWrite={canWrite} />
            {detail.data.credentialPolicy === "embed-hash" && !can(server.data?.myRole, "admin") && (
              <Alert color="yellow" icon={<IconInfoCircle size={16} />} mb="md">
                This template embeds users' existing password hashes, which requires the admin role on this server. Use a template with the
                "new password", "at install" or "user enters" policy to issue packages as an operator.
              </Alert>
            )}
            <Section title="Hub-wide package" description="One profile for everyone: the user enters their own user name and password in the client."
              actions={<Group gap="xs">
                <Button size="xs" variant="subtle" leftSection={<IconEye size={14} />} onClick={() => setPreview(null)}>Preview</Button>
                <BuildMenu user={null} disabled={!detail.data.profile.enabled} />
              </Group>}>
              <Text size="sm" c="dimmed">Useful for self-service or shared devices. Per-user packages below connect without typing anything (depending on the credential policy).</Text>
            </Section>
            <Section title={`Users (${detail.data.users.length})`} description={<>Credential policy for password users: {POLICY_LABEL[detail.data.credentialPolicy]?.help}</>}>
              <DataTable<HubUser>
                testId="deploy-users-table"
                data={detail.data.users}
                rowKey={(u) => u.name}
                initialSort={{ key: "name", dir: "asc" }}
                columns={[
                  { key: "name", title: "User", render: (u) => <div><Text fw={600} size="sm">{u.name}</Text>{u.realName && <Text size="xs" c="dimmed">{u.realName}</Text>}</div> },
                  { key: "group", title: "Group", render: (u) => u.group || <Text c="dimmed" size="sm">–</Text> },
                  { key: "authLabel", title: "Auth" },
                  {
                    key: "credential", title: "Package credential",
                    render: (u) => u.deployable ? <PolicyBadge value={u.credential} /> : (
                      <Tooltip label={u.reason} multiline w={320}><Badge color="red" variant="light">Not supported</Badge></Tooltip>
                    ),
                  },
                  {
                    key: "lastBuild", title: "Last package", value: (u) => u.lastBuild?.createdAt ?? 0,
                    render: (u) => u.lastBuild ? (
                      <Group gap={4} wrap="nowrap">
                        <Text size="xs">{KIND_LABEL[u.lastBuild.kind]} · {ago(u.lastBuild.createdAt)}</Text>
                        <ActionIcon size="sm" variant="subtle" onClick={() => downloadBuild(u.lastBuild!.id)} aria-label="Download last package"><IconDownload size={14} /></ActionIcon>
                      </Group>
                    ) : <Text size="xs" c="dimmed">–</Text>,
                  },
                  {
                    key: "actions", title: "", sortable: false, align: "right",
                    render: (u) => (
                      <Group gap={6} justify="flex-end" wrap="nowrap">
                        <ActionIcon variant="subtle" onClick={() => setPreview(u.name)} aria-label={`Preview profile for ${u.name}`} disabled={!u.deployable}><IconEye size={16} /></ActionIcon>
                        <BuildMenu user={u.name} disabled={!u.deployable || !detail.data!.profile.enabled} />
                      </Group>
                    ),
                  },
                ]}
              />
            </Section>
            <Section title="Recent packages" description="Per-user packages contain credentials and are deleted automatically after the retention period (Settings).">
              <DataTable
                testId="deploy-builds-table"
                data={detail.data.builds}
                rowKey={(b) => b.id}
                initialSort={{ key: "createdAt", dir: "desc" }}
                columns={[
                  { key: "fileName", title: "File", render: (b) => <Text size="sm" ff="monospace">{b.fileName}</Text> },
                  { key: "kind", title: "Type", render: (b) => KIND_LABEL[b.kind] },
                  { key: "username", title: "User", render: (b) => b.username ?? <Text size="sm" c="dimmed">hub-wide</Text> },
                  { key: "productVersion", title: "Version", render: (b) => b.productVersion || "–" },
                  { key: "size", title: "Size", align: "right", render: (b) => bytes(b.size) },
                  { key: "createdBy", title: "Built by" },
                  { key: "createdAt", title: "Built", render: (b) => ago(b.createdAt) },
                  { key: "dl", title: "", sortable: false, align: "right", render: (b) => (
                    <ActionIcon variant="subtle" onClick={() => downloadBuild(b.id)} aria-label={`Download ${b.fileName}`}><IconDownload size={16} /></ActionIcon>
                  ) },
                ]}
              />
            </Section>
          </>
        )}
      </QueryState>
      {detail.error instanceof ApiError && detail.error.status === 403 && <ErrorAlert error={detail.error} />}
      <PreviewModal serverId={serverId} hub={hub!} user={preview} onClose={() => setPreview(undefined)} />
      <BuildResultModal result={result} onClose={() => setResult(null)} />
    </>
  );
}
