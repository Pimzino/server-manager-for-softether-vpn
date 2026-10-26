// ⌘K / Ctrl+K: jump to any server, Virtual Hub or page, or run a global action.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Modal } from "@mantine/core";
import {
  IconLayoutDashboard, IconPlayerPlay, IconPlus, IconSearch, IconServer2, IconSettings, IconStack2, IconCornerDownLeft,
} from "@tabler/icons-react";
import { useServers } from "../lib/hooks";
import { deployBase, deploySections, hubBase, hubSections, sectionPath, serverBase } from "../sections";
import { serverStatus, StatusDot, useShell } from "../design";
import { useCurrentScope, visibleServerSections } from "../design/scope";

interface Item { id: string; label: string; context?: string; kind: string; icon: ReactNode; haystack: string; run: () => void }

export function QuickSwitcher({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const shell = useShell();
  const servers = useServers();
  const scope = useCurrentScope();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset when closing (not when opening) so typing right after ⌘K is never discarded
  useEffect(() => { if (!opened) { setQ(""); setActive(0); } }, [opened]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const go = (to: string) => () => nav(to);
    const add = (it: Omit<Item, "haystack">, extra = "") => out.push({ ...it, haystack: `${it.label} ${it.context ?? ""} ${extra}`.toLowerCase() });
    add({ id: "a:new", label: "New Connection…", kind: "Action", icon: <IconPlus size={15} />, run: () => shell.openConnection() }, "add server");
    add({ id: "a:bulk", label: "Run RPC on Several Servers…", kind: "Action", icon: <IconPlayerPlay size={15} />, run: () => shell.openBulk() }, "bulk fleet");
    add({ id: "p:overview", label: "Overview", context: "All servers", kind: "Page", icon: <IconLayoutDashboard size={15} />, run: go("/") }, "dashboard fleet");
    add({ id: "p:prefs", label: "Preferences", kind: "Page", icon: <IconSettings size={15} />, run: go("/preferences") }, "settings backup poll");
    for (const s of deploySections) {
      const I = s.icon;
      add({ id: `d:${s.path}`, label: s.label, context: "Client Deployment", kind: "Page", icon: <I size={15} />, run: go(sectionPath(deployBase, s)) }, s.keywords);
    }
    for (const s of servers.data ?? []) {
      const st = serverStatus(s);
      add({ id: `s:${s.id}`, label: s.name, context: `${s.host}:${s.port}`, kind: "Server", icon: <span className="sem-qs-server"><IconServer2 size={15} /><StatusDot status={st.status} size={6} /></span>, run: go(serverBase(s.id)) }, s.tags.join(" "));
      for (const h of s.state?.hubs?.HubList ?? []) {
        if (s.hub && s.hub.toLowerCase() !== h.HubName_str.toLowerCase()) continue;
        add({ id: `h:${s.id}:${h.HubName_str}`, label: h.HubName_str, context: `Virtual Hub on ${s.name}`, kind: "Hub", icon: <IconStack2 size={15} />, run: go(hubBase(s.id, h.HubName_str)) });
      }
    }
    if (scope.serverId !== undefined) {
      const sname = scope.server?.name ?? "this server";
      for (const s of visibleServerSections(scope.server)) {
        const I = s.icon;
        add({ id: `ss:${s.path}`, label: s.label, context: sname, kind: "Page", icon: <I size={15} />, run: go(sectionPath(serverBase(scope.serverId), s)) }, s.keywords);
      }
    }
    if (scope.kind === "hub" && scope.hub) {
      for (const s of hubSections) {
        const I = s.icon;
        add({ id: `hs:${s.path}`, label: s.label, context: `${scope.hub} on ${scope.server?.name ?? "server"}`, kind: "Page", icon: <I size={15} />, run: go(sectionPath(hubBase(scope.serverId!, scope.hub), s)) }, s.keywords);
      }
    }
    return out;
  }, [servers.data, scope, nav, shell]);

  const results = useMemo(() => {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return items.filter((i) => i.kind !== "Hub").slice(0, 40);
    return items
      .filter((i) => tokens.every((t) => i.haystack.includes(t)))
      .map((i) => ({ i, score: (i.label.toLowerCase().startsWith(tokens[0]) ? 0 : 10) + (i.kind === "Action" ? 5 : 0) + i.label.length / 100 }))
      .sort((a, b) => a.score - b.score)
      .map((x) => x.i)
      .slice(0, 50);
  }, [items, q]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (i: Item | undefined) => { if (!i) return; onClose(); i.run(); };

  return (
    <Modal
      opened={opened} onClose={onClose} withCloseButton={false} size={580} yOffset="12vh" padding={0}
      classNames={{ content: "sem-qs" }} transitionProps={{ transition: "pop", duration: 120 }} overlayProps={{ backgroundOpacity: 0.12 }}
      aria-label="Go to"
    >
      <div className="sem-qs-input-wrap">
        <IconSearch size={18} stroke={1.6} className="sem-qs-search-icon" />
        <input
          className="sem-qs-input"
          placeholder="Go to a server, hub or page…"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          autoFocus
          data-autofocus
          role="combobox"
          aria-label="Go to"
          aria-expanded
          aria-controls="sem-qs-list"
          aria-activedescendant={results[active] ? `sem-qs-${active}` : undefined}
          data-testid="quick-input"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            if (e.key === "Enter") { e.preventDefault(); choose(results[active]); }
          }}
        />
      </div>
      <div className="sem-qs-list" id="sem-qs-list" role="listbox" ref={listRef}>
        {results.length === 0 && <div className="sem-qs-empty">No matches</div>}
        {results.map((r, i) => (
          <div
            key={r.id} id={`sem-qs-${i}`} data-index={i} role="option" aria-selected={i === active} className="sem-qs-item" data-active={i === active || undefined}
            onMouseMove={() => setActive(i)} onClick={() => choose(r)}
          >
            <span className="sem-qs-icon">{r.icon}</span>
            <span className="sem-qs-label">{r.label}</span>
            {r.context && <span className="sem-qs-context">{r.context}</span>}
            <span className="sem-qs-kind">{i === active ? <IconCornerDownLeft size={13} /> : r.kind}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
