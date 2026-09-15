import type { AccountStatus, DebridAdapter } from '../../types/domain.js';
import * as runtime from '../../src/runtime.js';
import { accountScope } from '../../src/utils/request-key.js';
import { prefix } from '../../src/utils/cache-keys.js';
import config from '../../src/config.js';
import debrid from '../../src/debrid/index.js';
import * as cache from '../../src/utils/cache.js';
import * as held from '../../src/debrid/protected.js';
import * as autofetch from '../../src/providers/autofetch.js';
import { applyDebrid } from '../../src/providers/index.js';

/** Hashes fixos compartilhados pelos testes de fila/dreno. */
export const H1 = '1111111111111111111111111111111111111111';
export const H2 = '2222222222222222222222222222222222222222';
export const H3 = '3333333333333333333333333333333333333333';
export const H4 = '4444444444444444444444444444444444444444';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drena microtarefas / setImmediate — usado com mock.timers. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Adaptador mínimo para gate/canAutoFetchBr; `status` e extras opcionais. */
export function mkAdapter(
  id: string,
  status?: (key: string) => Promise<AccountStatus>,
  extra: Partial<Pick<DebridAdapter, 'cacheCheck' | 'autofetchSource' | 'label' | 'short'>> = {},
): DebridAdapter {
  const cacheCheck = extra.cacheCheck ?? true;
  return {
    id,
    label: extra.label ?? id,
    short: extra.short ?? id.slice(0, 2).toUpperCase(),
    cacheCheck,
    ...(extra.autofetchSource != null ? { autofetchSource: extra.autofetchSource } : {}),
    keyUrl: '',
    checkCached: async () => ({ cached: new Set(), known: cacheCheck }),
    resolveLink: async () => null,
    accountStatus: status,
  };
}

/** Candidato BR dublado padrão dos testes de stall/recheck. */
export function brDubCandidate(
  infoHash: string,
  nameOrOpts: string | { name?: string; _quality?: string; _seeders?: number } = 'Coringa Dublado',
) {
  if (typeof nameOrOpts === 'string') {
    return { infoHash, name: nameOrOpts, _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 };
  }
  return {
    infoHash,
    name: nameOrOpts.name || 'Coringa Dublado',
    _br: true,
    _dubbed: true,
    _quality: nameOrOpts._quality || '1080p',
    _seeders: nameOrOpts._seeders ?? 1,
  };
}

/** Opções de instalação com autofetch BR + cachedOnly no Premiumize. */
export function autofetchUserOpts(apiKey: string, debridService = 'premiumize') {
  return {
    ...runtime.defaults(),
    debridService,
    debridApiKey: apiKey,
    debridCachedOnly: true,
    autoFetchBr: true,
  };
}

/** Contexto `runtime.run` só com serviço/chave Premiumize (sem cachedOnly). */
export function premiumizeRunCtx(apiKey: string, encoded: string) {
  return {
    opts: { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: apiKey },
    encoded,
  };
}

export function dinvKeyFor(adapterId: string, apiKey: string): string {
  return `${prefix('dinv')}${adapterId}:${accountScope(apiKey)}`;
}

export type DrainHarness = {
  account: string;
  enqueued: string[];
  searchKey: string;
  pmAdapter: DebridAdapter;
  run: (streams: any[]) => Promise<void>;
  setTorrentStatus: (fn: DebridAdapter['torrentStatus']) => void;
  cleanup: (hashes: string[]) => void;
};

/**
 * Harness de integração da fila/dreno do autofetch: stubs de enqueue,
 * torrentStatus e checkCached sobre o Premiumize, com limpeza de cache,
 * markers, holds e blacklist por hash. `stallStreak`/`recheckMax` são
 * overrides de config restaurados no cleanup.
 */
export function makeDrainHarness(
  key: string,
  options: { stallStreak?: number; recheckMax?: number } = {},
): DrainHarness {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalStall = config.debrid.autoFetchStallStreak;
  const originalRecheckMax = config.debrid.autoFetchRecheckMax;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const account = accountScope(key);
  const enqueued: string[] = [];
  const searchKey = `busca-${key}`;
  const userOpts = autofetchUserOpts(key);
  config.debrid.publicUrl = 'http://addon.test';
  if (options.stallStreak != null) config.debrid.autoFetchStallStreak = options.stallStreak;
  if (options.recheckMax != null) config.debrid.autoFetchRecheckMax = options.recheckMax;
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  debrid.checkCached = async () => ({ cached: new Set(), known: true });
  return {
    account, enqueued, searchKey, pmAdapter,
    async run(streams) {
      cache.set(searchKey, { streams: [], partial: false }, 900);
      await runtime.run({ opts: userOpts, encoded: `cfg-${key}` }, () =>
        applyDebrid(streams, { searchKey } as any));
      await flush();
    },
    setTorrentStatus(fn) { pmAdapter.torrentStatus = fn; },
    cleanup(hashes) {
      config.debrid.autoFetchStallStreak = originalStall;
      config.debrid.autoFetchRecheckMax = originalRecheckMax;
      config.debrid.publicUrl = originalPublicUrl;
      debrid.checkCached = originalCheck;
      pmAdapter.enqueue = originalEnqueue;
      pmAdapter.torrentStatus = originalTorrentStatus;
      pmAdapter.removeTorrent = originalRemoveTorrent;
      autofetch.releaseSearch(searchKey);
      autofetch.dropQueue(searchKey);
      cache.forget(searchKey);
      for (const h of hashes) {
        cache.forget(autofetch.deadKey('premiumize', account, h));
        cache.forget(autofetch.markerKey('premiumize', account, h));
        held.release(h, account);
      }
    },
  };
}
