// Dublê da API v4.1 da AllDebrid e utilidades de tempo compartilhadas pelos
// testes do 8.16 (evicção por busca) e do gate B-4 de deleção.
//
// O /magnet/upload é a própria checagem de cache (o eco prova o que trafegou),
// o /magnet/status alimenta inventário/varredura/evicção e o /magnet/delete é
// o ponto de deleção. `uploaded`/`deleted`/`ordem` são a prova do que de fato
// trafegou — `deleted` só ganha id BEM-sucedido, `ordem` registra o INÍCIO de
// cada tentativa (é o que expõe sobreposição entre chamadas concorrentes).
import config from '../../src/config.js';
import { prefix } from '../../src/utils/cache-keys.js';
import * as metrics from '../../src/utils/metrics.js';
import { preexisting } from '../../src/debrid/alldebrid-inventory.js';

export const adrmKey = (account: string, hash: string) => `${prefix('adrm')}${account}:${hash}`;
export const counter = (name: string) => metrics.snapshot().counters[name] ?? 0;

export interface MagRow {
  id: number;
  hash: string;
  filename: string;
  status: string;
  uploadDate: number;
}

export const mag = (id: number, hash: string, filename: string, uploadDate: number, status = 'Ready'): MagRow =>
  ({ id, hash, filename, status, uploadDate });

export interface MockOpts {
  /** Hashes que o /magnet/upload devolve prontos. */
  ready?: string[];
  /** Estado da conta para o /magnet/status. */
  account?: MagRow[];
  /** Estes ids têm o delete RECUSADO sempre (conta no teto). */
  failDeleteFor?: number[];
  /** A 1ª tentativa de cada id falha; a 2ª sai (para exercitar o backoff). */
  failFirstOnce?: boolean;
  /** Segura o /magnet/status SEM id (a leitura da evicção) até liberar. */
  statusGate?: { promise: Promise<void>; liberar: () => void } | null;
  /** O /magnet/status lança erro de rede. */
  failStatus?: boolean;
}

export function mockAd({
  ready = [], account = [], failDeleteFor = [], failFirstOnce = false, statusGate = null, failStatus = false,
}: MockOpts = {}) {
  const uploaded: string[] = [];
  const deleted: Array<string | number> = []; // deletes BEM-sucedidos
  const ordem: Array<string | number> = []; // ordem de INÍCIO das tentativas
  let statusCalls = 0;
  const tentadas = new Set<number>();
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const ok = (data: unknown) => ({ ok: true, async json() { return { status: 'success', data }; } });
    const erro = (code: string, message: string) => ({
      ok: true,
      async json() { return { status: 'error', error: { code, message } }; },
    });
    if (url.pathname.endsWith('/magnet/upload')) {
      const hashes = url.searchParams.getAll('magnets[]');
      uploaded.push(...hashes);
      return ok({ magnets: hashes.map((hash, i) => ({ hash, ready: ready.includes(hash), id: 700 + i })) });
    }
    if (url.pathname.endsWith('/magnet/status')) {
      const id = url.searchParams.get('id');
      if (id != null) return ok({ magnets: account.find((m) => m.id === Number(id)) ?? null });
      statusCalls += 1;
      if (failStatus) throw new Error('conta fora do ar');
      if (statusGate) await statusGate.promise;
      return ok({ magnets: [...account] });
    }
    if (url.pathname.endsWith('/magnet/delete')) {
      const id = Number(url.searchParams.get('id'));
      ordem.push(id);
      if (failDeleteFor.includes(id)) return erro('MAGNET_INVALID_ID', 'conta recusou');
      if (failFirstOnce) {
        if (tentadas.has(id)) { deleted.push(id); return ok({ message: 'deleted' }); }
        tentadas.add(id);
        return erro('MAGNET_TOO_MANY_ACTIVE', 'rajada');
      }
      deleted.push(id);
      return ok({ message: 'deleted' });
    }
    throw new Error(`URL inesperada no teste: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;

  return {
    uploaded,
    deleted,
    ordem,
    get statusCalls() { return statusCalls; },
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

/** Muta campos de config.debrid e devolve o restaurador. */
export const withDebrid = (patch: Record<string, unknown>) => {
  const saved = Object.entries(patch).map(([k]) => [k, (config.debrid as Record<string, unknown>)[k]] as const);
  Object.assign(config.debrid, patch);
  return () => {
    for (const [k, v] of saved) (config.debrid as Record<string, unknown>)[k] = v;
  };
};

/** Injeta o snapshot de proveniência (knownBefore fresco) de uma conta. */
export const inventario = (account: string, hashes: string[]) => {
  preexisting.set(account, { hashes: new Set(hashes), loadedAt: Date.now() });
};

export const soltaInventario = (account: string) => preexisting.delete(account);

/** Tempo para a rodada de fundo (status → seleção → delete) assentar. */
export const assenta = () => new Promise((resolve) => setTimeout(resolve, 50));

/** Espera uma métrica aparecer (deleções com backoff real levam segundos). */
export async function esperaMetrica(nome: string, tetoMs = 15000) {
  const inicio = Date.now();
  while (Date.now() - inicio < tetoMs) {
    if (counter(nome) > 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`métrica ${nome} não apareceu em ${tetoMs}ms`);
}

/** Portão de duas fases para segurar uma chamada da API no meio. */
export const gate = () => {
  let liberar!: () => void;
  const promise = new Promise<void>((r) => { liberar = r; });
  return { promise, liberar };
};
