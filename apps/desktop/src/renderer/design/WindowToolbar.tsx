// The window's own title bar/toolbar (the native one is hidden). Draggable, leaves room for the
// macOS traffic lights (when the sidebar is hidden) and the Windows caption buttons.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useIsFetching } from "@tanstack/react-query";
import { Menu, UnstyledButton } from "@mantine/core";
import {
  IconChevronDown, IconChevronLeft, IconChevronRight, IconLayoutSidebar, IconLayoutSidebarLeftExpand, IconLayoutList, IconPlus,
  IconRefresh, IconSearch,
} from "@tabler/icons-react";
import { sectionPath } from "../sections";
import { useCurrentScope, type CurrentScope } from "./scope";
import { useShell } from "./shellContext";
import { serverStatus, StatusDot } from "./Status";
import { ToolbarButton, ToolbarGroup } from "./Toolbar";

/**
 * The toolbar names the object you're looking at (server, hub, client deployment); the page's own
 * header names the section. Global pages (overview, preferences) leave the toolbar title empty.
 */
export function scopeTitle(scope: CurrentScope): { title: string; subtitle?: string } {
  switch (scope.kind) {
    case "deploy": return { title: "Client Deployment", subtitle: "Profiles and installers" };
    case "server": return { title: scope.server?.name ?? "Server", subtitle: scope.server ? `${scope.server.host}:${scope.server.port}` : undefined };
    case "hub": return { title: scope.hub ?? "Virtual Hub", subtitle: scope.server ? `Virtual Hub on ${scope.server.name}` : undefined };
    default: return { title: "" };
  }
}

/** Tracks the history position so Back/Forward can be disabled at the ends. */
function useHistoryPosition() {
  const [pos, setPos] = useState({ idx: 0, max: 0 });
  useEffect(() => {
    const read = () => {
      const idx = Number((window.history.state as { idx?: number } | null)?.idx ?? 0);
      setPos((p) => ({ idx, max: p.idx + 1 === idx || idx > p.max ? idx : p.max }));
    };
    read();
    window.addEventListener("popstate", read);
    window.addEventListener("hashchange", read);
    return () => { window.removeEventListener("popstate", read); window.removeEventListener("hashchange", read); };
  }, []);
  return pos;
}

export function WindowToolbar({ sidebarHidden }: { sidebarHidden: boolean }) {
  const shell = useShell();
  const nav = useNavigate();
  const scope = useCurrentScope();
  const fetching = useIsFetching();
  const hist = useHistoryPosition();
  const { title, subtitle } = scopeTitle(scope);
  const hasSections = scope.sections.length > 0;

  const docTitle = [scope.section?.label, title].filter(Boolean).join(" – ") || (scope.kind === "preferences" ? "Preferences" : "SoftEther Manager");
  useEffect(() => { document.title = docTitle; }, [docTitle]);
  const status = scope.kind === "server" && scope.server ? serverStatus(scope.server) : null;
  const hubInfo = scope.kind === "hub" ? scope.server?.state?.hubs?.HubList?.find((h) => h.HubName_str === scope.hub) : undefined;

  const menuMode = hasSections && shell.scopeNavHidden;
  const titleBlock = title ? (
    <span className="sem-toolbar-titles">
      <span className="sem-toolbar-title" data-testid="toolbar-title">
        {status && <StatusDot status={status.status} label={status.label} size={7} />}
        {hubInfo && <StatusDot status={hubInfo.Online_bool ? "ok" : "off"} label={hubInfo.Online_bool ? "Online" : "Offline"} size={7} />}
        <span className="sem-toolbar-title-text">{title}</span>
      </span>
      {(menuMode ? scope.section?.label : subtitle) && <span className="sem-toolbar-subtitle">{menuMode ? scope.section?.label : subtitle}</span>}
    </span>
  ) : null;

  return (
    <header className="sem-toolbar sem-drag" data-testid="toolbar">
      {sidebarHidden && (
        <div className="sem-toolbar-lead">
          <ToolbarButton icon={<IconLayoutSidebarLeftExpand size={17} stroke={1.5} />} label="Show Sidebar" shortcut={["mod", "alt", "S"]} onClick={shell.toggleSidebar} testId="show-sidebar" />
        </div>
      )}
      <ToolbarGroup label="History">
        <ToolbarButton icon={<IconChevronLeft size={18} stroke={1.6} />} label="Back" shortcut={["mod", "["]} disabled={hist.idx <= 0} onClick={() => nav(-1)} testId="nav-back" />
        <ToolbarButton icon={<IconChevronRight size={18} stroke={1.6} />} label="Forward" shortcut={["mod", "]"]} disabled={hist.idx >= hist.max} onClick={() => nav(1)} testId="nav-forward" />
      </ToolbarGroup>
      {hasSections && (
        <ToolbarButton
          icon={shell.scopeNavHidden ? <IconLayoutList size={17} stroke={1.5} /> : <IconLayoutSidebar size={17} stroke={1.5} style={{ transform: "scaleX(-1)" }} />}
          label={shell.scopeNavHidden ? "Show Sections" : "Hide Sections"}
          active={!shell.scopeNavHidden}
          onClick={shell.toggleScopeNav}
          testId="toggle-sections"
        />
      )}
      <div className="sem-toolbar-center">
        {menuMode ? (
          <Menu position="bottom-start" offset={6} withinPortal>
            <Menu.Target>
              <UnstyledButton className="sem-toolbar-title-btn" aria-label="Go to section" data-testid="toolbar-section-menu">
                {titleBlock}
                <IconChevronDown size={12} stroke={2} className="sem-toolbar-title-chevron" />
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown mah={520} style={{ overflowY: "auto" }}>
              {[...new Set(scope.sections.map((s) => s.group))].map((g) => (
                <div key={g}>
                  <Menu.Label>{g}</Menu.Label>
                  {scope.sections.filter((s) => s.group === g).map((s) => {
                    const Icon = s.icon;
                    return (
                      <Menu.Item key={s.path} leftSection={<Icon size={14} stroke={1.6} />} onClick={() => nav(sectionPath(scope.base, s))}
                        data-active={scope.section?.path === s.path || undefined}>
                        {s.label}
                      </Menu.Item>
                    );
                  })}
                </div>
              ))}
            </Menu.Dropdown>
          </Menu>
        ) : titleBlock}
      </div>
      <div className="sem-toolbar-trail">
        <ToolbarButton
          icon={<IconRefresh size={17} stroke={1.5} className={fetching ? "sem-spin" : undefined} />}
          label="Refresh" shortcut={["mod", "R"]}
          onClick={() => window.dispatchEvent(new CustomEvent("sem:action", { detail: "refresh" }))}
          testId="toolbar-refresh"
        />
        <ToolbarButton icon={<IconSearch size={17} stroke={1.5} />} label="Go to…" shortcut={["mod", "K"]} onClick={shell.openQuickSwitcher} testId="toolbar-quick" />
        <ToolbarButton icon={<IconPlus size={18} stroke={1.5} />} label="New Connection" shortcut={["mod", "N"]} onClick={() => shell.openConnection()} testId="toolbar-add" />
      </div>
    </header>
  );
}
