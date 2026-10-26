// Route layouts: the content area, and the server / hub / deploy scopes with their secondary navigation.
import { Suspense, useEffect, useRef, type ReactNode } from "react";
import { Navigate, Outlet, useLocation, useNavigate, useRouteError } from "react-router";
import { Button } from "@mantine/core";
import { IconServerOff, IconStack2 } from "@tabler/icons-react";
import { ApiError } from "../lib/api";
import { useScope, useServer } from "../lib/hooks";
import { hubSections, deploySections, hubBase, serverBase, deployBase, deployIndex } from "../sections";
import { EmptyState, ErrorState, LoadingState, Page, serverStatus, useShell } from "../design";
import { ScopeNav } from "../design/ScopeNav";
import { useCurrentScope, visibleServerSections } from "../design/scope";
import { UnlockForm } from "../components/UnlockDialog";

/** Scrollable page area. Scrolls back to the top when the route changes. */
export function ContentArea({ children, width }: { children: ReactNode; width?: "regular" | "wide" | "narrow" | "full" }) {
  const ref = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  useEffect(() => { ref.current?.scrollTo({ top: 0 }); }, [pathname]);
  return (
    <main className="sem-content" ref={ref} id="main" tabIndex={-1}>
      <Page width={width}>
        <Suspense fallback={<LoadingState />}>{children}</Suspense>
      </Page>
    </main>
  );
}

/** Layout for global pages (overview, preferences). */
export function PlainScope() {
  return <ContentArea width="wide"><Outlet /></ContentArea>;
}

export function ServerScope() {
  const { serverId } = useScope();
  const server = useServer(serverId);
  const shell = useShell();
  const scope = useCurrentScope();
  const s = server.data;
  const st = s ? serverStatus(s) : null;
  const base = serverBase(serverId);
  // Wait for the connection before listing pages: hub-admin connections get a shorter list.
  const sections = s ? visibleServerSections(s) : [];
  const notInHubMode = !!s?.hub && scope.kind === "server" && !scope.section;

  let body: ReactNode;
  if (server.isLoading) body = <LoadingState />;
  else if (server.error) {
    body = server.error instanceof ApiError && server.error.status === 404
      ? <EmptyState icon={<IconServerOff size={30} stroke={1.4} />} title="This connection no longer exists" description="It may have been deleted in another window." />
      : <ErrorState error={server.error} onRetry={() => void server.refetch()} />;
  } else if (s && st?.status === "locked") body = <UnlockForm server={s} layout="page" />;
  else if (notInHubMode) body = <EmptyState title="Not available in hub-admin mode" description={`This connection administers the Virtual Hub ${s!.hub} only. Server-wide pages need the server administrator password.`} />;
  else body = <Outlet />;

  return (
    <div className="sem-scope-layout">
      {!shell.scopeNavHidden && (
        <ScopeNav
          base={base}
          sections={sections}
          label={`${s?.name ?? "Server"} sections`}
        />
      )}
      <ContentArea>{body}</ContentArea>
    </div>
  );
}

export function HubScope() {
  const { serverId, hub } = useScope();
  const server = useServer(serverId);
  const shell = useShell();
  const nav = useNavigate();
  const s = server.data;
  const st = s ? serverStatus(s) : null;
  const wrongHub = !!s?.hub && !!hub && s.hub.toLowerCase() !== hub.toLowerCase();

  let body: ReactNode;
  if (server.isLoading) body = <LoadingState />;
  else if (server.error) body = <ErrorState error={server.error} onRetry={() => void server.refetch()} />;
  else if (s && st?.status === "locked") body = <UnlockForm server={s} layout="page" />;
  else if (wrongHub) body = <EmptyState icon={<IconStack2 size={30} stroke={1.4} />} title={`This connection can only manage ${s!.hub}`} action={<Button variant="default" onClick={() => nav(hubBase(serverId, s!.hub!))}>Open {s!.hub}</Button>} />;
  else body = <Outlet />;

  return (
    <div className="sem-scope-layout">
      {!shell.scopeNavHidden && (
        <ScopeNav
          base={hubBase(serverId, hub ?? "")}
          sections={hubSections}
          label={`${hub} sections`}
        />
      )}
      <ContentArea>{body}</ContentArea>
    </div>
  );
}

export function DeployScope() {
  const shell = useShell();
  const { pathname } = useLocation();
  if (pathname === deployBase || pathname === `${deployBase}/`) return <Navigate to={`${deployBase}/${deployIndex}`} replace />;
  return (
    <div className="sem-scope-layout">
      {!shell.scopeNavHidden && (
        <ScopeNav base={deployBase} sections={deploySections} label="Client deployment" />
      )}
      <ContentArea><Outlet /></ContentArea>
    </div>
  );
}

/** Route error element (failed lazy import, render crash). */
export function RouteError() {
  const err = useRouteError();
  return (
    <div className="sem-content"><Page>
      <ErrorState error={err instanceof Error ? err : new Error(String((err as { statusText?: string })?.statusText ?? err))} onRetry={() => window.location.reload()} />
    </Page></div>
  );
}
