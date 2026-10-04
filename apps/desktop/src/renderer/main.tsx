import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./design/tokens.css";
import "./design/components.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, Navigate, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { theme } from "./design/theme";
import { AppShell } from "./design/AppShell";
import { syncWindowMaterial } from "./design/material";
import { DeployScope, HubScope, PlainScope, RouteError, ServerScope } from "./pages/Scopes";
import { deploySections, hubSections, serverSections, type Section } from "./sections";
import Fleet from "./pages/Fleet";
import Preferences from "./pages/Preferences";

async function boot() {
  // Plain browser (vite dev server, Playwright screenshots): install the fake bridge.
  if (!window.sem && import.meta.env.DEV) {
    const { installMockBridge } = await import("./dev/mockBridge");
    installMockBridge();
  }
  const html = document.documentElement;
  try {
    const info = await window.sem.info();
    html.dataset.platform = info.platform;
  } catch {
    html.dataset.platform = navigator.userAgent.includes("Windows") ? "win32" : "darwin";
  }
  // Which secret store actually protects saved passwords ("safeStorage" or "plain"); drives the wording.
  try {
    const r = await window.sem.api({ method: "GET", path: "/api/settings" });
    const ks = (r.body as { keystore?: unknown } | null)?.keystore;
    if (typeof ks === "string") html.dataset.keystore = ks;
  } catch { /* keep the platform wording */ }
  // "browser": plain web page (mock bridge) — draw an opaque sidebar. "electron": the window provides vibrancy/mica.
  // ?shell=electron lets the mock run inside a real Electron window to check the chrome.
  const mock = (window as unknown as { __semMock?: boolean }).__semMock;
  html.dataset.shell = mock && new URLSearchParams(location.search).get("shell") !== "electron" ? "browser" : "electron";

  const queryClient = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 5_000 } },
  });

  const children = (sections: Section[]): RouteObject[] =>
    sections.map((s) => (s.path ? { path: s.path, element: <s.component /> } : { index: true, element: <s.component /> }));

  const router = createHashRouter([
    {
      path: "/",
      element: <AppShell />,
      children: [
        { element: <PlainScope />, errorElement: <RouteError />, children: [
          { index: true, element: <Fleet /> },
          { path: "preferences", element: <Preferences /> },
        ] },
        { path: "servers/:serverId", element: <ServerScope />, errorElement: <RouteError />, children: children(serverSections) },
        { path: "servers/:serverId/hubs/:hub", element: <HubScope />, errorElement: <RouteError />, children: children(hubSections) },
        { path: "deploy", element: <DeployScope />, errorElement: <RouteError />, children: children(deploySections) },
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ]);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MantineProvider theme={theme} defaultColorScheme="auto">
        <QueryClientProvider client={queryClient}>
          <ModalsProvider>
            <Notifications position="bottom-right" limit={4} containerWidth={380} />
            <RouterProvider router={router} />
          </ModalsProvider>
        </QueryClientProvider>
      </MantineProvider>
    </StrictMode>,
  );
}

void boot().then(() => syncWindowMaterial());
