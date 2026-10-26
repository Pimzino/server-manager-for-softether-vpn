// Source list: global places, then every saved connection (expandable into its Virtual Hubs).
import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Tooltip, UnstyledButton } from "@mantine/core";
import {
  IconChevronRight, IconLayoutDashboard, IconLayoutSidebar, IconLock, IconLockOpen, IconPackageExport, IconPencil, IconPlus,
  IconRefresh, IconServer2, IconSettings, IconStack2, IconTrash, IconCopy, IconPlayerPlay,
} from "@tabler/icons-react";
import { del, post } from "../lib/api";
import { notifyError, notifySuccess, useServers } from "../lib/hooks";
import type { HubListItem, Server } from "../lib/types";
import { hubBase, serverBase } from "../sections";
import { confirmAction } from "./ConfirmDialog";
import { useContextMenu } from "./ContextMenu";
import { serverStatus, StatusDot } from "./Status";
import { useShell } from "./shellContext";
import { ToolbarButton } from "./Toolbar";
import { Shortcut } from "./Layout";
import appIcon from "../assets/app-icon.png";

const EXPANDED_KEY = "sem.sidebar.expanded";
function loadExpanded(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "{}"); } catch { return {}; }
}

function SidebarItem({ to, icon, label, end, testId, trailing }: { to: string; icon: ReactNode; label: ReactNode; end?: boolean; testId?: string; trailing?: ReactNode }) {
  return (
    <NavLink to={to} end={end} className="sem-sb-row" data-testid={testId}>
      <span className="sem-sb-icon">{icon}</span>
      <span className="sem-sb-label">{label}</span>
      {trailing}
    </NavLink>
  );
}

function HubRow({ server, hub }: { server: Server; hub: HubListItem }) {
  const loc = useLocation();
  const base = hubBase(server.id, hub.HubName_str);
  const active = loc.pathname === base || loc.pathname.startsWith(base + "/");
  return (
    <NavLink to={base} className="sem-sb-row sem-sb-hub" aria-current={active ? "page" : undefined} data-active={active || undefined} data-testid={`sidebar-hub-${server.id}-${hub.HubName_str}`}>
      <span className="sem-sb-icon"><IconStack2 size={15} stroke={1.6} /></span>
      <span className="sem-sb-label">{hub.HubName_str}</span>
      {!hub.Online_bool && <span className="sem-sb-note">Offline</span>}
      {hub.Online_bool && hub.NumSessions_u32 > 0 && <span className="sem-sb-count" aria-label={`${hub.NumSessions_u32} sessions`}>{hub.NumSessions_u32}</span>}
    </NavLink>
  );
}

function ServerRow({ server, expanded, onToggle, onContextMenu }: { server: Server; expanded: boolean; onToggle: () => void; onContextMenu: (e: MouseEvent) => void }) {
  const loc = useLocation();
  const nav = useNavigate();
  const shell = useShell();
  const base = serverBase(server.id);
  const inScope = loc.pathname === base || loc.pathname.startsWith(base + "/");
  const active = inScope && !loc.pathname.startsWith(base + "/hubs/");
  const st = serverStatus(server);
  const allHubs = server.state?.hubs?.HubList ?? [];
  const hubs = server.hub ? allHubs.filter((h) => h.HubName_str.toLowerCase() === server.hub!.toLowerCase()) : allHubs;
  const locked = st.status === "locked";
  const canExpand = hubs.length > 0 || !!server.hub;
  return (
    <div className="sem-sb-server" data-expanded={expanded || undefined}>
      <div
        className="sem-sb-row sem-sb-server-row"
        data-active={active || undefined}
        data-inscope={inScope || undefined}
        role="link"
        tabIndex={0}
        aria-current={active ? "page" : undefined}
        aria-expanded={canExpand ? expanded : undefined}
        onClick={() => { nav(base); if (locked) shell.openUnlock(server.id); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") nav(base);
          if (e.key === "ArrowRight" && !expanded) onToggle();
          if (e.key === "ArrowLeft" && expanded) onToggle();
        }}
        onContextMenu={onContextMenu}
        data-testid={`sidebar-server-${server.id}`}
      >
        <button
          type="button"
          className="sem-sb-disclosure"
          data-open={expanded || undefined}
          data-hidden={!canExpand || undefined}
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          aria-label={expanded ? `Collapse ${server.name}` : `Expand ${server.name}`}
          tabIndex={-1}
        >
          <IconChevronRight size={11} stroke={2.4} />
        </button>
        <span className="sem-sb-icon sem-sb-server-icon">
          <IconServer2 size={16} stroke={1.5} />
          <span className="sem-sb-status"><StatusDot status={st.status} label={st.label} size={7} /></span>
        </span>
        <span className="sem-sb-text">
          <span className="sem-sb-label">{server.name}</span>
          <span className="sem-sb-sub">{server.host}{server.port !== 443 ? `:${server.port}` : ""}</span>
        </span>
        {server.hub && <Tooltip label={`Hub administrator of ${server.hub}`}><span className="sem-sb-badge">HUB</span></Tooltip>}
        {!server.passwordSaved && (
          <Tooltip label={locked ? "Locked: password not saved" : "Unlocked for this session"}>
            <span className="sem-sb-lock" data-locked={locked || undefined} aria-label={locked ? "Locked" : "Unlocked for this session"}>
              {locked ? <IconLock size={12} stroke={1.8} /> : <IconLockOpen size={12} stroke={1.8} />}
            </span>
          </Tooltip>
        )}
      </div>
      {expanded && canExpand && (
        <div className="sem-sb-children" role="group">
          {hubs.map((h) => <HubRow key={h.HubName_str} server={server} hub={h} />)}
          {!hubs.length && server.hub && (
            <HubRow server={server} hub={{ HubName_str: server.hub, Online_bool: true, NumSessions_u32: 0 } as HubListItem} />
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const servers = useServers();
  const shell = useShell();
  const nav = useNavigate();
  const qc = useQueryClient();
  const cm = useContextMenu();
  const [expanded, setExpanded] = useState<Record<string, boolean>>(loadExpanded);
  const toggle = (id: number) => setExpanded((e) => {
    const next = { ...e, [id]: !e[id] };
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });
  const list = useMemo(() => [...(servers.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), [servers.data]);
  const online = list.filter((s) => serverStatus(s).status === "ok").length;

  const serverMenu = (s: Server, e: MouseEvent) => {
    const locked = !s.passwordSaved && !s.unlocked;
    cm.open(e, [
      { label: "Open", icon: <IconServer2 size={14} />, onClick: () => nav(serverBase(s.id)) },
      { label: "Edit Connection…", icon: <IconPencil size={14} />, onClick: () => shell.openConnection(s.id), testId: "ctx-edit" },
      { label: "Refresh Status", icon: <IconRefresh size={14} />, onClick: async () => {
        try { await post(`/api/servers/${s.id}/refresh`); void qc.invalidateQueries(); } catch (err) { notifyError(err, "Refresh failed"); }
      } },
      locked
        ? { label: "Unlock…", icon: <IconLockOpen size={14} />, onClick: () => shell.openUnlock(s.id) }
        : !s.passwordSaved
          ? { label: "Lock (Forget Password)", icon: <IconLock size={14} />, onClick: async () => {
            try { await post(`/api/servers/${s.id}/lock`); void qc.invalidateQueries(); } catch (err) { notifyError(err, "Couldn’t lock"); }
          } }
          : { label: "Run RPC on This Server…", icon: <IconPlayerPlay size={14} />, onClick: () => shell.openBulk([s.id]) },
      { label: "Copy Address", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(`${s.host}:${s.port}`) },
      "divider",
      { label: "Delete Connection…", icon: <IconTrash size={14} />, danger: true, testId: "ctx-delete", onClick: async () => {
        const ok = await confirmAction({
          title: <>Delete the connection “{s.name}”?</>,
          message: "The VPN Server itself isn’t changed. This removes the saved connection, its password and its configuration backups from this app.",
          confirmLabel: "Delete Connection",
        });
        if (!ok) return;
        try {
          await del(`/api/servers/${s.id}`);
          void qc.invalidateQueries();
          notifySuccess(`Deleted ${s.name}`);
          nav("/");
        } catch (err) { notifyError(err, "Couldn’t delete the connection"); }
      } },
    ]);
  };

  return (
    <nav className="sem-sidebar" aria-label="Servers and places">
      <div className="sem-sidebar-head sem-drag">
        <div className="sem-sidebar-brand">
          <img src={appIcon} alt="" width={18} height={18} />
          <span>Server Manager</span>
        </div>
        <div className="sem-sidebar-head-actions">
          <ToolbarButton icon={<IconLayoutSidebar size={17} stroke={1.5} />} label="Hide Sidebar" shortcut={["mod", "alt", "S"]} onClick={shell.toggleSidebar} testId="toggle-sidebar" />
        </div>
      </div>
      <div className="sem-sidebar-body">
        <div className="sem-sb-group">
          <SidebarItem to="/" end icon={<IconLayoutDashboard size={16} stroke={1.5} />} label="Overview" testId="sidebar-overview" />
          <SidebarItem to="/deploy" icon={<IconPackageExport size={16} stroke={1.5} />} label="Client Deployment" testId="sidebar-deploy" />
        </div>
        <div className="sem-sb-group">
          <div className="sem-sb-heading">
            <span>Servers</span>
            <Tooltip label={<span className="sem-tip">New Connection<Shortcut keys={["mod", "N"]} /></span>}>
              <UnstyledButton className="sem-sb-heading-btn" onClick={() => shell.openConnection()} aria-label="New Connection" data-testid="sidebar-add">
                <IconPlus size={13} stroke={2} />
              </UnstyledButton>
            </Tooltip>
          </div>
          {list.map((s) => (
            <ServerRow key={s.id} server={s} expanded={!!expanded[s.id]} onToggle={() => toggle(s.id)} onContextMenu={(e) => serverMenu(s, e)} />
          ))}
          {servers.isSuccess && list.length === 0 && (
            <button type="button" className="sem-sb-empty" onClick={() => shell.openConnection()}>
              <IconPlus size={13} /> Add a server…
            </button>
          )}
        </div>
      </div>
      <div className="sem-sidebar-foot">
        <NavLink to="/preferences" className="sem-sb-row sem-sb-foot-row" data-testid="sidebar-preferences">
          <span className="sem-sb-icon"><IconSettings size={16} stroke={1.5} /></span>
          <span className="sem-sb-label">Preferences</span>
        </NavLink>
        {list.length > 0 && <div className="sem-sidebar-summary" aria-live="polite">{online} of {list.length} online</div>}
      </div>
      {cm.menu}
    </nav>
  );
}
