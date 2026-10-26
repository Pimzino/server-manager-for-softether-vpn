// Right-click menus. const cm = useContextMenu(); <div onContextMenu={(e) => cm.open(e, items)} /> {cm.menu}
import { useState, type MouseEvent, type ReactNode } from "react";
import { Menu } from "@mantine/core";

export type ContextMenuItem =
  | { label: ReactNode; icon?: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; shortcut?: string; testId?: string }
  | "divider";

export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const open = (e: MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    if (items.length) setState({ x: e.clientX, y: e.clientY, items });
  };
  const menu = state ? (
    <Menu opened onChange={(o) => { if (!o) setState(null); }} position="bottom-start" offset={2} withinPortal closeOnEscape trapFocus>
      <Menu.Target>
        <div style={{ position: "fixed", left: state.x, top: state.y, width: 1, height: 1, pointerEvents: "none" }} aria-hidden />
      </Menu.Target>
      <Menu.Dropdown data-testid="context-menu">
        {state.items.map((it, i) => it === "divider" ? <Menu.Divider key={i} /> : (
          <Menu.Item
            key={i} leftSection={it.icon} color={it.danger ? "red" : undefined} disabled={it.disabled} data-testid={it.testId}
            rightSection={it.shortcut ? <span className="sem-menu-shortcut">{it.shortcut}</span> : undefined}
            onClick={() => { setState(null); it.onClick(); }}
          >
            {it.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  ) : null;
  return { open, menu, close: () => setState(null) };
}
