// Secondary navigation column: the pages of the current server, Virtual Hub or client deployment,
// grouped under small headings. Hidden with the toolbar toggle (⌥⌘S-style), then the toolbar title
// becomes a menu with the same entries, so every page stays reachable.
import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { sectionPath, type Section } from "../sections";

export function ScopeNav({ base, sections, header, label = "Sections", testId = "scope-nav" }: {
  base: string; sections: Section[]; header?: ReactNode; label?: string; testId?: string;
}) {
  const loc = useLocation();
  const groups = [...new Set(sections.map((s) => s.group))];
  return (
    <nav className="sem-scope" aria-label={label} data-testid={testId}>
      {header && <div className="sem-scope-head">{header}</div>}
      <div className="sem-scope-body">
        {groups.map((g) => (
          <div className="sem-scope-group" key={g} role="group" aria-label={g}>
            <div className="sem-scope-heading">{g}</div>
            {sections.filter((s) => s.group === g).map((s) => {
              const to = sectionPath(base, s);
              const active = s.path ? loc.pathname === to || loc.pathname.startsWith(to + "/") : loc.pathname === base;
              const Icon = s.icon;
              return (
                <NavLink
                  key={s.path}
                  to={to}
                  end={!s.path}
                  className="sem-scope-row"
                  data-active={active || undefined}
                  aria-current={active ? "page" : undefined}
                  data-testid={`nav-${s.path || "index"}`}
                >
                  <Icon size={15} stroke={1.6} className="sem-scope-icon" />
                  <span title={s.label.length > 24 ? s.label : undefined}>{s.label}</span>
                </NavLink>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
