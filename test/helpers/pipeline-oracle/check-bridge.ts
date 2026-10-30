/**
 * Ponte de CHECAGEM do Node — oráculo de teste. Era o `checkCached` do `wrap`
 * em `src/debrid/rust-remote.ts`: o `/debrid/check` da 8710 com os fatos da
 * limpeza AllDebrid e a adoção do ⚡ bloqueado pelo `adrm`. Em produção a
 * checagem é do gateway (busca e autofetch nativos); esta ponte só serve aos
 * testes do contrato do check e da limpeza, e o registry não a monta.
 */
import * as metrics from '../../../src/utils/metrics.js';
import type { DebridAdapter } from '../../../types/domain.js';
import { post, remoteOptions, playError, type RemoteOptions } from '../../../src/debrid/rust-remote.js';
import { playKind } from '../../../src/debrid/rust-remote-kinds.js';
import { alldebridCheckFacts } from './alldebrid-cleanup-facts.js';
import { adoptBlockedReady } from './rust-check-blocked.js';

type CheckCached = NonNullable<DebridAdapter['checkCached']>;

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** `unusable` do envelope nativo: só motivo textual classifica (`undefined` = sem recusa). */
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

/**
 * `checkCached` pela 8710 para o adaptador, como o `wrap` fazia antes. O
 * `fetch` e o token são capturados na montagem, igual ao `wrap`.
 */
export function bridgedCheckCached(adapter: DebridAdapter, overrides: Partial<RemoteOptions> = {}): CheckCached {
  const opts = remoteOptions(overrides);
  return async (apiKey, hashes, checkOpts) => {
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
}

/** Adaptador com a ponte de checagem do oráculo por cima. */
export function withCheckBridge<T extends DebridAdapter>(adapter: T, overrides: Partial<RemoteOptions> = {}): T & { checkCached: CheckCached } {
  return { ...adapter, checkCached: bridgedCheckCached(adapter, overrides) };
}
