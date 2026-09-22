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
 * O cliente é GENÉRICO por pergunta: estado, perguntas e id chegam prontos do
 * chamador (o core monta via `JudgmentQuestion`). A allowlist do estado é
 * política de quem define a pergunta (questions-audio.ts manda só
 * `post_title`) — aqui não há conhecimento de pergunta alguma.
 */
import type { AskErrorKind, AskOk } from './types.js';

export class AskError extends Error {
  kind: AskErrorKind;
  status?: number;
  /** Retry-After (ms) quando 429 ou 529 trouxerem o header; null caso contrário. */
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
  /** Estado JÁ na allowlist da pergunta (saída de `buildState`). */
  state: Record<string, unknown>;
  /** Definição das perguntas no wire do System One. */
  questions: unknown;
  /** Id da pergunta no envelope de resposta (`answers.<id>.noul`). */
  questionId: string;
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
 * Uma requisição. Resolve `{ noul, usage?, model? }` ou rejeita `AskError` com
 * kind `auth` (401/403) | `rate` (429) | `http` (outro !ok, inclusive 529
 * Overloaded) | `timeout` (estouro do AbortSignal) | `network` (falha do
 * fetch) | `shape` (corpo sem noul válido). 429 e 529 honram `retry-after`
 * (§8.1: ambos pedem backoff, nunca retry imediato). A mensagem nunca inclui
 * a chave nem o corpo bruto do serviço.
 */
export async function askJevAudio({
  endpoint,
  apiKey,
  model,
  state,
  questions,
  questionId,
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
        body: JSON.stringify({ state, model, questions }),
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
      // 429 (rate) e 529 (Overloaded) pedem backoff com retry-after (§8.1). O
      // 529 mantém kind 'http' — é sobrecarga transitória do serviço, não
      // limite de taxa da chave; o header, quando veio, é honrado igual.
      if (kind === 'rate' || res.status === 529) {
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
    const noul = json?.answers?.[questionId]?.noul;
    if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      throw new AskError('shape', 'resposta sem noul valido em [0,1]');
    }
    return {
      noul,
      usage: usageOf(json),
      // Eco do model (§5): o serviço devolve o ID versionado que respondeu —
      // com alias de config (`jev-latest`) é a única prova de quem julgou.
      model: typeof json?.model === 'string' && json.model.trim() ? json.model.trim() : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}
