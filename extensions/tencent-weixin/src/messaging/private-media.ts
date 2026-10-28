import { collectReplyMediaEntries } from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

/** Resolve symlinks before upload; no account-wide media directory is implicitly readable. */
export async function resolvePrivateMediaPath(config: OpenClawConfig, agentId: string,
  input: string, currentInboundPath?: string | readonly string[]): Promise<string> {
  const workspace = config.agents?.entries?.[agentId]?.workspace;
  if (!workspace) throw new Error("Private media workspace unavailable");
  const root = await fs.realpath(workspace);
  const candidate = await fs.realpath(input.startsWith("file://") ? fileURLToPath(input) : path.resolve(root, input));
  const relative = path.relative(root, candidate);
  if (relative && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)) return candidate;
  for (const inbound of typeof currentInboundPath === "string" ? [currentInboundPath] : currentInboundPath ?? []) {
    if (candidate === await fs.realpath(inbound)) return candidate;
  }
  throw new Error("Private media path is outside the producing user's workspace");
}

/** Resolve host-prepared replies using SDK-owned provenance, never model attachment fields. */
export async function resolvePrivateReplyMediaPath(config: OpenClawConfig, agentId: string,
  payload: ReplyPayload, input: string, currentInboundPath?: string | readonly string[]): Promise<string> {
  try { return await resolvePrivateMediaPath(config, agentId, input, currentInboundPath); }
  catch (directError) {
    const entry = collectReplyMediaEntries(payload).find(item => item.url === input);
    for (const source of entry?.sourceUrls ?? []) {
      if (source.includes("://") && !source.startsWith("file://")) continue;
      let original: string;
      try { original = await resolvePrivateMediaPath(config, agentId, source, currentInboundPath); }
      catch { continue; }
      // Send the authorized original, retaining its real filename. A stale/changed
      // original must not silently replace the bytes selected by the host.
      const prepared = input.startsWith("file://") ? fileURLToPath(input) : input;
      const [sourceBytes,preparedBytes]=await Promise.all([fs.readFile(original),fs.readFile(prepared)]);
      if (!sourceBytes.equals(preparedBytes)) throw new Error("Prepared attachment no longer matches its authorized source");
      return original;
    }
    throw directError;
  }
}
