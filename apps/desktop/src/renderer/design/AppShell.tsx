// Window layout: translucent sidebar | (toolbar / page). Owns the global sheets and dispatches
// native-menu actions and keyboard shortcuts.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useHotkeys } from "@mantine/hooks";
import { onLocked } from "../lib/api";
import { ConnectionSheet } from "../components/ConnectionSheet";
import { UnlockDialog } from "../components/UnlockDialog";
import { QuickSwitcher } from "../components/QuickSwitcher";
import { BulkRunSheet } from "../components/BulkRunSheet";
import { Sidebar } from "./Sidebar";
import { WindowToolbar } from "./WindowToolbar";
import { ShellContext, type ShellActions } from "./shellContext";
import { LoadingState } from "./States";
import { useCurrentScope } from "./scope";

function usePersistentFlag(key: string, initial: boolean) {
  const [v, setV] = useState<boolean>(() => {
    try { const s = localStorage.getItem(key); return s === null ? initial : s === "1"; } catch { return initial; }
  });
  const set = useCallback((next: boolean | ((p: boolean) => boolean)) => setV((p) => {
    const n = typeof next === "function" ? next(p) : next;
    try { localStorage.setItem(key, n ? "1" : "0"); } catch { /* ignore */ }
    return n;
  }), [key]);
  return [v, set] as const;
}

export function AppShell() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const scope = useCurrentScope();
  const [sidebarHidden, setSidebarHidden] = usePersistentFlag("sem.sidebar.hidden", false);
  const [scopeNavHidden, setScopeNavHidden] = usePersistentFlag("sem.scopeNav.hidden", false);
  const [conn, setConn] = useState<{ open: boolean; id?: number }>({ open: false });
  const [unlockId, setUnlockId] = useState<number | null>(null);
  const [quick, setQuick] = useState(false);
  const [bulk, setBulk] = useState<{ open: boolean; ids?: number[] }>({ open: false });
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const actions: ShellActions = useMemo(() => ({
    openConnection: (id?: number) => setConn({ open: true, id }),
    openUnlock: (id: number) => setUnlockId(id),
    openQuickSwitcher: () => setQuick(true),
    openBulk: (ids?: number[]) => setBulk({ open: true, ids }),
    toggleSidebar: () => setSidebarHidden((h) => !h),
    scopeNavHidden,
    toggleScopeNav: () => setScopeNavHidden((h) => !h),
  }), [scopeNavHidden, setSidebarHidden, setScopeNavHidden]);

  // One dispatcher for native menu items, keyboard shortcuts and toolbar buttons.
  // Native accelerators and renderer hotkeys can both fire for one key press: drop repeats within 300 ms.
  const last = useRef<{ a: string; t: number }>({ a: "", t: 0 });
  const run = useCallback((action: string) => {
    const now = performance.now();
    if (last.current.a === action && now - last.current.t < 300) return;
    last.current = { a: action, t: now };
    if (action.startsWith("navigate:")) { nav(action.slice("navigate:".length) || "/"); return; }
    switch (action) {
      case "new-server": actions.openConnection(); break;
      case "edit-server": if (scopeRef.current.serverId) actions.openConnection(scopeRef.current.serverId); break;
      case "preferences": nav("/preferences"); break;
      case "refresh": void qc.invalidateQueries(); break;
      case "quick-open": actions.openQuickSwitcher(); break;
      case "toggle-sidebar": actions.toggleSidebar(); break;
      case "toggle-sections": actions.toggleScopeNav(); break;
      case "bulk": actions.openBulk(); break;
      case "back": nav(-1); break;
      case "forward": nav(1); break;
      case "find": {
        const el = document.querySelector<HTMLInputElement>(".sem-content .sem-table-filter input");
        el?.focus(); el?.select();
        break;
      }
      default: break;
    }
  }, [nav, qc, actions]);

  useEffect(() => window.sem?.onMenu?.(run), [run]);
  useEffect(() => {
    const h = (e: Event) => run(String((e as CustomEvent).detail));
    window.addEventListener("sem:action", h);
    return () => window.removeEventListener("sem:action", h);
  }, [run]);
  useEffect(() => onLocked((id) => { void qc.invalidateQueries({ queryKey: ["server", id] }); void qc.invalidateQueries({ queryKey: ["servers"] }); }), [qc]);

  useHotkeys([
    ["mod+N", () => run("new-server")],
    ["mod+,", () => run("preferences")],
    ["mod+R", () => run("refresh")],
    ["mod+alt+S", () => run("toggle-sidebar")],
    ["mod+[", () => run("back")],
    ["mod+]", () => run("forward")],
    ["mod+F", () => run("find")],
  ]);
  // Quick switcher also works while typing in a field
  useHotkeys([["mod+K", () => run("quick-open")]], []);

  return (
    <ShellContext.Provider value={actions}>
      <div className="sem-shell" data-sidebar={sidebarHidden ? "hidden" : "shown"}>
        <Sidebar />
        <div className="sem-main">
          <WindowToolbar sidebarHidden={sidebarHidden} />
          <div className="sem-main-body">
            <Suspense fallback={<div className="sem-content"><LoadingState /></div>}>
              <Outlet />
            </Suspense>
          </div>
        </div>
      </div>
      <ConnectionSheet opened={conn.open} serverId={conn.id} onClose={() => setConn({ open: false })} />
      <UnlockDialog serverId={unlockId} onClose={() => setUnlockId(null)} />
      <QuickSwitcher opened={quick} onClose={() => setQuick(false)} />
      <BulkRunSheet opened={bulk.open} initialIds={bulk.ids} onClose={() => setBulk({ open: false })} />
    </ShellContext.Provider>
  );
}
