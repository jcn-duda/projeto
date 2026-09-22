/**
 * Única dona do fetch TypeSafe (System One) no runtime — SHADOW-ONLY.
 *
 * Contratos do slice (todos cobertos por test/typesafe-client.test.ts):
 * - Segredo viaja SÓ no header `Authorization: Bearer` — nunca em query, log,
 *   cache ou mensagem de erro;
 * - 1 tentativa, SEM retry em voo (o título re-enfileira na próxima busca; a
 *   fila é quem arma cooldown/breaker);
 * - timeout por AbortController (teto de config: <= 3000 ms);
 * - parse defensivo: corpo não-JSON, envelope estranho ou `noul` fora de
 *   [0,1] é falha `shape` — nunca um número inventado;
 * - fail-open: lança `AskError` com `kind` FECHADO (vira métrica fixa) e a
 *   fila engole — chamador nenhum quebra.
 *
 * O estado enviado é `{ post_title }` (allowlist de questions-audio.ts); o
 * texto da pergunta é o espelho do probe validado online.
 */
import { QUESTION_ID, QUESTIONS, buildState } from './questions-audio.js';
import type { AskErrorKind, AskOk } from './types.js';

export class AskError extends Error {
  kind: AskErrorKind;
  status?: number;
  /** Retry-After (ms) quando o 429 trouxer o header; null caso contrário. */
  retryAfterMs?: number | null;

  constructor(kind: AskErrorKind, message: string) {
    super(message);
    this.name = 'AskError';
    this.kind = kind;
  }
}

export interface AskJevOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  title: string;
  timeoutMs: number;
  /** Injetável para testes; default é o fetch global (dublável por stubFetch). */
  fetchImpl?: typeof fetch;
}

/** Usage de tokens, lido de formas defensivas (input_tokens|prompt_tokens). */
function usageOf(json: any): AskOk['usage'] {
  const u = json?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const input = u.input_tokens ?? u.prompt_tokens;
  const output = u.output_tokens ?? u.completion_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return undefined;
  return { input: typeof input === 'number' ? input : 0, output: typeof output === 'number' ? output : 0 };
}

function isAuthStatus(status: number) {
  return status === 401 || status === 403;
}

/**
 * Uma requisição. Resolve `{ noul, usage? }` ou rejeita `AskError` com kind
 * `auth` (401/403) | `rate` (429) | `http` (outro !ok) | `timeout` (estouro do
 * AbortSignal) | `network` (falha do fetch) | `shape` (corpo sem noul válido).
 * A mensagem nunca inclui a chave nem o corpo bruto do serviço.
 */
export async function askJevAudio({
  endpoint,
  apiKey,
  model,
  title,
  timeoutMs,
  fetchImpl,
}: AskJevOptions): Promise<AskOk> {
  const doFetch = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state: buildState(title), model, questions: QUESTIONS }),
        signal: controller.signal,
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new AskError('timeout', `timeout apos ${timeoutMs}ms`);
      throw new AskError('network', 'falha de rede no TypeSafe');
    }
    // O body é lido como TEXTO e parseado com guarda: resposta não-JSON do
    // serviço é `shape`, não um crash de JSON.parse subindo pela fila.
    const text = await res.text();
    if (!res.ok) {
      const kind: AskErrorKind = isAuthStatus(res.status) ? 'auth' : res.status === 429 ? 'rate' : 'http';
      const err = new AskError(kind, `HTTP ${res.status}`);
      err.status = res.status;
      if (kind === 'rate') {
        const retryAfter = Number((res.headers as any)?.get?.('retry-after'));
        err.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
      }
      throw err;
    }
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const noul = json?.answers?.[QUESTION_ID]?.noul;
    if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      throw new AskError('shape', 'resposta sem noul valido em [0,1]');
    }
    return { noul, usage: usageOf(json) };
  } finally {
    clearTimeout(timer);
  }
}
