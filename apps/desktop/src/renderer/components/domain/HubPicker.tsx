// Virtual Hub and hub-user pickers for server pages (Local Bridges, Layer 3, WireGuard keys, IPsec…).
// They render only the control: put them in a FormRow and pass its id (`{(id) => <HubSelect id={id} … />}`).
import type { ReactNode } from "react";
import { Autocomplete, Select } from "@mantine/core";
import { useRpc } from "../../lib/hooks";
import { useHubNames } from "./hooks";

export { useHubNames };

/** Searchable hub list (EnumHub). A value that isn't on the server is still shown, so nothing is lost. */
export function HubSelect({ serverId, value, onChange, id, label, description, required, testId, readOnly, clearable, w }: {
  serverId: number; value: string; onChange: (v: string) => void; id?: string;
  /** Only when used outside a FormRow. */
  label?: ReactNode; description?: ReactNode; required?: boolean; testId?: string; readOnly?: boolean; clearable?: boolean; w?: number | string;
}) {
  const hubs = useHubNames(serverId);
  const data = hubs.names.includes(value) || !value ? hubs.names : [value, ...hubs.names];
  return (
    <Select
      id={id} w={w ?? 260} label={label} description={description} required={required} searchable clearable={clearable} readOnly={readOnly}
      data={data} value={value || null} onChange={(v) => onChange(v ?? "")}
      placeholder={hubs.isLoading ? "Loading hubs…" : "Choose a Virtual Hub"}
      nothingFoundMessage="No hub with that name" data-testid={testId} aria-label={label ? undefined : "Virtual Hub"}
    />
  );
}

/** User name input with suggestions from EnumUser of the selected hub (free text allowed; unknown names are flagged). */
export function HubUserInput({ serverId, hub, value, onChange, id, label, description, required, testId, w }: {
  serverId: number; hub: string; value: string; onChange: (v: string) => void; id?: string;
  label?: ReactNode; description?: ReactNode; required?: boolean; testId?: string; w?: number | string;
}) {
  const users = useRpc<{ UserList?: { Name_str: string }[] }>(serverId, "EnumUser", { HubName_str: hub }, { enabled: !!hub, retry: false });
  const names = (users.data?.UserList ?? []).map((u) => u.Name_str).sort((a, b) => a.localeCompare(b));
  const unknown = !!hub && !!value && users.isSuccess && !names.some((n) => n.toLowerCase() === value.toLowerCase());
  return (
    <Autocomplete
      id={id} w={w ?? 260} label={label} required={required} data={names} value={value} onChange={onChange}
      description={description}
      placeholder={!hub ? "Choose a hub first" : users.isLoading ? "Loading users…" : "User name"}
      disabled={!hub}
      error={unknown ? `There’s no user “${value}” on ${hub}.` : undefined}
      data-testid={testId} aria-label={label ? undefined : "User name"}
    />
  );
}
