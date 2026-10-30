// Dublê da ponte administrativa do `streams.db` (gateway Rust).
//
// Desde o F4.2(c) o namespace `streams` é Rust-owned no processo Node: nada
// nasce no L1 (`cache.set` de chave `streams:v21:` é recusado) e os caminhos
// vivos — `/stream-trace.json`, `/resolve` e o `clear-cache` — só alcançam a
// lista pronta pela ponte administrativa. Este helper sobe um store EM MEMÓRIA
// atrás de `config.streamStore.url` e responde o contrato real
// (`GET /streams/trace`, `POST /streams/invalidate`, `POST /streams/clear`),
// para o teste exercitar o caminho de verdade (ponte → fallback) em vez de
// inventar uma entrada de L1 que a produção não tem.
import config from '../../src/config.js';
import { resetNativeStreamStore } from '../../src/utils/streams-store-native.js';
import { stubFetch, type FetchCall, type FetchResponse, type StubFetchHandler } from './stub.js';

/** Entrada como o Rust a guardaria: estado do SWR + ledger + lista pronta. */
export type BridgeEntry = {
  type: 'movie' | 'series';
  /** Id como o Node pede: `tt123` (filme) ou `tt123:1:2` (episódio). */
  id: string;
  /** Chave nativa (`streamsCacheKey`) — ausente = só o fallback por obra. */
  key?: string;
  cache?: { remainingS?: number; partial?: boolean; debridKnown?: boolean; stale?: boolean };
  trace?: unknown;
  searchMeta?: { names?: string[]; year?: number | null } | null;
  /** 4.2(b): o recompute é NATIVO — o dublê entrega o outcome pronto como o
   * gateway faria (found sem ledger); `undefined` = como antes (null). */
  recompute?: unknown;
  streams?: Array<{ name?: string; infoHash?: string; url?: string }>;
};

export type StreamsBridgeOptions = {
  entries?: BridgeEntry[];
  /**
   * Token efetivo da ponte E do gate de diagnóstico — em produção o token
   * próprio (`STREAM_STORE_ADMIN_TOKEN`) abre as rotas que apagam e o de
   * diagnóstico (`JACKETT_TEST_TOKEN`) só as de leitura. O dublê entrega o
   * MESMO valor nos dois porque nenhum dos chamadores aqui testa a recusa
   * por credencial (isso vive em `streams-store-clear-guard.test.ts`).
   */
  token?: string;
  /**
   * Responde o que NÃO é rota da ponte (debrid, Jackett…). Sem ele, uma URL
   * inesperada estoura: melhor o teste falhar alto que receber corpo mentiroso.
   */
  onOther?: StubFetchHandler;
};

export type StreamsBridge = {
  url: string;
  token: string;
  /** Registra/atualiza uma entrada como se o Rust tivesse acabado de gravá-la. */
  put(entry: BridgeEntry): void;
  /** Remove direto do store (para provar que a rota não acha mais nada). */
  drop(key: string): void;
  has(key: string): boolean;
  /** Entradas restantes — o que sobrou depois de invalidate/clear. */
  size(): number;
  /** Chamadas capturadas (a ordem importa em alguns testes). */
  calls: FetchCall[];
  /** Quantas chamadas foram para uma rota da ponte (`/streams/trace`…). */
  count(pathname: string): number;
  /** Devolve URL/token/fetch/config ao estado anterior. */
  restore(): void;
};

const URL_BASE = 'http://127.0.0.1:8722';
const DEFAULT_TOKEN = 'token-da-ponte';

function jsonResponse(body: unknown): FetchResponse {
  return { ok: true, status: 200, json: async () => body };
}

function finishedAt(entry: BridgeEntry): number {
  const trace = entry.trace as { finishedAt?: number; startedAt?: number } | null | undefined;
  return Number(trace?.finishedAt ?? trace?.startedAt ?? 0);
}

function entryKey(entry: BridgeEntry): string {
  return entry.key || `${entry.type}:${entry.id}`;
}

/**
 * Instala o dublê e devolve o handle. O `restore` é obrigatório no `finally`
 * (ou no `afterEach`): a ponte é um singleton de módulo e o `fetch` é global.
 */
export function createStreamsBridge(options: StreamsBridgeOptions = {}): StreamsBridge {
  const savedConfig = { ...config.streamStore };
  const savedToken = config.jackett.testToken;
  const token = options.token || DEFAULT_TOKEN;
  const store = new Map<string, BridgeEntry>();
  for (const entry of options.entries || []) store.set(entryKey(entry), entry);

  config.streamStore.url = URL_BASE;
  // Token próprio preenchido: é dele que sai a credencial DESTRUTIVA do
  // `/streams/clear` (precedência `STREAM_STORE_ADMIN_TOKEN`).
  config.streamStore.token = token;
  config.streamStore.timeoutMs = 500;
  config.streamStore.backoffMs = 0;
  config.jackett.testToken = token;
  resetNativeStreamStore();

  const stub = stubFetch((rawUrl, init) => {
    const url = new URL(rawUrl);
    if (rawUrl.startsWith(URL_BASE)) {
      if (url.pathname === '/streams/trace') {
        const type = String(url.searchParams.get('type') || '');
        const id = String(url.searchParams.get('id') || '');
        const key = url.searchParams.get('key');
        const exact = key ? store.get(key) : undefined;
        // Contrato do Rust: a chave EXATA vence; sem ela, a build mais recente
        // da obra (é assim que a rota global acha o escopo de uma instalação).
        const candidates = [...store.values()].filter((e) => e.type === type && e.id === id);
        const chosen = exact
          ?? candidates.sort((a, b) => finishedAt(b) - finishedAt(a))[0];
        if (!chosen) return jsonResponse({ ok: true, found: false, source: 'rust' });
        return jsonResponse({
          ok: true,
          found: true,
          source: 'rust',
          cache: { remainingS: 900, partial: false, debridKnown: false, stale: false, ...(chosen.cache || {}) },
          trace: chosen.trace ?? null,
          searchMeta: chosen.searchMeta ?? null,
          recompute: chosen.recompute ?? null,
          streams: chosen.streams ?? [],
        });
      }
      if (url.pathname === '/streams/invalidate') {
        const body = JSON.parse(String(init?.body || '{}')) as { imdbId?: string };
        const obra = String(body.imdbId || '').toLowerCase();
        let removed = 0;
        for (const [key, entry] of store) {
          if (obra && entry.id.split(':')[0].toLowerCase() === obra) {
            store.delete(key);
            removed += 1;
          }
        }
        return jsonResponse({ ok: true, scope: 'obra', removed });
      }
      if (url.pathname === '/streams/clear') {
        const body = JSON.parse(String(init?.body || '{}')) as { suffix?: string };
        const suffix = body.suffix || '';
        let removed = 0;
        for (const [key] of store) {
          if (!suffix || key.endsWith(suffix)) {
            store.delete(key);
            removed += 1;
          }
        }
        return jsonResponse({ ok: true, removed, entries: 0 });
      }
      throw new Error(`rota da ponte não dublada: ${url.pathname}`);
    }
    if (options.onOther) return options.onOther(rawUrl, init);
    throw new Error(`fetch inesperado fora da ponte: ${rawUrl}`);
  });

  return {
    url: URL_BASE,
    token,
    put(entry) {
      store.set(entryKey(entry), entry);
    },
    drop(key) {
      store.delete(key);
    },
    has(key) {
      return store.has(key);
    },
    size() {
      return store.size;
    },
    calls: stub.calls,
    count(pathname) {
      return stub.calls.filter((call) => {
        try {
          return new URL(call.url).pathname === pathname;
        } catch {
          return false;
        }
      }).length;
    },
    restore() {
      stub.restore();
      config.streamStore = savedConfig;
      config.jackett.testToken = savedToken;
      resetNativeStreamStore();
    },
  };
}
