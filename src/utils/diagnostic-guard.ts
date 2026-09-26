import crypto from 'node:crypto';

function authorized(expected: string, supplied: unknown) {
  if (!expected || !supplied) return false;
  const left = crypto.createHash('sha256').update(String(expected)).digest();
  const right = crypto.createHash('sha256').update(String(supplied)).digest();
  return crypto.timingSafeEqual(left, right);
}

function createDiagnosticGate({
  limit = 200,
  windowMs = 60_000,
  maxConcurrent = 1,
  now = Date.now,
  // O gate serve a mais de um endpoint desde que /seal-config passou a usá-lo;
  // os defaults preservam o texto que a página do diagnóstico já mostra.
  rateMessage = 'limite de testes atingido',
  busyMessage = 'já existe um teste em andamento',
} = {}) {
  const clients = new Map();
  let active = 0;

  function enter(client: string) {
    const time = now();
    const key = String(client || 'unknown');
    const recent = (clients.get(key) || []).filter((stamp: number) => time - stamp < windowMs);
    if (recent.length === 0) clients.delete(key);
    // `reason` é o contrato ESTÁVEL da recusa: o texto é parametrizável
    // (`rateMessage`/`busyMessage` mudam por chamador), então casar a mensagem
    // no cliente divergiria em silêncio. O painel decide o que mostrar pelo
    // reason e só cai no texto quando ele não vier.
    if (recent.length >= limit) return { ok: false, status: 429, reason: 'rate', error: rateMessage };
    if (active >= maxConcurrent) return { ok: false, status: 429, reason: 'busy', error: busyMessage };

    recent.push(time);
    clients.set(key, recent);
    active += 1;
    let released = false;
    return {
      ok: true,
      release() {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
      },
    };
  }

  return { enter };
}

export { authorized, createDiagnosticGate };
