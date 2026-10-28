import type { WeixinApiOptions } from "../api/api.js";
import type { MessageItem } from "../api/types.js";
import { MessageItemType } from "../api/types.js";
import { logger } from "../util/logger.js";

import { sendMessageItemWeixin } from "./send.js";

export type WeixinReplyProgressSenderDeps = {
  runId: string;
  send?: typeof sendMessageItemWeixin;
  acknowledgementDelayMs?: number;
  to: string;
  accountId: string;
  opts: WeixinApiOptions & {
    contextToken?: string;
    runId?: string;
    accountId?: string;
  };
};

type ToolItemEventPayload = {
  itemId?: string;
  kind?: string;
  title?: string;
  name?: string;
  phase?: string;
  status?: string;
};

function normalizeToolStatus(status?: string): string {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  return "unknown";
}

export class WeixinReplyProgressSender {
  readonly runId: string;

  private readonly to: string;
  private readonly accountId: string;
  private readonly opts: WeixinReplyProgressSenderDeps["opts"];
  private finalized = false;
  private acknowledgementTimer?: ReturnType<typeof setTimeout>;
  private acknowledged = false;
  private readonly send: typeof sendMessageItemWeixin;
  private readonly acknowledgementDelayMs: number;
  private sendChain: Promise<void> = Promise.resolve();

  constructor(deps: WeixinReplyProgressSenderDeps) {
    this.runId = deps.runId;
    this.send = deps.send ?? sendMessageItemWeixin;
    this.acknowledgementDelayMs = deps.acknowledgementDelayMs ?? 1500;
    this.to = deps.to;
    this.accountId = deps.accountId;
    this.opts = { ...deps.opts, runId: deps.runId, accountId: deps.accountId };
  }

  get replyOptions() {
    return {
      runId: this.runId,
      onItemEvent: (payload: ToolItemEventPayload) => this.handleToolItemEvent(payload),
    };
  }

  private enqueueMessage(item: MessageItem, label: string): void {
    if (this.finalized) return;
    this.sendChain = this.sendChain
      .then(async () => {
        await this.send({
          to: this.to,
          item,
          opts: this.opts,
          label,
        });
      })
      .catch((err) => {
        logger.warn(
          `${label}: failed to=${this.to} accountId=${this.accountId} runId=${this.runId} err=${String(err)}`,
        );
      });
  }

  private handleToolItemEvent(payload: ToolItemEventPayload): void {
    if (this.finalized) return;
    if (payload.kind !== "tool") return;
    if (payload.phase !== "start" && payload.phase !== "end") return;

    const now = Date.now();
    const toolName = payload.name?.trim() || payload.title?.trim() || "tool";
    const toolCallId = payload.itemId?.trim() || undefined;

    if (/web_search|web_fetch/.test(toolName)) {
      if (payload.phase === "start" && !this.acknowledged && !this.acknowledgementTimer) {
        this.acknowledgementTimer = setTimeout(() => {
          this.acknowledgementTimer = undefined;
          this.acknowledged = true;
          this.enqueueMessage({ type: MessageItemType.TEXT,
            text_item: { text: "我查一下，整理好就回你。" } }, "searchAcknowledgement");
        }, this.acknowledgementDelayMs);
        this.acknowledgementTimer.unref?.();
      } else if (payload.phase === "end") {
        clearTimeout(this.acknowledgementTimer);
        this.acknowledgementTimer = undefined;
      }
    }
    if (payload.phase === "start") {
      this.enqueueMessage(
        {
          type: MessageItemType.TOOL_CALL_START,
          create_time_ms: now,
          is_completed: false,
          tool_call_start_item: {
            tool_name: toolName,
            tool_call_id: toolCallId,
          },
        },
        "sendToolCallStartMessage",
      );
      return;
    }

    this.enqueueMessage(
      {
        type: MessageItemType.TOOL_CALL_RESULT,
        create_time_ms: now,
        is_completed: true,
        tool_call_result_item: {
          tool_name: toolName,
          tool_call_id: toolCallId,
          status: normalizeToolStatus(payload.status),
        },
      },
      "sendToolCallResultMessage",
    );
  }

  async beforeFinalReply(): Promise<void> {
    clearTimeout(this.acknowledgementTimer);
    this.acknowledgementTimer = undefined;
    await this.sendChain;
  }

  async finalize(): Promise<void> {
    await this.beforeFinalReply();
    if (this.finalized) return;
    this.finalized = true;
    try {
      await this.sendChain;
    } catch (err) {
      logger.warn(
        `WeixinReplyProgressSender.finalize: send drain failed runId=${this.runId} err=${String(err)}`,
      );
    }
  }
}
