import { createInternalHookEvent, triggerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import type { WeixinMessage } from "../api/types.js";

export type FactSourceMessage = { message: WeixinMessage; receivedAt: number };
export type FactIngressReceipt = { settled: boolean; outcomes: string[]; reason?: string };

/** The original native claim may complete only after its local fact decision is durable. */
export function withFactAdoptionBarrier<T extends { onAdopted: () => void | Promise<void> }>(
  lifecycle: T, completion: Promise<FactIngressReceipt>, assertAdmissionCurrent: () => void,
): T {
  let adopted: Promise<void> | undefined;
  return { ...lifecycle, onAdopted: () => adopted ??= completion.then(receipt => {
    if (!receipt.settled) throw new Error("Fact commit unconfirmed; native input was not adopted");
    assertAdmissionCurrent();
    return lifecycle.onAdopted();
  }) };
}

/** Original provider text only, after actual channel admission; never quotes, media/OCR, or agent text. */
export function emitVerifiedFactIngress(params: {
  sources: readonly FactSourceMessage[];
  account: string;
  sender: string;
  agentId: string;
  sessionKey: string;
  assertAdmissionCurrent: () => void;
}): Promise<FactIngressReceipt> {
  params.assertAdmissionCurrent();
  const messages = params.sources.flatMap(({ message, receivedAt }) => {
    if (message.from_user_id !== params.sender || message.group_id || message.message_type !== 1 ||
        !message.item_list?.length || message.item_list.some(item => item.type !== 1 || item.ref_msg)) return [];
    const messageId = message.message_id || message.item_list.find(item => item.msg_id)?.msg_id;
    if (!messageId) return [];
    const text = message.item_list.map(item => item.text_item?.text ?? "").join("\n");
    if (!text.trim() || text.trimStart().startsWith("/")) return [];
    return [{ messageId, text, sourceAt: message.create_time_ms ?? receivedAt, receivedAt }];
  });
  if (!messages.length) return Promise.resolve({ settled: true, outcomes: ["unsupported_or_command"] });
  // Start in parallel with reply preparation. Never serialize a pending raw body or authority.
  const batches: Promise<FactIngressReceipt>[] = [];
  for (let offset = 0; offset < messages.length; offset += 20) {
    const batch = messages.slice(offset, offset + 20);
    let receipt: Promise<FactIngressReceipt> | undefined, duplicateReceiver = false;
    const dispatch = triggerInternalHook(createInternalHookEvent("message", "dafeiyu-fact-ingress", params.sessionKey, {
      channelId: "openclaw-weixin", account: params.account, sender: params.sender,
      agentId: params.agentId, sessionKey: params.sessionKey, messages: batch,
      assertAdmissionCurrent: params.assertAdmissionCurrent,
      registerCompletion(completion: Promise<FactIngressReceipt>) {
        if (receipt) duplicateReceiver = true;
        receipt = Promise.resolve(completion);
      },
    }));
    batches.push(dispatch.then(async () => {
      if (!receipt || duplicateReceiver) return { settled: false, outcomes: [], reason: "handler_unavailable" };
      const result = await receipt;
      return result?.settled === true && Array.isArray(result.outcomes) && result.outcomes.length === batch.length
        ? result : { settled: false, outcomes: [], reason: "commit_unconfirmed" };
    }));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FactIngressReceipt>(resolve => {
    timer = setTimeout(() => resolve({ settled: false, outcomes: [], reason: "commit_timeout" }), 10000);
    timer.unref();
  });
  const finished = Promise.all(batches).then(results => ({
    settled: results.every(result => result.settled), outcomes: results.flatMap(result => result.outcomes),
    ...(results.some(result => !result.settled) ? { reason: "commit_unconfirmed" } : {}),
  })).catch(() => ({ settled: false, outcomes: [], reason: "commit_unconfirmed" }));
  return Promise.race([finished, timeout]).finally(() => clearTimeout(timer));
}
