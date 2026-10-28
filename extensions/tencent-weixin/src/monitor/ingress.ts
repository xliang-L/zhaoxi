import { createHash } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import {
  createChannelIngressMonitor,
  type ChannelIngressMonitorLifecycle,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { createInboundDebouncer, type InboundDebounceCreateParams } from "openclaw/plugin-sdk/channel-inbound-debounce";
import type { WeixinMessage } from "../api/types.js";
import type { FactSourceMessage } from "../messaging/fact-ingress.js";

type Payload = { version: number; body: WeixinMessage };
type Buffered = { message: WeixinMessage; lifecycle: ChannelIngressMonitorLifecycle; queuedAt: number; receivedAt: number };
let stateRuntime: PluginRuntime["state"] | undefined;

export function setIngressRuntime(runtime: PluginRuntime) {
  stateRuntime = runtime.state;
}

export function messageIdentity(message: WeixinMessage) {
  const peer = message.from_user_id?.trim();
  if (!peer || message.group_id) return null;
  const id = message.message_id?.trim() || message.item_list?.find(i => i.msg_id)?.msg_id;
  // Stable fallback is content-addressed, never random: a replay cannot acquire a new ID.
  const eventId = id || createHash("sha256").update(JSON.stringify(message)).digest("hex");
  return { eventId: `${peer}:${eventId}`, laneKey: peer };
}

function plainText(message: WeixinMessage): string | undefined {
  if (!message.item_list?.length || message.item_list.some(i => ![1, 2].includes(i.type ?? 0) || i.ref_msg)) return;
  return message.item_list.map(i => i.text_item?.text || "").join("\n");
}

export function mergeMessages(messages: WeixinMessage[]): WeixinMessage {
  if (messages.length === 1) return messages[0];
  if (messages.some(m => m.from_user_id !== messages[0].from_user_id || plainText(m) === undefined)) {
    throw new Error("Only text/images from the same peer can be combined.");
  }
  const last = messages[messages.length - 1];
  if (messages.every(m => m.item_list?.every(i => i.type === 1))) {
    return { ...last, item_list: [{ type: 1, text_item: { text: messages.map(m => plainText(m)).join("\n") } }] };
  }
  return { ...last, item_list: messages.flatMap(m => m.item_list ?? []) };
}

export function createWeixinIngress(options: {
  accountId: string;
  allowFrom: readonly string[];
  abortSignal?: AbortSignal;
  queue?: ChannelIngressQueue<Payload>;
  debounceMs?: number;
  onBatch?: (metadata: { peerHash: string; count: number; images: number; waitedMs: number; dispatchAt: number }) => void;
  onCompleted?: (metadata: { peerHash: string; count: number; completedAt: number; succeeded: boolean }) => void;
  dispatch: (message: WeixinMessage, lifecycle: ChannelIngressMonitorLifecycle, sources: readonly FactSourceMessage[]) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const settle = async (items: Buffered[], action: (life: ChannelIngressMonitorLifecycle) => unknown) => {
    // All claims must settle even if one storage write fails.
    const results = await Promise.allSettled(items.map(i => action(i.lifecycle)));
    const failed = results.find(r => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  type CreateFlush = Parameters<InboundDebounceCreateParams<Buffered>["onFlush"]>[1];
  const busy = new Map<string, Buffered[]>();
  let stopping = false;
  const compatible = (a: Buffered, b: Buffered) => plainText(a.message) !== undefined && plainText(b.message) !== undefined &&
    !plainText(a.message)!.trimStart().startsWith("/") && !plainText(b.message)!.trimStart().startsWith("/");
  const runBatch = (items: Buffered[], createFlush: CreateFlush) => createFlush({
    lifecycle: {
      abortSignal: AbortSignal.any(items.map(i => i.lifecycle.abortSignal)),
      onAdopted: () => settle(items, l => l.onAdopted()),
      onDeferred: () => { items.forEach(i => i.lifecycle.onDeferred()); },
      onDeferredHeartbeat: () => items.forEach(i => i.lifecycle.onDeferredHeartbeat?.()),
      onAbandoned: () => settle(items, l => l.onAbandoned()),
      onFailed: error => settle(items, l => l.onFailed?.(error)),
    },
    dispatch: async lifecycle => {
      lifecycle.abortSignal.throwIfAborted();
      options.onBatch?.({ peerHash: createHash("sha256").update(options.accountId + ":" + items[0].message.from_user_id).digest("hex").slice(0, 12), count: items.length, images: items.reduce((n, item) => n + (item.message.item_list?.filter(i => i.type === 2).length ?? 0), 0), waitedMs: Date.now() - items[0].queuedAt, dispatchAt: Date.now() });
      let succeeded = false;
      try { await options.dispatch(mergeMessages(items.map(i => i.message)), { ...lifecycle, admission: "exclusive" }, items.map(i => ({message:i.message,receivedAt:i.receivedAt}))); succeeded = true; }
      finally { options.onCompleted?.({peerHash:createHash("sha256").update(options.accountId + ":" + items[0].message.from_user_id).digest("hex").slice(0,12),count:items.length,completedAt:Date.now(),succeeded}); }
    },
  });
  const debouncer = createInboundDebouncer<Buffered>({
    debounceMs: options.debounceMs ?? 1200,
    maxWaitMs: 5000,
    buildKey: item => item.message.from_user_id,
    shouldDebounce: item => plainText(item.message) !== undefined && !plainText(item.message)!.trimStart().startsWith("/"),
    canAppend: (item, pending) => pending.length < 20 && compatible(item, pending[0]),
    shouldHoldFlush: async items => Boolean((await items[items.length - 1].lifecycle.readLaneBacklog?.())?.length),
    onFlush: (items, createFlush) => {
      const key = items[0].message.from_user_id!;
      const existing = busy.get(key);
      if (existing) { existing.push(...items); return { admission: Promise.resolve(), completion: Promise.resolve() }; }
      busy.set(key, []);
      // Hold through full dispatch completion, not onAdopted or a quick acknowledgement.
      const completion = (async () => {
        let batch = items;
        try {
          while (batch.length && !stopping) {
            try { await runBatch(batch, createFlush).completion; }
            catch (error) { options.onError(error); }
            // Admission persists before the native monitor hands off its lifecycle.
            // Include already-admitted rows even when that handoff races final completion.
            const backlog = await batch[batch.length - 1].lifecycle.readLaneBacklog?.() ?? [];
            const waiting = new Set(backlog.map(row => row.id));
            while (!stopping && [...waiting].some(id => !busy.get(key)!.some(item => messageIdentity(item.message)?.eventId === id))) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            const pending = busy.get(key)!;
            // Synchronous splice is the per-peer atomic handoff. Later arrivals join the next batch.
            const count = pending.findIndex((item, index) => index > 0 && !compatible(item, pending[0]));
            batch = pending.splice(0, count < 0 ? pending.length : count);
          }
          if (batch.length) await settle(batch, l => l.onCancelled?.());
          const pending = busy.get(key) ?? [];
          if (pending.length) await settle(pending, l => l.onCancelled?.());
        } finally { busy.delete(key); }
      })();
      return { admission: completion, completion };
    },
    onError: options.onError,
    onCancel: items => { void settle(items, l => l.onCancelled?.()).catch(options.onError); },
  });
  const heartbeat = setInterval(() => {
    for (const pending of busy.values()) for (const item of pending) item.lifecycle.onDeferredHeartbeat?.();
  }, 5000);
  heartbeat.unref();
  const monitor = createChannelIngressMonitor<WeixinMessage, WeixinMessage, Payload>({
    queue: options.queue ?? (() => {
      if (!stateRuntime) throw new Error("Native ingress state runtime is unavailable.");
      return stateRuntime.openChannelIngressQueue<Payload>({ accountId: options.accountId });
    }),
    inspect: message => options.allowFrom.includes(message.from_user_id ?? "")
      ? messageIdentity(message) : null,
    payload: {
      version: 1,
      serialize: message => message,
      deserialize: message => message,
      encode: envelope => envelope,
      decode: payload => payload,
      createClaimError: () => new Error("Weixin ingress identity or version mismatch."),
    },
    deliver: (message, lifecycle, claim) => {
      lifecycle.onDeferred();
      // Replay keeps the native queue's original admission time for fact consent/deletion barriers.
      const item = { message, lifecycle, queuedAt: Date.now(), receivedAt: claim.receivedAt };
      const pending = busy.get(message.from_user_id!);
      if (pending) pending.push(item);
      else void debouncer.enqueue(item).catch(options.onError);
      return { kind: "deferred" };
    },
    abortSignal: options.abortSignal,
    pollIntervalMs: 300000,
    retention: "standard",
    deferredClaims: "settle-on-abort",
    drain: { orderBy: "received", deferredLaneOccupancy: "release", startLimit: 32 },
    onError: options.onError,
  });
  let lastAdmissionAt = 0;
  return {
    start: monitor.start,
    admitBatch: async (messages: readonly WeixinMessage[]) => {
      const results = [];
      for (const message of messages) {
        lastAdmissionAt = Math.max(Date.now(), lastAdmissionAt + 1);
        results.push(await monitor.admit(message, { receivedAt: lastAdmissionAt }));
      }
      return results;
    },
    stop: async () => { stopping = true; clearInterval(heartbeat); await monitor.stop(); await debouncer.drain(); },
  };
}
