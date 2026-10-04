import { Suspense, type ReactNode } from "react";
import { NavLink as RouterNavLink, Outlet, useLocation, Link } from "react-router";
import { Anchor, Badge, Box, Breadcrumbs, Center, Group, Loader, NavLink, Paper, Stack, Text, Title } from "@mantine/core";
import { useScope, useServer } from "../lib/hooks";
import { ErrorAlert, OnlineBadge } from "./common";
import { hubSections, serverSections, type Section } from "../sections";

function SubNav({ base, sections, filter }: { base: string; sections: Section[]; filter?: (s: Section) => boolean }) {
  const loc = useLocation();
  const groups = [...new Set(sections.map((s) => s.group))];
  return (
    <Paper withBorder radius="md" p={6} w={220} style={{ flexShrink: 0, alignSelf: "flex-start", position: "sticky", top: 72 }}>
      {groups.map((g) => (
        <Box key={g} mb={4}>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" pt={6} pb={2}>{g}</Text>
          {sections.filter((s) => s.group === g && (!filter || filter(s))).map((s) => {
            const to = s.path ? `${base}/${s.path}` : base;
            const active = s.path ? loc.pathname === to || loc.pathname.startsWith(to + "/") : loc.pathname === base;
            // `end` on the index entry: otherwise React Router marks it active on every child route
            return <NavLink key={s.path} component={RouterNavLink} to={to} end={!s.path} label={s.label} leftSection={s.icon} active={active} py={6} />;
          })}
        </Box>
      ))}
    </Paper>
  );
}

function Frame({ header, nav, children }: { header: ReactNode; nav: ReactNode; children: ReactNode }) {
  return (
    <Stack gap="md">
      {header}
      <Group align="flex-start" wrap="nowrap" gap="lg">
        {nav}
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Suspense fallback={<Center py="xl"><Loader /></Center>}>{children}</Suspense>
        </Box>
      </Group>
    </Stack>
  );
}

export function ServerLayout() {
  const { serverId } = useScope();
  const server = useServer(serverId);
  if (server.isLoading) return <Center py="xl"><Loader /></Center>;
  if (server.error || !server.data) return <ErrorAlert error={server.error ?? new Error("Server not found")} />;
  const s = server.data;
  const hubMode = !!s.hub;
  const limited = !!s.visibleHubs;
  const base = `/servers/${s.id}`;
  return (
    <Frame
      header={
        <div>
          <Breadcrumbs mb={4}><Anchor component={Link} to="/servers" size="sm">Servers</Anchor><Text size="sm">{s.name}</Text></Breadcrumbs>
          <Group gap="sm">
            <Title order={2}>{s.name}</Title>
            <OnlineBadge online={s.state?.ok} onLabel="Reachable" offLabel="Unreachable" />
            <Badge variant="outline" color="gray">{s.host}:{s.port}</Badge>
            {hubMode && <Badge color="grape" variant="light">Hub admin: {s.hub}</Badge>}
            <Badge variant="light">{s.myRole}</Badge>
          </Group>
        </div>
      }
      nav={<SubNav base={base} sections={serverSections} filter={(sec) => (!hubMode && !limited) || sec.hubAdminOk === true} />}
    >
      <Outlet />
    </Frame>
  );
}

export function HubLayout() {
  const { serverId, hub } = useScope();
  const server = useServer(serverId);
  const base = `/servers/${serverId}/hubs/${encodeURIComponent(hub!)}`;
  const hubInfo = server.data?.state?.hubs?.HubList?.find((h) => h.HubName_str === hub);
  return (
    <Frame
      header={
        <div>
          <Breadcrumbs mb={4}>
            <Anchor component={Link} to="/servers" size="sm">Servers</Anchor>
            <Anchor component={Link} to={`/servers/${serverId}`} size="sm">{server.data?.name ?? "…"}</Anchor>
            <Anchor component={Link} to={`/servers/${serverId}/hubs`} size="sm">Virtual Hubs</Anchor>
            <Text size="sm">{hub}</Text>
          </Breadcrumbs>
          <Group gap="sm">
            <Title order={2}>{hub}</Title>
            {hubInfo && <OnlineBadge online={hubInfo.Online_bool} />}
            <Badge variant="light" color="gray">Virtual Hub</Badge>
          </Group>
        </div>
      }
      nav={<SubNav base={base} sections={hubSections} />}
    >
      <Outlet />
    </Frame>
  );
}
