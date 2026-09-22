/**
 * Cliente HTTP do probe Jev dub-lie (ETAPA 2): um caso por request,
 * fan-out com concorrência limitada, timeout por AbortSignal próprio,
 * retry limitado para 429/5xx/timeout e FAIL-OPEN — erro nunca derruba
 * a corrida, vira linha com `error` no relatório (requisitos 4 e 5).
 *
 * FORA DO CAMINHO CRÍTICO: nada daqui é importado por `src/`. O `fetch`
 * é injetável (`fetchImpl`) para os testes locais exercitarem 401/403/
 * 429/5xx/timeout sem rede de verdade. A chave viaja SÓ no header
 * Authorization e nunca é impressa nem devolvida nas linhas.
 *
 * Contratos que os testes fixam:
 * - Um request BEM-SUCEDIDO nunca é repetido; o índice do próximo caso
 *   é tomado atomicamente (single-thread), sem despacho duplo.
 * - `onRow` é engolido se lançar (fail-open): callback quebrado não
 *   derruba a corrida nem reagenda request algum.
 * - Auth (401/403) para o AGENDAMENTO na primeira observação; requests
 *   JÁ EM VOO com concorrência > 1 concluem (podem também falhar auth,
 *   cada um com a própria linha `auth-recusada`) e nenhum novo caso é
 *   despachado depois. `attempts` reflete as tentativas REAIS do caso
 *   (0 = nunca enviado, com `auth-parada`).
 * - `threshold` ausente/não-finito cai em 0.55 — nunca tratar threshold
 *   ausente como 0 (absolveria tudo em silêncio).
 * - `latencyMs` mede até o body LIDO E PARSEADO, não só os headers.
 */
import { classifyRow, judge } from './jev-dub-lie-metrics.mjs';

export class ProbeHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ProbeHttpError';
    this.status = status;
  }
}

function isAuthStatus(status) {
  return status === 401 || status === 403;
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

/** Extrai usage de tokens de formas defensivas (input_tokens|prompt_tokens). */
function usageOf(json) {
  const u = json?.usage;
  if (!u || typeof u !== 'object') return null;
  const input = u.input_tokens ?? u.prompt_tokens;
  const output = u.output_tokens ?? u.completion_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return null;
  return { input: input ?? 0, output: output ?? 0 };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Uma requisição. Devolve { json, latencyMs, usage }, com latência
 * medida até o FIM da leitura/parse do body. Erros: ProbeHttpError com
 * status (auth/rate/server), Error com `timeout:true` no estouro do
 * AbortSignal e erro de rede do próprio fetch.
 */
export async function askOnce({ endpoint, key, model, questions, state, timeoutMs, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state, model, questions }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      const err = new ProbeHttpError(`HTTP ${res.status}`, res.status);
      err.body = json;
      err.retryAfterMs = Number(res.headers?.get?.('retry-after')) * 1000 || null;
      throw err;
    }
    return { json, latencyMs, usage: usageOf(json) };
  } catch (e) {
    if (e?.name === 'AbortError') {
      const err = new Error(`timeout após ${timeoutMs}ms`);
      err.timeout = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Roda o corpus inteiro com fan-out limitado (requisito 4: quantidade
 * limitada em voo, NÃO uma chamada sequencial por caso). Um caso = um
 * request (contrato SystemOne: um state por chamada).
 *
 * Política de erro (requisito 5, fail-open):
 * - 401/403 (auth): para de agendar novos requests — não vai curar na
 *   mesma corrida; casos nunca enviados viram linha `auth-parada` com
 *   attempts 0 (ver contratos no cabeçalho).
 * - 429/5xx/timeout/rede: até `maxAttempts` tentativas com backoff
 *   (Retry-After honrado até 5s); esgotou, linha com `error`.
 * - outro 4xx ou resposta sem noul: linha com `error`, sem retry.
 * Nunca lança: devolve as linhas na ORDEM DO CORPUS.
 */
export async function runCorpus({
  cases,
  buildState,
  questions,
  key,
  endpoint,
  model,
  threshold = 0.55,
  concurrency = 4,
  maxAttempts = 2,
  timeoutMs = 30000,
  fetchImpl,
  onRow,
  // Chave da pergunta lida em `answers.<questionId>.noul`. Default preserva
  // o contrato original do probe dub-lie; outros probes Jev (mesmo cliente,
  // mesmo fan-out/retry/auth) passam a própria pergunta aqui.
  questionId = 'is_dub_lie',
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`concorrência inválida: ${concurrency}`);
  // Default seguro: threshold ausente/inválido NÃO é 0.
  const th = Number.isFinite(Number(threshold)) ? Number(threshold) : 0.55;
  // Callback do consumidor nunca derruba a corrida nem reagenda request.
  const emit = (row) => {
    try {
      onRow?.(row);
    } catch {
      /* fail-open */
    }
  };
  const rows = new Array(cases.length);
  let nextIndex = 0;
  let authStopped = false;

  const runCase = async (c, index) => {
    let lastError = null;
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attemptsMade = attempt;
      try {
        const { json, latencyMs, usage } = await askOnce({
          endpoint, key, model, questions, timeoutMs, fetchImpl,
          state: buildState(c),
        });
        const noul = json?.answers?.[questionId]?.noul;
        if (typeof noul !== 'number') {
          const err = new Error('resposta sem noul numérico');
          err.permanent = true; // falha determinística: retry não conserta
          throw err;
        }
        const predLie = judge(noul, th);
        const row = {
          id: c.id,
          group: c.group,
          expectLie: c.expectLie,
          noul,
          predLie,
          kind: classifyRow(c.expectLie, predLie),
          ok: predLie === c.expectLie,
          attempts: attemptsMade,
          latencyMs,
          usage,
          error: null,
        };
        rows[index] = row;
        emit(row);
        return;
      } catch (e) {
        lastError = e;
        if (e instanceof ProbeHttpError && isAuthStatus(e.status)) {
          authStopped = true;
          break;
        }
        const shouldRetry =
          attempt < maxAttempts &&
          !e.permanent &&
          (e.timeout ||
            (e instanceof ProbeHttpError && isRetryableStatus(e.status)) ||
            !(e instanceof ProbeHttpError));
        if (!shouldRetry) break;
        const waitMs = Math.min(e.retryAfterMs || 0, 5000) || 500 * attempt;
        await sleep(waitMs);
      }
    }
    const message =
      lastError instanceof ProbeHttpError && isAuthStatus(lastError.status)
        ? `auth-recusada (HTTP ${lastError.status})`
        : String(lastError?.message || lastError);
    const row = {
      id: c.id,
      group: c.group,
      expectLie: c.expectLie,
      noul: null,
      predLie: null,
      kind: null,
      ok: null,
      attempts: attemptsMade,
      latencyMs: null,
      usage: null,
      error: message,
    };
    rows[index] = row;
    emit(row);
  };

  const worker = async () => {
    while (!authStopped) {
      const index = nextIndex++;
      if (index >= cases.length) return;
      await runCase(cases[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));

  // Auth parou o agendamento: os casos nunca enviados viram linha
  // explícita `auth-parada` em vez de buraco silencioso no relatório.
  for (let i = 0; i < cases.length; i++) {
    if (!rows[i]) {
      const c = cases[i];
      rows[i] = {
        id: c.id,
        group: c.group,
        expectLie: c.expectLie,
        noul: null,
        predLie: null,
        kind: null,
        ok: null,
        attempts: 0,
        latencyMs: null,
        usage: null,
        error: 'auth-parada',
      };
      emit(rows[i]);
    }
  }
  return rows;
}
