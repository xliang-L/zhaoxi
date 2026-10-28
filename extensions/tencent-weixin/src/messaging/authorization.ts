import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

export async function resolveWeixinInboundAuthorization(params: {
  accountId: string;
  senderId: string;
  rawBody: string;
  config: OpenClawConfig;
  commands: {
    shouldComputeCommandAuthorized: (body: string, config: OpenClawConfig) => boolean;
  };
  allowFrom: string[];
  channelRuntime: PluginRuntime["channel"];
  contextBinding: { agentId: string; sessionKey: string; messageId: string; inboundEventKind: "user_request" };
}) {
  const shouldComputeCommand = params.commands.shouldComputeCommandAuthorized(
    params.rawBody,
    params.config,
  );

  // A missing verified owner cannot authorize this private assistant.
  if (params.allowFrom.length === 0) {
    return { senderAllowed: false, commandAuthorized: false, channelIngress: undefined };
  }

  const ingress = await params.channelRuntime.inbound.ingress.resolve({
    contextBinding: params.contextBinding,
    channelId: "openclaw-weixin",
    accountId: params.accountId,
    identity: { primary: { normalize: (value) => value, sensitivity: "pii" } },
    subject: { stableId: params.senderId },
    conversation: { kind: "direct", id: params.senderId },
    event: { kind: "message", authMode: "inbound", mayPair: true },
    policy: { dmPolicy: "pairing", groupPolicy: "disabled" },
    readStoreAllowFrom: async () => params.allowFrom,
    ...(shouldComputeCommand
      ? { command: { allowTextCommands: true, hasControlCommand: true } }
      : {}),
  });

  return {
    channelIngress: ingress,
    senderAllowed: ingress.senderAccess.allowed,
    commandAuthorized: shouldComputeCommand ? ingress.commandAccess.authorized : undefined,
  };
}
