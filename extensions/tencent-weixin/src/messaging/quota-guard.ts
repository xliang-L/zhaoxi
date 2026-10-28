/** Metadata-only gate. A missing quota plugin never falls back to an unmetered model. */
export async function checkModelQuota(
  query: () => Promise<unknown>,
): Promise<{ allow: true } | { allow: false; reason: "exhausted" | "unavailable"; message: string }> {
  try {
    const result = await query() as { enabled?: unknown; limit?: unknown; remaining?: unknown; min_request_tokens?: unknown } | null;
    if (!result || result.enabled !== true) throw new Error("Quota admission unavailable");
    if (result.limit === null && result.remaining === null) return { allow: true };
    if (!Number.isSafeInteger(result.limit) || (result.limit as number) < 0 ||
        !Number.isSafeInteger(result.remaining) || (result.remaining as number) < 0) throw new Error("Quota admission unavailable");
    if (result.remaining === 0 || (Number.isSafeInteger(result.min_request_tokens) && (result.remaining as number) < (result.min_request_tokens as number))) return { allow: false, reason: "exhausted", message: "本月剩余额度不足以预留下一次回复，或仍有用量待核对。请等待北京时间下月额度更新，或联系管理员。暂停、关闭和取消设置仍可使用。" };
    return { allow: true };
  } catch {
    return { allow: false, reason: "unavailable", message: "暂时无法核对本月额度，这次没有调用模型。请稍后重试；暂停、关闭和取消设置仍可使用。" };
  }
}
