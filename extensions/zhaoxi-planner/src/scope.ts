import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";

export function resolveScope(context: OpenClawPluginToolContext<2>) {
  const audience = context.memoryAudience;
  if (!audience) {
    throw new Error("当前对话没有已验证的私有资料作用域，请在自己的会话中重试。");
  }
  const assertCurrent = () => {
    context.assertInvocationCurrent();
    context.assertMemoryAudienceCurrent?.();
  };
  assertCurrent();
  return { prefix: `${encodeURIComponent(JSON.stringify(audience))}:`, assertCurrent };
}
