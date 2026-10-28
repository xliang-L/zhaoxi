import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rpcDiagnostic } from './rpc-diagnostics.mjs';

// Each invocation has one state directory. The SDK caches identity/config in-process.
const root = process.env.ZHAOXI_OPENCLAW_ROOT;
const require = createRequire(path.join(root, 'package.json'));
const { callGatewayFromCli } = await import(
  pathToFileURL(require.resolve('openclaw/plugin-sdk/gateway-runtime')).href
);
process.stdin.setEncoding('utf8');
let input = '';
for await (const chunk of process.stdin) input += chunk.toString('utf8');
const request = JSON.parse(input);
const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
try {
  let result;
  if (request.method === 'local.peerSessionKey') {
    const { buildAgentSessionKey } = await import(
      pathToFileURL(require.resolve('openclaw/plugin-sdk/routing')).href
    );
    const accountId = request.params.accountId ?? 'primary';
    const binding = config.bindings?.find(b => b.match.channel === 'openclaw-weixin' &&
      b.match.accountId === accountId && b.match.peer?.kind === 'direct' && b.match.peer.id === request.params.owner);
    if (!binding) throw new Error('No admitted private route');
    result = { sessionKey: buildAgentSessionKey({ agentId: binding.agentId, channel: 'openclaw-weixin',
      accountId, peer: { kind: 'direct', id: request.params.owner },
      dmScope: 'per-account-channel-peer' }) };
  } else result = await callGatewayFromCli(
    request.method,
    { timeout: String(request.timeoutMs ?? 45000), json: true, expectFinal: request.method === 'agent',
      port: String(config.gateway.port), expectUrl: `ws://127.0.0.1:${config.gateway.port}` },
    request.params,
    request.method === 'agent' ? { scopes: ['operator.admin'] } : undefined,
  );
  if (request.method === 'web.login.wait' && result?.connected && typeof result.accountId === 'string') {
    const { normalizeAccountId } = await import(
      pathToFileURL(require.resolve('openclaw/plugin-sdk/account-id')).href
    );
    result.credentialAccountId = normalizeAccountId(result.accountId);
  }
  process.stdout.write('\nZHAOXI_RPC_RESULT:' + JSON.stringify({ ok: true, result }) + '\n');
} catch (error) {
  const diagnostic = rpcDiagnostic(error, request.method);
  process.stdout.write('\nZHAOXI_RPC_RESULT:' + JSON.stringify({ ok: false, code: diagnostic.name,
    message: diagnostic.message, outcomeUnknown: diagnostic.outcomeUnknown, retryable: diagnostic.retryable }) + '\n');
  process.exitCode = 1;
}
