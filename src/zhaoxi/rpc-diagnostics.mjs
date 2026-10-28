// Login diagnostics retain failure class and reason without QR/credential values.
export function rpcDiagnostic(error, method) {
  const name = String(error?.name ?? 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
  const raw = String(error?.message ?? '');
  const outcomeUnknown = /already sent|outcome is unknown|timeout after/i.test(raw);
  const retryable = method === 'web.login.wait' && name === 'GatewayTransportError' &&
    /timeout|timed out|ECONNRESET|ECONNREFUSED|closed|disconnected|EPIPE/i.test(raw);
  let message = '';
  if (['web.login.start', 'web.login.wait'].includes(method)) {
    message = raw.split(/\r?\n/, 1)[0]
      .replace(/(?:https?|wss?):\/\/[^\s"']+/gi, '[url]')
      .replace(/data:image\/[^\s]+/gi, '[image]')
      .replace(/(["']?(?:[A-Za-z_]*(?:token|qrcode)|authorization|api[_-]?key|userId|senderId|accountId|sessionKey|verify[_-]?code)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi, '$1[redacted]')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[identity]')
      .replace(/[A-Za-z0-9_+-]{32,}/g, '[redacted]')
      .replace(/[\u0000-\u001f]/g, ' ').slice(0, 500);
  }
  return { name, message, outcomeUnknown, retryable };
}
