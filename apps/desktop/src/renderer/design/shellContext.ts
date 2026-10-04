// Global shell actions, available to any component under <AppShell>.
import { createContext, useContext } from "react";

export interface ShellActions {
  /** Open the connection sheet: no id = new connection, id = edit that connection. */
  openConnection(serverId?: number): void;
  /** Ask for the administrator password of a server whose password isn't saved. */
  openUnlock(serverId: number): void;
  openQuickSwitcher(): void;
  /** Run one RPC on several servers. */
  openBulk(serverIds?: number[]): void;
  toggleSidebar(): void;
  /** The secondary (per-scope) navigation column is hidden; the toolbar shows a section menu instead. */
  scopeNavHidden: boolean;
  toggleScopeNav(): void;
}

const noop = () => undefined;
export const ShellContext = createContext<ShellActions>({
  openConnection: noop, openUnlock: noop, openQuickSwitcher: noop, openBulk: noop, toggleSidebar: noop, scopeNavHidden: false, toggleScopeNav: noop,
});

export const useShell = () => useContext(ShellContext);
