export type ReplyBubbleOptions = {
  requestText?: string;
  originalText?: string;
  maxMessages?: number;
};

/** Change presentation only: no extra model turn, timer, recipient or omitted content. */
export function splitReplyBubbles(text: string, options: ReplyBubbleOptions = {}): string[] {
  if (!text.trim() || text.length > 3600) return [text];
  const request = options.requestText ?? "";
  const original = options.originalText ?? text;
  const single = /(?:不要|别|不用)(?:再)?(?:拆|分|连(?:续)?发)|(?:只|就)(?:用|发|回|说)?(?:一条|一段|一则)|一条(?:消息)?就好|(?:合(?:并|起来)|放在一条|一次性)(?:回复|回答|发)/u.test(request);
  if (single || /```|~~~|^\s*[\[{]|(?:^|\n)\s*\|.*\|/u.test(original)) return [text];
  const multiple = /(?:连(?:续)?发|连续(?:给我)?发|分(?:成|开)?|拆(?:成|开)?|一条一条|一条条).{0,12}(?:条|消息|气泡)|(?:发|回|用|说).{0,4}(?:[二三四五六七八九十两2-9]|几|多)[条则]/u.test(request);
  if (!multiple && /(?:代码|脚本|报错|配置|步骤|方案|表格|列表|计划|提醒|日程|课程|备考|推导|计算|算一下|解释|讲解|分析|code|script|json|sql)/iu.test(request)) return [text];
  if (!multiple && /(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+[.)、]\s?|>)/u.test(original)) return [text];
  const normalized = text.replace(/\r\n/g, "\n");
  let parts = normalized.split(/\n[ \t]*\n+/u).map(part => part.trim()).filter(Boolean);
  if (parts.length < 2 && multiple) parts = normalized.split(/\n+/u).map(part => part.trim()).filter(Boolean);
  if (parts.length < 2 || (!multiple && (text.length > 900 || parts.some(part => part.length > 240)))) return [text];
  const limit = Math.max(1, Math.min(8, Math.floor(options.maxMessages ?? 8)));
  if (limit === 1) return [text];
  if (parts.length > limit) parts = [...parts.slice(0, limit - 1), parts.slice(limit - 1).join("\n\n")];
  return parts;
}
