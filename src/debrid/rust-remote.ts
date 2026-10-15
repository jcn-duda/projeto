/**
 * Adaptador que fala com a API interna do adom-debrid (127.0.0.1:8710).
 *
 * A checagem só cai no TypeScript quando o Rust responde 501 (ainda não
 * portado). Prazo vencido, rede e 5xx devolvem cache incompleto: o tempo da
 * resposta já foi gasto, e na AllDebrid a checagem é um upload de verdade.
 * Chave recusada, cota e rate limit sobem como o erro do TypeScript, sem
 * segunda pergunta. O play nunca chama o adaptador TypeScript.
 */
import config from '../config.js';
import * as metrics from '../utils/metrics.js';
import type { DebridAdapter } from '../../types/domain.js';
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
import { takeResolveEffect, type RustResolveEffect } from './rust-resolve-apply.js';
import { applyPlayEffects } from './rust-play-effects.js';

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

function namedKind(kind: string | undefined, error: string | undefined): string | undefined {
  if (kind && PLAY_KINDS.has(kind)) return kind;
  if (error && PLAY_KINDS.has(error)) return error;
  return undefined;
}

function playKind(remote: RemoteFailure): string | undefined {
  const named = namedKind(remote.kind, remote.error);
  if (named) return named;
  if (remote.kind || remote.error || remote.status == null) return undefined;
  return PLAY_KIND_BY_STATUS[remote.status];
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

function asCheck(json: unknown): { cached: Set<string>; complete: boolean } {
  const body = json && typeof json === 'object' ? json as { cached?: unknown; complete?: unknown } : {};
  const hashes = Array.isArray(body.cached) ? body.cached.map((hash) => String(hash)) : [];
  return { cached: new Set(hashes), complete: body.complete !== false };
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
    const remote = await post(fetchOpts, '/debrid/check', {
      service: adapter.id,
      apiKey,
      hashes,
      timeoutMs: checkOpts?.timeoutMs,
      fileHashes: checkOpts?.fileHashes,
      fileWaitTimeoutMs: checkOpts?.fileWaitTimeoutMs,
    });
    if (remote.ok) return asCheck(remote.json);
    // 501 = ainda não portado: o TS é a implementação, não uma segunda pergunta.
    if (remote.status === 501) return adapter.checkCached(apiKey, hashes, checkOpts);
    const kind = playKind(remote);
    if (kind === 'auth' || kind === 'quota' || kind === 'rate_limit') {
      throw playError(remote, [apiKey, fetchOpts.token]);
    }
    // Uma vez por checagem: a 8710 não respondeu e o TS não repete o upload.
    metrics.count('rust.debrid.check.unreachable');
    return unchecked();
  };
  if (typeof adapter.accountStatus === 'function') {
    const accountStatus = adapter.accountStatus.bind(adapter);
    out.accountStatus = async (apiKey) => {
      const remote = await post(opts, '/debrid/account', { service: adapter.id, apiKey });
      if (!remote.ok) return accountStatus(apiKey);
      return remote.json as Awaited<ReturnType<typeof accountStatus>>;
    };
  }
  if (typeof adapter.fileLink === 'function') {
    const fileLink = adapter.fileLink.bind(adapter);
    out.fileLink = async (apiKey, hash, path) => {
      const remote = await post(opts, '/debrid/files', { service: adapter.id, apiKey, hash, path });
      if (!remote.ok) return fileLink(apiKey, hash, path);
      const body = remote.json as { url?: unknown; size?: unknown } | null;
      if (!body || typeof body.url !== 'string') return null;
      return { url: body.url, size: Number(body.size) || 0 };
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

async function pullMetrics(overrides: Partial<RemoteOptions> = {}): Promise<Record<string, number>> {
  if (!config.debrid.rustServices.length) return {};
  const opts = remoteOptions(overrides);
  if (!opts.token) return { 'rust.debrid.metrics.unreachable': 1 };
  try {
    const res = await opts.fetchImpl(`${opts.baseUrl}/metrics`, {
      headers: {
        Accept: 'application/json',
        'X-Indexer-Test-Token': opts.token,
      },
      signal: AbortSignal.timeout(300),
    });
    if (!res.ok) return { 'rust.debrid.metrics.unreachable': 1 };
    const body = await res.json() as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key.startsWith('rust.debrid.') && typeof value === 'number') out[key] = value;
    }
    return out;
  } catch {
    return { 'rust.debrid.metrics.unreachable': 1 };
  }
}

export { RustWriteError, remoteOptions, wrap, pullMetrics };
