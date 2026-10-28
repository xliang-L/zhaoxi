import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { hasPrivateRoute } from "../messaging/private-route.js";
import { readFrameworkAllowFromList } from "../auth/pairing.js";
import { createWeixinIngress, messageIdentity } from "./ingress.js";
import { loadWeixinAccount } from "../auth/accounts.js";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { WeixinMessage } from "../api/types.js";

import { getUpdates, classifyFetchError } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import { STALE_TOKEN_ERRCODE, pauseSession, getRemainingPauseMs } from "../api/session-guard.js";
import { processOneMessage } from "../messaging/process-message.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { logger } from "../util/logger.js";
import type { Logger } from "../util/logger.js";
import { redactBody } from "../util/redact.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export function isAfterBinding(message: WeixinMessage, cutoff?: number): boolean {
  if (!Number.isSafeInteger(cutoff)) return true; // Existing connections retain their current behavior.
  return Number.isSafeInteger(message.create_time_ms) && message.create_time_ms! >= cutoff!;
}

export type MonitorWeixinOpts = {
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  accountId: string;
  /** When non-empty, only messages whose from_user_id is in this list are processed. */
  allowFrom?: string[];
  config: import("openclaw/plugin-sdk/core").OpenClawConfig;
  runtime?: { log?: (msg: string) => void; error?: (msg: string) => void };
  /**
   * Gateway-injected channel runtime surface (reply/routing/session/media/commands/...).
   * Required for inbound message processing; provided by `ChannelGatewayContext.channelRuntime`.
   */
  channelRuntime: PluginRuntime["channel"];
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  /** Gateway status callback — called on each successful poll and inbound message. */
  setStatus?: (next: ChannelAccountSnapshot) => void;
};

/**
 * Long-poll loop: getUpdates -> normalize -> recordInboundSession -> dispatchReplyFromConfig.
 * Runs until abort.
 */
export async function monitorWeixinProvider(opts: MonitorWeixinOpts): Promise<void> {
  const {
    baseUrl,
    cdnBaseUrl,
    token,
    accountId,
    config,
    channelRuntime,
    abortSignal,
    longPollTimeoutMs,
    setStatus,
  } = opts;
  const log = opts.runtime?.log ?? (() => {});
  const errLog = opts.runtime?.error ?? ((m: string) => log(m));
  const aLog: Logger = logger.withAccount(accountId);

  if (!channelRuntime) {
    const msg =
      "channelRuntime missing on monitor opts; gateway must inject ChannelGatewayContext.channelRuntime";
    aLog.error(msg);
    throw new Error(msg);
  }

  log(`weixin monitor started (${baseUrl}, account=${accountId})`);
  aLog.info(
    `Monitor started: baseUrl=${baseUrl} timeoutMs=${longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS}`,
  );

  const syncFilePath = getSyncBufFilePath(accountId);
  aLog.debug(`syncFilePath: ${syncFilePath}`);

  const previousGetUpdatesBuf = loadGetUpdatesBuf(syncFilePath);
  let getUpdatesBuf = previousGetUpdatesBuf ?? "";

  if (previousGetUpdatesBuf) {
    log(`[weixin] resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
    aLog.debug(`Using previous get_updates_buf (${getUpdatesBuf.length} bytes)`);
  } else {
    log(`[weixin] no previous sync buf, starting fresh`);
    aLog.info(`No previous get_updates_buf found, starting fresh`);
  }

  const configManager = new WeixinConfigManager({ baseUrl, token }, log);

  const savedAccount = loadWeixinAccount(accountId) as ReturnType<typeof loadWeixinAccount> & { inboundAfterMs?: number };
  const owner = savedAccount?.userId?.trim();
  const inboundAfterMs = savedAccount?.inboundAfterMs;
  const paired = readFrameworkAllowFromList(accountId);
  const allowed = paired.length ? paired : owner ? [owner] : [];
  const routed = allowed.filter(sender => hasPrivateRoute(config, accountId, { from_user_id: sender }, allowed));
  const ingress = createWeixinIngress({
    accountId, allowFrom: routed, abortSignal,
    debounceMs: config.messages?.inbound?.byChannel?.["openclaw-weixin"] ?? config.messages?.inbound?.debounceMs ?? 1200,
    onBatch: metadata => aLog.warn("queue-batch " + JSON.stringify(metadata)),
    onCompleted: metadata => aLog.warn("queue-completed " + JSON.stringify(metadata)),
    onError: () => errLog("weixin durable ingress failure; retained for recovery"),
    dispatch: async (full, lifecycle, factSourceMessages) => {
      const recordActivity = async (phase: "start" | "end") => {
        const grants = readFrameworkAllowFromList(accountId);
        const currentOwner = loadWeixinAccount(accountId)?.userId?.trim();
        const event = messageIdentity(full);
        if (!event || !hasPrivateRoute(config, accountId, full, grants.length ? grants : currentOwner ? [currentOwner] : [])) return;
        try { await callGatewayFromCli("dafeiyu.activity", {timeout:"5000",json:true,port:String(config.gateway?.port),expectUrl:`ws://127.0.0.1:${config.gateway?.port}`}, {account:accountId,sender:full.from_user_id,eventId:event.eventId,phase}, {scopes:["operator.write"]}); }
        catch { errLog("private conversation activity metadata unavailable; no content recorded"); }
      };
      await recordActivity("start");
      try {
        const cachedConfig = await configManager.getForUser(full.from_user_id ?? "", full.context_token);
        await processOneMessage(full, { accountId, config, channelRuntime, baseUrl,
          cdnBaseUrl, token, typingTicket: cachedConfig.typingTicket,
          log, errLog, ingressLifecycle: lifecycle, factSourceMessages });
      } finally { await recordActivity("end"); }
    },
  });
  ingress.start();
  try {
  let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      aLog.debug(
        `getUpdates: get_updates_buf=${getUpdatesBuf.substring(0, 50)}..., timeoutMs=${nextTimeoutMs}`,
      );
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        // Stop/hot-reload should cancel the in-flight long-poll immediately
        // instead of waiting for the server-side long-poll timeout.
        abortSignal,
      });
      aLog.debug(
        `getUpdates response: ret=${resp.ret}, msgs=${resp.msgs?.length ?? 0}, get_updates_buf_length=${resp.get_updates_buf?.length ?? 0}`,
      );

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
        aLog.debug(`Updated next poll timeout: ${nextTimeoutMs}ms`);
      }
      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);
      if (isApiError) {
        const isStaleToken =
          resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE;

        if (isStaleToken) {
          pauseSession(accountId);
          const pauseMs = getRemainingPauseMs(accountId);
          aLog.error(
            `getUpdates: token for ${accountId} is stale, pausing all requests for ${Math.ceil(pauseMs / 60_000)} min`,
          );
          consecutiveFailures = 0;
          await sleep(pauseMs, abortSignal);
          continue;
        }

        consecutiveFailures += 1;
        errLog(
          `weixin getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        aLog.error(
          `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg} response=${redactBody(JSON.stringify(resp))}`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          errLog(
            `weixin getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
          );
          aLog.error(
            `getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
          );
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }
      consecutiveFailures = 0;
      setStatus?.({ accountId, lastEventAt: Date.now() });
      // Persist the whole received batch before advancing the transport cursor.
      // Admission does not wait for model work; native per-peer lanes own delivery.
      const admitted = (resp.msgs ?? []).filter(message => isAfterBinding(message, inboundAfterMs));
      if (admitted.length !== (resp.msgs?.length ?? 0)) {
        const undated = (resp.msgs ?? []).filter(message => !Number.isSafeInteger(message.create_time_ms)).length;
        aLog.warn("binding-admission withheld " + JSON.stringify({ old: (resp.msgs?.length ?? 0) - admitted.length - undated, undated }));
      }
      await ingress.admitBatch(admitted);
      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }
      if (resp.msgs?.length) setStatus?.({ accountId, lastInboundAt: Date.now() });

    } catch (err) {
      if (abortSignal?.aborted) {
        aLog.info(`Monitor stopped (aborted)`);
        return;
      }
      consecutiveFailures += 1;
      const classified = classifyFetchError(err);
      errLog(
        `weixin getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)} type=${classified.type} description=${classified.description}${classified.code ? ` code=${classified.code}` : ""}`,
      );
      aLog.error(
        `getUpdates error: ${String(err)}, type=${classified.type} code=${classified.code ?? "none"}, stack=${(err as Error).stack}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        errLog(
          `weixin getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
        );
        aLog.error(`getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
        consecutiveFailures = 0;
        await sleep(30_000, abortSignal);
      } else {
        await sleep(2000, abortSignal);
      }
    }
  }
  } finally {
    await ingress.stop();
  }
  aLog.info(`Monitor ended`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
