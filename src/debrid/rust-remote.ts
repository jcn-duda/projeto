/**
 * Adaptador que fala com a API interna do adom-debrid (127.0.0.1:8710).
 *
 * Leitura que o Rust ainda não faz cai no adaptador TypeScript. Escrita que
 * falha — inclusive 501, rede e token — não é refeita aqui: a conta não pode
 * receber o mesmo upload duas vezes.
 */
import config from '../config.js';
import type { DebridAdapter } from '../../types/domain.js';

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

type RemoteResult =
  | { ok: true; json: unknown }
  | { ok: false; message: string };

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
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false, message: 'rede' };
  }
}

function asCheck(json: unknown): { cached: Set<string>; complete: boolean } {
  const body = json && typeof json === 'object' ? json as { cached?: unknown; complete?: unknown } : {};
  const hashes = Array.isArray(body.cached) ? body.cached.map((hash) => String(hash)) : [];
  return { cached: new Set(hashes), complete: body.complete !== false };
}

function wrap(adapter: DebridAdapter, overrides: Partial<RemoteOptions> = {}): DebridAdapter {
  const opts = remoteOptions(overrides);
  const out: DebridAdapter = { ...adapter };
  out.checkCached = async (apiKey, hashes, checkOpts) => {
    const remote = await post(opts, '/debrid/check', {
      service: adapter.id,
      apiKey,
      hashes,
      timeoutMs: checkOpts?.timeoutMs,
      fileHashes: checkOpts?.fileHashes,
      fileWaitTimeoutMs: checkOpts?.fileWaitTimeoutMs,
    });
    if (!remote.ok) return adapter.checkCached(apiKey, hashes, checkOpts);
    return asCheck(remote.json);
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
  out.resolveLink = async (apiKey, hash, episode) => {
    const remote = await post(opts, '/debrid/link', {
      service: adapter.id,
      apiKey,
      hash,
      episode: episode ?? null,
    });
    if (!remote.ok) {
      throw new RustWriteError(`debrid rust não resolveu o link (${remote.message})`);
    }
    const body = remote.json as { url?: unknown } | null;
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
