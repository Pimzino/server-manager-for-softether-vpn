import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { lazy, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate } from "react-router";
import { RouterProvider } from "react-router/dom";
import { Center, Loader, MantineProvider, createTheme } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { get } from "./lib/api";
import { SetupPage } from "./pages/Setup";
import { AuthProvider, useAuth } from "./lib/auth";
import { Layout } from "./components/Layout";
import { HubLayout, ServerLayout } from "./components/ScopeLayout";
import { LoginPage, ChangePasswordPage } from "./pages/Login";
import { hubSections, serverSections } from "./sections";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const ServersPage = lazy(() => import("./pages/Servers"));
const ProfilesPage = lazy(() => import("./pages/deploy/Profiles"));
const PackagesPage = lazy(() => import("./pages/deploy/Packages"));
const InstallersPage = lazy(() => import("./pages/deploy/Installers"));
const TemplatesPage = lazy(() => import("./pages/deploy/Templates"));
const HubProfilesPage = lazy(() => import("./pages/deploy/Hubs"));
const UsersPage = lazy(() => import("./pages/admin/Users"));
const AuditPage = lazy(() => import("./pages/admin/Audit"));
const SettingsPage = lazy(() => import("./pages/admin/Settings"));
const AccountPage = lazy(() => import("./pages/Account"));

const theme = createTheme({
  primaryColor: "blue",
  defaultRadius: "md",
  fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 5_000 } },
});

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "servers", element: <ServersPage /> },
      {
        path: "servers/:serverId",
        element: <ServerLayout />,
        children: serverSections.map((s) => (s.path ? { path: s.path, element: <s.component /> } : { index: true, element: <s.component /> })),
      },
      {
        path: "servers/:serverId/hubs/:hub",
        element: <HubLayout />,
        children: hubSections.map((s) => (s.path ? { path: s.path, element: <s.component /> } : { index: true, element: <s.component /> })),
      },
      { path: "deploy/profiles", element: <ProfilesPage /> },
      { path: "deploy/packages", element: <PackagesPage /> },
      { path: "deploy/installers", element: <InstallersPage /> },
      { path: "deploy/templates", element: <TemplatesPage /> },
      { path: "deploy/hubs", element: <HubProfilesPage /> },
      { path: "admin/users", element: <UsersPage /> },
      { path: "admin/audit", element: <AuditPage /> },
      { path: "admin/settings", element: <SettingsPage /> },
      { path: "account", element: <AccountPage /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

function Gate() {
  const { user, loading } = useAuth();
  // Setup status is public and cheap; once setup is done the server always answers false.
  const setup = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => get<{ setupRequired: boolean; passwordPolicy?: { minLength: number; requireMixed: boolean } }>("/api/setup/status"),
    staleTime: Infinity,
    retry: 2,
  });
  if (loading || setup.isLoading) return <Center mih="100vh"><Loader /></Center>;
  if (setup.data?.setupRequired && !user) {
    return <SetupPage policy={setup.data.passwordPolicy} onDone={() => void setup.refetch()} />;
  }
  if (!user) return <LoginPage />;
  if (user.mustChangePassword) return <ChangePasswordPage forced />;
  return <RouterProvider router={router} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <QueryClientProvider client={queryClient}>
        <ModalsProvider>
          <Notifications position="top-right" />
          <AuthProvider>
            <Gate />
          </AuthProvider>
        </ModalsProvider>
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
