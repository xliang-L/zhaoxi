import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { WeixinMessage } from "../api/types.js";

export function privateAgentId(accountId: string, senderId: string): string {
  return "wx-" + createHash("sha256").update(JSON.stringify([accountId, senderId])).digest("hex").slice(0, 32);
}

// Binding alone never admits a sender: the authenticated channel allowlist is also required.
export function hasPrivateRoute(config: OpenClawConfig, accountId: string, message: WeixinMessage,
  allowFrom: readonly string[]): boolean {
  const sender = message.from_user_id;
  if (!sender || message.group_id || !allowFrom.includes(sender)) return false;
  const agentId = privateAgentId(accountId, sender);
  return Boolean(config.bindings?.some(binding => binding.agentId === agentId &&
    binding.match.channel === "openclaw-weixin" && binding.match.accountId === accountId &&
    binding.match.peer?.kind === "direct" && binding.match.peer.id === sender));
}

/** sessionKey is the host-resolved producing session, never a model-supplied destination. */
export function assertPrivateOutbound(config: OpenClawConfig, accountId: string, to: string,
  sessionKey: string | undefined, allowFrom: readonly string[]): void {
  const sourceAgent = sessionKey?.match(/^agent:([^:]+):/i)?.[1];
  if (!sourceAgent || sourceAgent !== privateAgentId(accountId, to) ||
      !hasPrivateRoute(config, accountId, { from_user_id: to }, allowFrom)) {
    throw new Error("Private outbound source and recipient do not match an admitted route");
  }
}
