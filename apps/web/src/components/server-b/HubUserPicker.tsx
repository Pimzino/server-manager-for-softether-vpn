import type { ReactNode } from "react";
import { Autocomplete, Select } from "@mantine/core";
import { useRpc } from "../../lib/hooks";
import type { HubListItem } from "../../lib/types";

export function useHubNames(serverId: number) {
  const q = useRpc<{ HubList?: HubListItem[] }>(serverId, "EnumHub");
  return { ...q, names: (q.data?.HubList ?? []).map((h) => h.HubName_str).sort((a, b) => a.localeCompare(b)) };
}

export function HubSelect({ serverId, value, onChange, label = "Virtual Hub", description, required, testId, readOnly, clearable }: {
  serverId: number; value: string; onChange: (v: string) => void; label?: ReactNode; description?: ReactNode; required?: boolean; testId?: string; readOnly?: boolean; clearable?: boolean;
}) {
  const hubs = useHubNames(serverId);
  const data = hubs.names.includes(value) || !value ? hubs.names : [value, ...hubs.names];
  return (
    <Select
      label={label} description={description} required={required} searchable clearable={clearable} readOnly={readOnly}
      data={data} value={value || null} onChange={(v) => onChange(v ?? "")}
      placeholder={hubs.isLoading ? "Loading hubs…" : "Select a Virtual Hub"}
      nothingFoundMessage="No such hub" data-testid={testId}
    />
  );
}

/** User name input with suggestions from EnumUser of the selected hub (free text allowed). */
export function HubUserInput({ serverId, hub, value, onChange, label = "User name", description, required, testId }: {
  serverId: number; hub: string; value: string; onChange: (v: string) => void; label?: ReactNode; description?: ReactNode; required?: boolean; testId?: string;
}) {
  const users = useRpc<{ UserList?: { Name_str: string }[] }>(serverId, "EnumUser", { HubName_str: hub }, { enabled: !!hub, retry: false });
  const names = (users.data?.UserList ?? []).map((u) => u.Name_str).sort((a, b) => a.localeCompare(b));
  const unknown = !!hub && !!value && users.isSuccess && !names.some((n) => n.toLowerCase() === value.toLowerCase());
  return (
    <Autocomplete
      label={label} required={required} data={names} value={value} onChange={onChange}
      description={description}
      placeholder={!hub ? "Select a hub first" : users.isLoading ? "Loading users…" : "User name"}
      disabled={!hub}
      error={unknown ? `User "${value}" does not exist on hub ${hub}` : undefined}
      data-testid={testId}
    />
  );
}
