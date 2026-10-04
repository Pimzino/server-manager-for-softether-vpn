import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Group, Paper, SimpleGrid, Stack, Text, Textarea, ThemeIcon, Title } from "@mantine/core";
import { IconAlertTriangle, IconEraser, IconMessage } from "@tabler/icons-react";
import { ConfirmButton, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { SaveBar, useHubAccess } from "../../components/hub-a/shared";
import { useRpc, useRpcMutation } from "../../lib/hooks";
import { b64ToText, textToB64 } from "../../lib/format";

/** SoftEther HUB_MAXMSG_LEN: maximum number of characters in a hub message. */
const MAX_LEN = 20000;
// Characters outside the Basic Multilingual Plane (emoji etc.) are corrupted by SoftEther's
// wide-char conversion (verified on build 5187), so warn before saving them.
const NON_BMP = /[\u{10000}-\u{10FFFF}]/u;

export default function HubMessagePage() {
  const { serverId, hub, role, canWrite } = useHubAccess();
  const q = useRpc<{ HubName_str?: string; Msg_bin?: string }>(serverId, "GetHubMsg", { HubName_str: hub }, { enabled: !!hub });
  const initial = useMemo(() => (q.data ? b64ToText(q.data.Msg_bin) : ""), [q.data]);
  const [text, setText] = useState("");
  useEffect(() => setText(initial), [initial]);
  const save = useRpcMutation(serverId, "SetHubMsg", { success: "Client message saved" });
  const clear = useRpcMutation(serverId, "SetHubMsg", { success: "Client message removed" });

  const chars = [...text].length;
  const tooLong = chars > MAX_LEN;
  const hasNonBmp = NON_BMP.test(text);
  const dirty = text !== initial;

  return (
    <>
      <PageHeader
        title="Client message"
        description="A message (for example a notice or acceptable-use policy) shown in a pop-up by SoftEther VPN Client after a user connects to this Virtual Hub. Leave empty to show nothing. Other VPN clients (L2TP, OpenVPN, SSTP, …) do not display it."
      />
      {!canWrite && <ReadOnlyNotice role={role} />}
      <QueryState query={q}>
        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
          <Section
            title="Message text"
            actions={initial !== "" && canWrite && (
              <ConfirmButton
                title="Remove the client message?"
                message="Clients will no longer see a message after connecting."
                confirmLabel="Remove"
                leftSection={<IconEraser size={14} />}
                onConfirm={() => clear.mutateAsync({ HubName_str: hub, Msg_bin: "" })}
              >
                <span data-testid="hub-msg-clear">Remove message</span>
              </ConfirmButton>
            )}
          >
            <Textarea
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              readOnly={!canWrite}
              autosize minRows={10} maxRows={24}
              placeholder="e.g. Welcome to the corporate VPN. Unauthorised use is prohibited."
              error={tooLong ? `The message is limited to ${MAX_LEN.toLocaleString()} characters` : undefined}
              data-testid="hub-msg-text"
              aria-label="Message text"
            />
            <Group justify="space-between" mt={4}>
              <Text size="xs" c={tooLong ? "red" : "dimmed"}>{chars.toLocaleString()} / {MAX_LEN.toLocaleString()} characters</Text>
              <Text size="xs" c="dimmed">Stored as UTF-8 ({new TextEncoder().encode(text).length.toLocaleString()} bytes)</Text>
            </Group>
            {hasNonBmp && (
              <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} mt="sm">
                The message contains emoji or other characters outside the Basic Multilingual Plane. SoftEther does not store these
                correctly and they will appear garbled on clients.
              </Alert>
            )}
            {canWrite && (
              <SaveBar
                dirty={dirty}
                disabled={tooLong}
                saving={save.isPending}
                onReset={() => setText(initial)}
                onSave={() => save.mutate({ HubName_str: hub, Msg_bin: text ? textToB64(text) : "" })}
                testId="hub-msg-save"
              />
            )}
          </Section>

          <Section title="Preview" description="Approximately how the message appears in SoftEther VPN Client.">
            <Paper withBorder radius="md" shadow="sm" p="md" data-testid="hub-msg-preview">
              <Group gap="sm" mb="sm" wrap="nowrap">
                <ThemeIcon variant="light" size="lg"><IconMessage size={18} /></ThemeIcon>
                <div>
                  <Title order={5}>Message from the VPN Server</Title>
                  <Text size="xs" c="dimmed">Virtual Hub “{hub}”</Text>
                </div>
                {dirty && <Badge ml="auto" color="yellow" variant="light">Unsaved</Badge>}
              </Group>
              <Stack gap={0}>
                {text
                  ? <Text size="sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 480, overflow: "auto" }}>{text}</Text>
                  : <Text size="sm" c="dimmed" fs="italic">No message — clients will not see a pop-up.</Text>}
              </Stack>
            </Paper>
          </Section>
        </SimpleGrid>
      </QueryState>
    </>
  );
}
