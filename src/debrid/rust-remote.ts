/**
 * Adaptador que fala com a API interna do adom-debrid (127.0.0.1:8710).
 *
 * O Rust é a implementação — não existe segunda pergunta ao TypeScript. Prazo
 * vencido, rede, 5xx e 501 devolvem cache incompleto (`known:false`): o tempo
 * da resposta já foi gasto e, na AllDebrid, a checagem é um upload de verdade.
 * Chave recusada, cota e rate limit sobem como o erro do TypeScript. O play
 * nunca chama o adaptador TypeScript.
 */
import config from '../config.js';
import * as metrics from '../utils/metrics.js';
import type { AccountStatus, DebridAdapter } from '../../types/domain.js';
import {
  AuthError,
  BlockedError,
  DubLieError,
  EpisodePickError,
  NoVideoError,
  QuotaError,
  RateLimitError,
  WorkPickError,
} from './common.js';
import { alldebridLinkFacts } from './rust-link-facts.js';
import { alldebridCheckFacts } from './alldebrid-cleanup-facts.js';
import { adoptBlockedReady } from './rust-check-blocked.js';
import { takeResolveEffect, type RustResolveEffect } from './rust-resolve-apply.js';
import { isAccountRefusal, playKind } from './rust-remote-kinds.js';
import { applyPlayEffects } from './rust-play-effects.js';
import { pullNativeMetrics } from '../utils/native-metrics.js';

class RustWriteError extends Error {
  isRustWriteError = true;
  constructor(message: string) {
    super(message);
    this.name = 'RustWriteError';
  }
}

interface RemoteOptions {
  baseUrl: string;
  token: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

type RemoteFailure = {
  ok: false;
  message: string;
  status?: number;
  kind?: string;
  error?: string;
  jsonMessage?: string;
  evidence?: unknown;
  context?: unknown;
  effect?: unknown;
  files?: unknown;
};

type RemoteResult =
  | { ok: true; json: unknown }
  | RemoteFailure;

function remoteOptions(overrides: Partial<RemoteOptions> = {}): RemoteOptions {
  const base = process.env.DEBRID_INTERNAL_URL || 'http://127.0.0.1:8710';
  const token = process.env.DEBRID_INTERNAL_TOKEN || config.jackett.testToken || '';
  return {
    baseUrl: base.replace(/\/$/, ''),
    token,
    fetchImpl: globalThis.fetch,
    timeoutMs: config.debrid.timeout,
    ...overrides,
  };
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

async function readErrorFields(res: Response): Promise<Pick<RemoteFailure, 'kind' | 'error' | 'jsonMessage' | 'evidence' | 'context' | 'effect' | 'files'>> {
  try {
    const json: unknown = await res.json();
    if (!json || typeof json !== 'object') return {};
    const body = json as {
      error?: unknown;
      kind?: unknown;
      message?: unknown;
      evidence?: unknown;
      context?: unknown;
      effect?: unknown;
      files?: unknown;
    };
    return {
      kind: textField(body.kind),
      error: textField(body.error),
      jsonMessage: textField(body.message),
      evidence: body.evidence,
      context: body.context,
      effect: body.effect,
      files: body.files,
    };
  } catch {
    return {};
  }
}

async function post(
  opts: RemoteOptions,
  path: string,
  body: Record<string, unknown>,
): Promise<RemoteResult> {
  if (!opts.token) return { ok: false, message: 'token ausente' };
  try {
    const res = await opts.fetchImpl(`${opts.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Indexer-Test-Token': opts.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) {
      const fields = await readErrorFields(res);
      return { ok: false, status: res.status, message: `HTTP ${res.status}`, ...fields };
    }
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false, message: 'rede' };
  }
}

/** A mensagem do JSON entra no erro; a chave da conta não. */
function redact(message: string, secrets: readonly string[]): string {
  let text = message;
  for (const secret of secrets) {
    if (secret.length < 8 || !text.includes(secret)) continue;
    text = text.split(secret).join('[redacted]');
  }
  return text.replace(/((?:apiKey|apikey|token)=)[^&\s"'<>]+/gi, '$1[redacted]');
}

function withMessage(error: Error, message: string | undefined): Error {
  if (message) error.message = message;
  return error;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const n = finiteNumber(item);
    if (n != null) out.push(n);
    if (out.length >= 8) break;
  }
  return out;
}

/** Nome de arquivo para o log do episódio. Magnet e chave não entram. */
function clipSample(value: unknown, secrets: readonly string[], max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || /magnet:\?|urn:btih:/i.test(trimmed)) return undefined;
  return redact(trimmed, secrets).slice(0, max);
}

function episodeEvidence(value: unknown, secrets: readonly string[]) {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const wantedSeason = finiteNumber(raw.wantedSeason);
  const wantedEpisode = finiteNumber(raw.wantedEpisode);
  if (wantedSeason == null || wantedEpisode == null) return undefined;
  const sample = clipSample(raw.sample, secrets, 60);
  return {
    wantedSeason,
    wantedEpisode,
    declaredSeasons: numberList(raw.declaredSeasons),
    declaredEpisodes: numberList(raw.declaredEpisodes),
    ...(sample ? { sample } : {}),
  };
}

function episodeContext(value: unknown, secrets: readonly string[]) {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const videoCount = finiteNumber(raw.videoCount);
  if (videoCount == null) return undefined;
  const samples = Array.isArray(raw.samples)
    ? raw.samples.flatMap((item) => {
      const sample = clipSample(item, secrets, 70);
      return sample ? [sample] : [];
    }).slice(0, 3)
    : [];
  return { videoCount, samples };
}

function dubEvidence(evidence: unknown, context: unknown, secrets: readonly string[]) {
  const raw = evidence && typeof evidence === 'object' ? evidence as Record<string, unknown> : {};
  const ctx = episodeContext(context, secrets);
  const matchedGroup = textField(raw.matchedGroup) || ctx?.samples?.[0];
  const sample = clipSample(raw.sample, secrets, 120);
  const group = matchedGroup ? redact(matchedGroup, secrets) : undefined;
  return {
    videoCount: finiteNumber(raw.videoCount) ?? ctx?.videoCount ?? 0,
    ...(group ? { matchedGroup: group } : {}),
    ...(sample ? { sample } : {}),
  };
}

function playError(remote: RemoteFailure, secrets: readonly string[]): Error {
  const jsonMessage = remote.jsonMessage ? redact(remote.jsonMessage, secrets) : undefined;
  const fallback = redact(remote.message, secrets);
  let error: Error;
  switch (playKind(remote)) {
    case 'no_video':
      error = withMessage(new NoVideoError(), jsonMessage);
      break;
    case 'episode_pick':
      error = withMessage(new EpisodePickError(
        episodeEvidence(remote.evidence, secrets),
        episodeContext(remote.context, secrets),
      ), jsonMessage);
      break;
    case 'work_pick':
      error = withMessage(new WorkPickError(), jsonMessage);
      break;
    case 'dub_lie':
      error = withMessage(new DubLieError(dubEvidence(remote.evidence, remote.context, secrets)), jsonMessage);
      break;
    case 'blocked':
      error = new BlockedError(jsonMessage || fallback);
      break;
    case 'auth':
      error = new AuthError(jsonMessage || fallback);
      break;
    case 'quota':
      error = new QuotaError(jsonMessage || fallback);
      break;
    case 'rate_limit':
      error = new RateLimitError(jsonMessage || fallback);
      break;
    default:
      error = new RustWriteError(`debrid rust não resolveu o link (${jsonMessage || fallback})`);
  }
  const effect = takeResolveEffect(remote.effect);
  if (effect) (error as Error & { effect?: RustResolveEffect }).effect = effect;
  return error;
}

/** `unusable` do envelope nativo: só motivo textual classifica (`null` = sem recusa). */
function asUnusable(value: unknown): { reason: string; message: string } | undefined {
  const raw = value && typeof value === 'object' ? value as { reason?: unknown; message?: unknown } : {};
  const reason = textField(raw.reason);
  return reason ? { reason, message: textField(raw.message) ?? reason } : undefined;
}

function asCheck(json: unknown): { cached: Set<string>; complete: boolean; unusable?: { reason: string; message: string } } {
  const body = json && typeof json === 'object' ? json as { cached?: unknown; complete?: unknown; unusable?: unknown } : {};
  const hashes = Array.isArray(body.cached) ? body.cached.map((hash) => String(hash)) : [];
  const unusable = asUnusable(body.unusable);
  return { cached: new Set(hashes), complete: body.complete !== false, ...(unusable ? { unusable } : {}) };
}

function unchecked(): { cached: Set<string>; complete: false } {
  return { cached: new Set(), complete: false };
}

/**
 * Prazo da resposta no fetch. Sem timeoutMs fica o DEBRID_TIMEOUT_MS.
 * Prazo já vencido não abre HTTP.
 */
function checkFetchOptions(opts: RemoteOptions, timeoutMs: number | undefined): RemoteOptions | null {
  if (timeoutMs == null) return opts;
  if (timeoutMs <= 0) return null;
  return { ...opts, timeoutMs };
}

function wrap(adapter: DebridAdapter, overrides: Partial<RemoteOptions> = {}): DebridAdapter {
  const opts = remoteOptions(overrides);
  const out: DebridAdapter = { ...adapter };
  out.checkCached = async (apiKey, hashes, checkOpts) => {
    const fetchOpts = checkFetchOptions(opts, checkOpts?.timeoutMs);
    if (!fetchOpts) return unchecked();
    const facts = alldebridCheckFacts(adapter.id, apiKey, hashes);
    const remote = await post(fetchOpts, '/debrid/check', {
      service: adapter.id,
      apiKey,
      hashes,
      timeoutMs: checkOpts?.timeoutMs,
      fileHashes: checkOpts?.fileHashes,
      fileWaitTimeoutMs: checkOpts?.fileWaitTimeoutMs,
      ...(facts ?? {}),
    });
    if (remote.ok) {
      const result = asCheck(remote.json);
      // ⚡ que o filtro nativo escondeu: só com prova de PRONTO no inventário da
      // conta o hash volta ao `cached` e a marca `adrm` é expurgada.
      adoptBlockedReady(adapter.id, apiKey, remote.json, result.cached);
      return result;
    }
    // 501 = sem braço nativo: contrato INCOMPLETO, não segunda pergunta ao TS.
    if (remote.status === 501) return unchecked();
    const kind = playKind(remote);
    if (kind === 'auth' || kind === 'quota' || kind === 'rate_limit') {
      throw playError(remote, [apiKey, fetchOpts.token]);
    }
    // Uma vez por checagem: a 8710 não respondeu e o TS não repete o upload.
    metrics.count('rust.debrid.check.unreachable');
    return unchecked();
  };
  if (typeof adapter.accountStatus === 'function') {
    out.accountStatus = async (apiKey) => {
      const remote = await post(opts, '/debrid/account', { service: adapter.id, apiKey });
      if (remote.ok) return remote.json as AccountStatus;
      // Recusa não ganha segunda pergunta (o gateway já falou com o serviço);
      // 501 e queda também não: a conta é nativa, o TS não é plano B.
      if (isAccountRefusal(remote)) throw playError(remote, [apiKey, opts.token]);
      if (remote.status !== 501) metrics.count('rust.debrid.account.unreachable');
      throw new RustWriteError(`debrid rust não leu a conta (${redact(remote.message, [apiKey, opts.token])})`);
    };
  }
  // HMAC (infoHash + S/E + dica w) fica na rota, antes deste POST.
  out.resolveLink = async (apiKey, hash, episode) => {
    // held true = não apagar. Ausente no Rust protege; aqui o Node diz a verdade.
    const held = adapter.id === 'alldebrid' ? alldebridLinkFacts(apiKey, hash).held : undefined;
    const remote = await post(opts, '/debrid/link', {
      service: adapter.id,
      apiKey,
      hash,
      episode: episode ?? null,
      ...(held === undefined ? {} : { held }),
    });
    if (!remote.ok) {
      // Mentira de dublagem: o TS grava a prova antes de lançar.
      if (remote.files !== undefined) await applyPlayEffects(adapter.id, apiKey, hash, { files: remote.files });
      throw playError(remote, [apiKey, opts.token]);
    }
    const body = remote.json as { url?: unknown } | null;
    await applyPlayEffects(adapter.id, apiKey, hash, body);
    return body && typeof body.url === 'string' ? body.url : null;
  };
  return out;
}

/**
 * Recorte `rust.debrid.*` para o `/metrics.json`. Não gateia mais por
 * `rustServices` (o adaptador nativo existe independente do corte de busca) e
 * lê a 8710 pelo leitor comum das duas superfícies — com token só quando
 * configurado e fail-open. Sem a 8710, o marcador `unreachable` substitui a
 * ausência, como antes.
 */
async function pullMetrics(): Promise<Record<string, number>> {
  const native = await pullNativeMetrics();
  if (!native || !native.sources.debrid) return { 'rust.debrid.metrics.unreachable': 1 };
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(native.counters)) {
    if (key.startsWith('rust.debrid.')) out[key] = value;
  }
  return out;
}

export { RustWriteError, remoteOptions, wrap, pullMetrics };
