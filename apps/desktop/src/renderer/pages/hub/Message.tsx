// Hub › Client Message. The pop-up text SoftEther VPN Client shows after connecting (GetHubMsg / SetHubMsg),
// with a live preview. Ported from apps/web/src/pages/hub/Message.tsx.
import { useEffect, useMemo, useState } from "react";
import { Textarea } from "@mantine/core";
import { IconEraser, IconMessage } from "@tabler/icons-react";
import { useRpc, useRpcMutation } from "../../lib/hooks";
import { b64ToText, textToB64 } from "../../lib/format";
import { Callout, SaveBar } from "../../components/domain/ui";
import { ConfirmButton, PageHeader, PropertySkeleton, QueryState, Section, SectionGrid, Tag } from "../../design";
import { Caption, HubUnreachable, useHubPage } from "./_hub-core/shared";

/** SoftEther HUB_MAXMSG_LEN: maximum number of characters in a hub message. */
const MAX_LEN = 20000;
// Characters outside the Basic Multilingual Plane (emoji etc.) are corrupted by SoftEther's wide-char
// conversion (verified on build 5187), so warn before saving them.
const NON_BMP = /[\u{10000}-\u{10FFFF}]/u;

export default function HubMessagePage() {
  const { serverId, hub, ready, server } = useHubPage();
  const q = useRpc<{ HubName_str?: string; Msg_bin?: string }>(serverId, "GetHubMsg", { HubName_str: hub }, { enabled: ready });
  const initial = useMemo(() => (q.data ? b64ToText(q.data.Msg_bin) : ""), [q.data]);
  const [text, setText] = useState("");
  useEffect(() => setText(initial), [initial]);
  const save = useRpcMutation(serverId, "SetHubMsg", { success: "Client message saved" });
  const clear = useRpcMutation(serverId, "SetHubMsg", { success: "Client message removed", confirm: false });

  if (!server.data) return null;
  const chars = [...text].length;
  const tooLong = chars > MAX_LEN;
  const hasNonBmp = NON_BMP.test(text);
  const dirty = text !== initial;

  return (
    <>
      <PageHeader
        title="Client Message"
        badge={q.data && <Tag color={initial ? "green" : "gray"} testId="hub-msg-state">{initial ? "Shown to clients" : "No message"}</Tag>}
        description="Shown in a pop-up by SoftEther VPN Client after a user connects, for example a notice or an acceptable-use policy. Other clients (L2TP, OpenVPN, SSTP) don’t show it."
        actions={ready && initial !== "" && (
          <ConfirmButton
            title={<>Remove the client message of “{hub}”?</>}
            message="Clients no longer see a pop-up after they connect."
            confirmLabel="Remove Message" leftSection={<IconEraser size={14} />}
            onConfirm={() => clear.mutateAsync({ HubName_str: hub, Msg_bin: "" })}
            testId="hub-msg-clear"
          >Remove Message…</ConfirmButton>
        )}
      />
      {!ready ? <HubUnreachable serverId={serverId} /> : (
        <QueryState query={q} skeleton={<PropertySkeleton rows={6} />}>
          <SectionGrid>
            <Section title="Message" description="Plain text. Line breaks are kept.">
              <Textarea
                value={text}
                onChange={(e) => setText(e.currentTarget.value)}
                autosize minRows={12} maxRows={24}
                placeholder="Welcome to the corporate VPN. Unauthorised use is prohibited."
                error={tooLong || undefined}
                data-testid="hub-msg-text"
                aria-label="Message text"
              />
              <div className="sem-row-inline" style={{ justifyContent: "space-between", width: "100%", marginTop: "var(--sem-space-3)" }}>
                <Caption tone={tooLong ? "red" : undefined} testId="hub-msg-count">
                  {chars.toLocaleString()} of {MAX_LEN.toLocaleString()} characters{tooLong ? " — shorten the message to save it" : ""}
                </Caption>
                <Caption>{new TextEncoder().encode(text).length.toLocaleString()} bytes as UTF-8</Caption>
              </div>
              {hasNonBmp && (
                <div className="sem-callouts">
                  <Callout tone="yellow" title="Emoji won’t display correctly" testId="hub-msg-nonbmp">
                    SoftEther can’t store emoji and other characters outside the Basic Multilingual Plane. They appear garbled on clients.
                  </Callout>
                </div>
              )}
            </Section>

            <Section title="Preview" description="Roughly how SoftEther VPN Client shows it.">
              <div className="hc-msg-window" data-testid="hub-msg-preview">
                <div className="hc-msg-head">
                  <span className="hc-msg-icon"><IconMessage size={18} stroke={1.6} /></span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="sem-strong">Message from the VPN Server</div>
                    <div className="sem-dim" style={{ fontSize: "var(--sem-fz-small)" }}>Virtual Hub “{hub}”</div>
                  </div>
                  {dirty && <Tag color="orange">Unsaved</Tag>}
                </div>
                <div className="hc-msg-body">
                  {text ? text : <span className="sem-dim" style={{ fontStyle: "italic" }}>No message. Clients don’t see a pop-up.</span>}
                </div>
              </div>
            </Section>
          </SectionGrid>
          <SaveBar
            dirty={dirty} disabled={tooLong} saving={save.isPending}
            onReset={() => setText(initial)}
            onSave={() => save.mutate({ HubName_str: hub, Msg_bin: text ? textToB64(text) : "" })}
            testId="hub-msg-save"
          />
        </QueryState>
      )}
      <style>{PREVIEW_CSS}</style>
    </>
  );
}

// The preview imitates a client dialog: an elevated surface with a header and a scrolling body. Tokens only.
const PREVIEW_CSS = `
.hc-msg-window { background: var(--sem-bg-elevated); border: 0.5px solid var(--sem-separator-strong); border-radius: var(--sem-radius-lg);
  box-shadow: var(--sem-shadow-2); overflow: hidden; }
.hc-msg-head { display: flex; align-items: center; gap: var(--sem-space-5); padding: var(--sem-space-5) var(--sem-space-6); border-bottom: 0.5px solid var(--sem-separator); background: var(--sem-bg-inset); }
.hc-msg-icon { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: var(--sem-radius-md); background: var(--sem-accent-soft); color: var(--sem-accent); flex: none; }
.hc-msg-body { padding: var(--sem-space-6); white-space: pre-wrap; word-break: break-word; max-height: 420px; overflow: auto; min-height: 120px; }
`;
