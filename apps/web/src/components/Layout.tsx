import { Suspense } from "react";
import { NavLink as RouterNavLink, Outlet, useLocation, useNavigate } from "react-router";
import {
  AppShell, Badge, Burger, Center, Group, Loader, Menu, NavLink, ScrollArea, Select, Text, UnstyledButton, Avatar, useMantineColorScheme,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconDashboard, IconServer2, IconPackage, IconFileCertificate, IconBox, IconUsers, IconListDetails, IconSettings,
  IconLogout, IconUser, IconMoon, IconSun, IconShieldLock, IconTopologyStar, IconPalette,
} from "@tabler/icons-react";
import { useAuth } from "../lib/auth";
import { useServers } from "../lib/hooks";

function NavItem({ to, label, icon, end }: { to: string; label: string; icon: React.ReactNode; end?: boolean }) {
  const loc = useLocation();
  const active = end ? loc.pathname === to : loc.pathname === to || loc.pathname.startsWith(to + "/");
  return <NavLink component={RouterNavLink} to={to} end={end} label={label} leftSection={icon} active={active} />;
}

export function Layout() {
  const [opened, { toggle, close }] = useDisclosure();
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const servers = useServers();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const currentServer = loc.pathname.match(/^\/servers\/(\d+)/)?.[1] ?? null;

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 240, breakpoint: "sm", collapsed: { mobile: !opened } }} padding="lg">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Toggle navigation" />
            <IconShieldLock size={24} color="var(--mantine-color-blue-6)" />
            <Text fw={700} visibleFrom="xs">SoftEther Manager</Text>
            <Select
              placeholder="Jump to server…"
              data={(servers.data ?? []).map((s) => ({ value: String(s.id), label: s.name }))}
              value={currentServer}
              onChange={(v) => v && nav(`/servers/${v}`)}
              searchable
              size="xs"
              w={220}
              visibleFrom="sm"
              aria-label="Jump to server"
              comboboxProps={{ withinPortal: true }}
            />
          </Group>
          <Group gap="xs" wrap="nowrap">
            <UnstyledButton onClick={() => toggleColorScheme()} aria-label="Toggle color scheme" p={6}>
              {colorScheme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
            </UnstyledButton>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <UnstyledButton data-testid="user-menu">
                  <Group gap={8} wrap="nowrap">
                    <Avatar size={28} radius="xl" color="blue">{user?.username.slice(0, 2).toUpperCase()}</Avatar>
                    <div style={{ lineHeight: 1 }}>
                      <Text size="sm" fw={500}>{user?.displayName || user?.username}</Text>
                      <Badge size="xs" variant="light">{user?.role}</Badge>
                    </div>
                  </Group>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconUser size={16} />} onClick={() => nav("/account")}>My account</Menu.Item>
                <Menu.Divider />
                <Menu.Item leftSection={<IconLogout size={16} />} color="red" onClick={() => void logout()}>Sign out</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="xs">
        <AppShell.Section grow component={ScrollArea} onClick={close}>
          <NavItem to="/" label="Dashboard" icon={<IconDashboard size={18} />} end />
          <NavItem to="/servers" label="Servers" icon={<IconServer2 size={18} />} />
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" mt="md" mb={4} px="sm">Client deployment</Text>
          <NavItem to="/deploy/hubs" label="Hub profiles" icon={<IconTopologyStar size={18} />} />
          <NavItem to="/deploy/templates" label="Templates & branding" icon={<IconPalette size={18} />} />
          <NavItem to="/deploy/profiles" label="Custom profiles" icon={<IconFileCertificate size={18} />} />
          <NavItem to="/deploy/packages" label="Client packages" icon={<IconBox size={18} />} />
          <NavItem to="/deploy/installers" label="MSI installers" icon={<IconPackage size={18} />} />
          {(user?.role === "admin" || user?.role === "operator") && (
            <>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" mt="md" mb={4} px="sm">Administration</Text>
              {user?.role === "admin" && <NavItem to="/admin/users" label="Users & access" icon={<IconUsers size={18} />} />}
              <NavItem to="/admin/audit" label="Audit log" icon={<IconListDetails size={18} />} />
              {user?.role === "admin" && <NavItem to="/admin/settings" label="Settings" icon={<IconSettings size={18} />} />}
            </>
          )}
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <Suspense fallback={<Center py="xl"><Loader /></Center>}>
          <Outlet />
        </Suspense>
      </AppShell.Main>
    </AppShell>
  );
}
