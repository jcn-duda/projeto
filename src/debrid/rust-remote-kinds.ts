/**
 * Régua dos envelopes da API interna do debrid (8710).
 *
 * Fica fora do `rust-remote.ts` porque os dois métodos (`checkCached`,
 * `accountStatus`) decidem igual: erro de conta = o gateway já perguntou ao
 * serviço e o TS não repete; 501 e o resto = sem veredito nativo.
 */

/** Status de play_status → kind. 401 do token interno fica de fora. */
const PLAY_KIND_BY_STATUS: Record<number, string> = {
  422: 'no_video',
  409: 'episode_pick',
  412: 'work_pick',
  406: 'dub_lie',
  451: 'blocked',
  403: 'auth',
  402: 'quota',
  429: 'rate_limit',
};

const PLAY_KINDS = new Set(Object.values(PLAY_KIND_BY_STATUS));

/** Recusa da conta: o serviço respondeu, então não cabe uma segunda pergunta. */
const ACCOUNT_REFUSAL_KINDS = new Set(['auth', 'quota', 'rate_limit']);

/** Campos que a classificação lê de um envelope de falha. */
interface FailureEnvelope {
  status?: number;
  kind?: string;
  error?: string;
}

function namedKind(kind: string | undefined, error: string | undefined): string | undefined {
  if (kind && PLAY_KINDS.has(kind)) return kind;
  if (error && PLAY_KINDS.has(error)) return error;
  return undefined;
}

function playKind(remote: FailureEnvelope): string | undefined {
  const named = namedKind(remote.kind, remote.error);
  if (named) return named;
  if (remote.kind || remote.error || remote.status == null) return undefined;
  return PLAY_KIND_BY_STATUS[remote.status];
}

function isAccountRefusal(remote: FailureEnvelope): boolean {
  const kind = playKind(remote);
  return kind != null && ACCOUNT_REFUSAL_KINDS.has(kind);
}

export { playKind, isAccountRefusal };
