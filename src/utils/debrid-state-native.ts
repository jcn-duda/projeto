/**
 * Handles do ESTADO de debrid no núcleo Rust (`adom-index`): o ⚡ de
 * disponibilidade por hash (`davail:v1:<adapter>:<conta>:<hash>`, valor `1`/`0`),
 * o banco de magnets (`mag:v1:<alive|bad|lie>:<adapter>:<conta>:<hash>`) e o
 * AGREGADO durável desse banco (`mag_meta:v1:counts`, `counts`/`putCounts`).
 * Os três moram no MESMO `data/cache.db` que o Node e o gateway usam — aqui só
 * se abre o handle, como no `raw-store-native.ts`.
 *
 * O agregado entrou nesta ponte porque é DERIVADO do acervo: enquanto o Node o
 * gravava por `cache.set`, o mesmo dado tinha dois escritores de opinião (e uma
 * janela de desencontro, já que o `cache.set` só despeja no SQLite no
 * `setImmediate` seguinte). Agora escrita e leitura passam pelo MESMO handle que
 * grava as linhas contadas.
 *
 * A regra é do Rust: TTL (positivo e negativo têm janelas próprias; `ttlSeconds
 * <= 0` DESLIGA a janela e o store NÃO grava nada — a mesma regra do
 * `cache.setMany` do Node), escopo de conta, precedência `bad > lie > alive` e a
 * remoção do `alive` quando o `bad` nasce. Nada disso é reimplementado do lado
 * TS — os métodos devolvem o veredito cru do núcleo, e quem precisa do "não sei"
 * recebe `null` em vez de um falso ⚡.
 *
 * DONO ÚNICO (T2-L5b): `davail` e `mag` estão em `RUST_OWNED` (`cache-keys.ts`),
 * então o Node NÃO os carrega no L1 nem regrava no SQLite. A superfície do Node
 * é só esta ponte — escrever pelo `cache` seria um segundo escritor silencioso
 * (o `setMany` descarta a chave) e ler pelo L1 devolveria sempre vazio.
 *
 * `sweep` fechou o ciclo de vida que antes era da cota LRU do L1: apaga a linha
 * VENCIDA e, acima do teto do namespace, as mais antigas por ordem de escrita.
 * Sem ele o namespace cresceria para sempre (o Node não poda mais essas linhas).
 */
import config from '../config.js';
import { requireCore } from './rust-core.js';

/** Marca viva do banco de magnets (`mag:v1`). */
export type MagnetSide = 'alive' | 'bad' | 'lie';

/** Veredito de disponibilidade de um hash, como o `davail:v1` guarda. */
export type DavailFlag = { hash: string; cached: boolean };

/** Foto de um hash no banco de magnets; `null` = nenhuma evidência viva. */
export type MagnetMark = { hash: string; state: MagnetSide | null };

/** Uma linha VIVA do `mag` (enumeração de diagnóstico/painel). */
export type MagEntry = {
  adapter: string;
  side: MagnetSide;
  hash: string;
  /** Segundos até vencer; `null` = linha sem janela. */
  ttlRemainingSeconds: number | null;
};

/** Página da enumeração: o total casado vem junto para o painel paginar. */
export type MagPage = { items: MagEntry[]; matched: number; truncated: boolean };

/** Contagem por adapter × lado — o agregado que o painel mostra. */
export type MagCount = {
  adapter: string;
  side: MagnetSide;
  count: number;
  /**
   * Soma dos segundos restantes das linhas contadas. No `sweep` vem 0: a linha
   * removida já não tem janela, então não há o que somar.
   */
  ttlRemainingSum: number;
};

/** O que a varredura removeu do namespace. */
export type SweepRemoval = {
  expired: number;
  evicted: number;
  /** Só o `mag`: as linhas removidas por adapter × lado (decremento exato). */
  counts: MagCount[];
};

/** O que a varredura removeu do `davail` (sem contadores por lado). */
export type DavailSweep = { expired: number; evicted: number };

/** Soma dos segundos restantes por lado (`ttlRemainingSums` do agregado). */
export type MagMetaSums = { alive: number; bad: number; lie: number };

/** Contagem + TTL restante somado de um adapter no agregado. */
export type MagMetaTotals = {
  alive: number;
  bad: number;
  lie: number;
  ttlRemainingSums: MagMetaSums;
};

/**
 * `mag_meta:v1:counts` como o núcleo grava: a MESMA forma que o Node lia (o
 * `cache.db` herdado continua valendo). `version` só existe como 1 — payload de
 * outra versão o núcleo devolve como ausente, não como dado parcial.
 */
export type MagMetaPayload = {
  version: 1;
  /** Carimbo da gravação (`updatedAt`): base do envelhecimento da soma de TTL. */
  updatedAt: number;
  adapters: Record<string, MagMetaTotals>;
};

/** Linha do agregado na fronteira napi: uma por adapter, sem aninhar objeto. */
type MagMetaRow = {
  adapter: string;
  alive: number;
  bad: number;
  lie: number;
  ttlAlive: number;
  ttlBad: number;
  ttlLie: number;
};

/** O agregado cru como o `.node` devolve (`adapters` em array, não Record). */
type MagMetaRaw = { version: number; updatedAt: number; adapters: MagMetaRow[] };

export type DavailStateHandle = {
  /** `true`/`false` = evidência medida; `null` = ausente (não é "frio"). */
  get(adapter: string, apiKey: string, hash: string, nowMs: number): boolean | null;
  /** Só os hashes presentes e vivos, na ordem pedida, com hash em minúsculas. */
  getMany(adapter: string, apiKey: string, hashes: string[], nowMs: number): DavailFlag[];
  /** `ttlSeconds <= 0` não grava (janela desligada); sem conta, idem. */
  put(adapter: string, apiKey: string, hash: string, cached: boolean, ttlSeconds: number, nowMs: number): void;
  /** `ttlSeconds <= 0` não grava; a janela é UMA para todas as flags. */
  putMany(adapter: string, apiKey: string, flags: DavailFlag[], ttlSeconds: number, nowMs: number): void;
  /** Apaga TODAS as linhas do namespace. Devolve quantas saíram. */
  clear(): number;
  /** Apaga vencidas e, acima de `maxEntries`, as mais antigas por escrita. */
  sweep(maxEntries: number, nowMs: number): DavailSweep;
};

export type MagnetStateHandle = {
  /** Quantas chaves NASCERAM (renovação de chave viva não conta). */
  markAlive(adapter: string, apiKey: string, hashes: string[], ttlSeconds: number, nowMs: number): number;
  /** `true` = o `bad` nasceu agora. Apaga o `alive` do mesmo hash. */
  markBad(adapter: string, apiKey: string, hash: string, ttlSeconds: number, nowMs: number): boolean;
  /** `true` = o `lie` nasceu agora. NÃO apaga o `alive` do mesmo hash. */
  markLie(adapter: string, apiKey: string, hash: string, ttlSeconds: number, nowMs: number): boolean;
  /** `true` = havia `bad` para apagar; `alive`/`lie` ficam. */
  forgetBad(adapter: string, apiKey: string, hash: string): boolean;
  /**
   * Apaga o `bad` de QUALQUER conta do adapter (reparo do rd-warmer e limpeza
   * do painel, que enumeram por adapter e não têm a chave da conta em mãos) e
   * devolve quantas LINHAS saíram — uma por conta.
   */
  forgetBadOf(adapter: string, hash: string): number;
  state(adapter: string, apiKey: string, hash: string, nowMs: number): MagnetSide | null;
  /** Uma entrada por hash pedido, na ordem pedida (inclusive os sem marca). */
  stateSnapshot(adapter: string, apiKey: string, hashes: string[], nowMs: number): MagnetMark[];
  /** Segundos até a marca vencer; `null` = ausente, vencida ou sem janela. */
  remaining(adapter: string, apiKey: string, side: MagnetSide, hash: string, nowMs: number): number | null;
  /**
   * Enumeração das linhas VIVAS, já filtrada e truncada no núcleo (o painel não
   * atravessa 50 mil chaves para mostrar 50). `null` = sem filtro naquele eixo.
   */
  entries(adapter: string | null, side: MagnetSide | null, hash: string | null, limit: number, nowMs: number): MagPage;
  /** Agregado por adapter × lado numa passada só, sem hash no payload. */
  summary(nowMs: number): MagCount[];
  /** Quantas linhas vivas existem no namespace (o `l1Entries` do painel). */
  liveCount(nowMs: number): number;
  /** Hashes da leva que têm `lie` vivo em QUALQUER conta (lie global). */
  liveLies(hashes: string[], nowMs: number): string[];
  /** Apaga TODAS as linhas do namespace. Devolve quantas saíram. */
  clear(): number;
  /** Apaga vencidas e, acima de `maxEntries`, as mais antigas por escrita. */
  sweep(maxEntries: number, nowMs: number): SweepRemoval;
  /**
   * Agregado durável (`mag_meta:v1:counts`); `null` = ausente, vencido ou
   * ilegível. Quem lê reconta o acervo (`summary`) — nunca inventa contagem.
   */
  counts(nowMs: number): MagMetaPayload | null;
  /**
   * Grava o agregado com `updatedAt = nowMs` (o núcleo não aceita carimbo do
   * chamador). `ttlSeconds <= 0` = sem expiração.
   */
  putCounts(adapters: Record<string, MagMetaTotals>, ttlSeconds: number, nowMs: number): void;
  /** Apaga SÓ o agregado; `true` = havia o que apagar (idempotente). */
  forgetCounts(): boolean;
};

/**
 * O que o `.node` expõe antes da normalização: `counts` devolve `adapters` em
 * ARRAY e `putCounts` recebe array — a forma plana da fronteira. O resto da
 * classe é idêntico (a tipagem estrutural não sabe onde o método foi gerado).
 */
type MagnetStateNapi = Omit<MagnetStateHandle, 'counts' | 'putCounts'> & {
  counts(nowMs: number): MagMetaRaw | null;
  putCounts(adapters: MagMetaRow[], ttlSeconds: number, nowMs: number): void;
};

/** Construtor exportado pelo `.node`; todas as classes nativas abrem por caminho. */
type NativeClass<T> = new (dbPath: string) => T;

/**
 * O que esta ponte lê do núcleo. Tipagem ESTRUTURAL local de propósito: o
 * `.node` não carrega tipos e `NapiCore` (`rust-core.ts`) é de outra fatia —
 * não se estende o tipo compartilhado por causa de uma classe nova.
 */
type DebridStateCore = {
  DavailState?: NativeClass<DavailStateHandle>;
  MagnetStateStore?: NativeClass<MagnetStateNapi>;
};

const MISSING_HINT = 'recarregue o .node (cargo build -p adom-napi --release em rust/ e npm run build)';

function debridCore(): DebridStateCore {
  // O cast fica concentrado aqui: é a única travessia sem tipo do `.node`.
  return requireCore() as unknown as DebridStateCore;
}

function missing(className: string): Error {
  return new Error(`[debrid] núcleo sem ${className} — ${MISSING_HINT}`);
}

/**
 * Normaliza a fronteira: num `#[napi(object)]` o `Option::None` do Rust chega
 * como `undefined` (a chave desaparece do objeto), enquanto o contrato desta
 * ponte promete `null`. Sem isto, `stateSnapshot` de um hash sem marca devolveria
 * `{ hash }` e quem compara com `null` leria a evidência como ausente por acaso.
 */
function normalizarMagnet(bruto: MagnetStateNapi): MagnetStateHandle {
  return {
    markAlive: (adapter, apiKey, hashes, ttlSeconds, nowMs) =>
      bruto.markAlive(adapter, apiKey, hashes, ttlSeconds, nowMs),
    markBad: (adapter, apiKey, hash, ttlSeconds, nowMs) =>
      bruto.markBad(adapter, apiKey, hash, ttlSeconds, nowMs),
    markLie: (adapter, apiKey, hash, ttlSeconds, nowMs) =>
      bruto.markLie(adapter, apiKey, hash, ttlSeconds, nowMs),
    forgetBad: (adapter, apiKey, hash) => bruto.forgetBad(adapter, apiKey, hash),
    forgetBadOf: (adapter, hash) => bruto.forgetBadOf(adapter, hash),
    state: (adapter, apiKey, hash, nowMs) => bruto.state(adapter, apiKey, hash, nowMs) ?? null,
    stateSnapshot: (adapter, apiKey, hashes, nowMs) =>
      bruto.stateSnapshot(adapter, apiKey, hashes, nowMs).map((mark) => ({
        hash: mark.hash,
        state: mark.state ?? null,
      })),
    remaining: (adapter, apiKey, side, hash, nowMs) =>
      bruto.remaining(adapter, apiKey, side, hash, nowMs) ?? null,
    // `entries` devolve `ttlRemainingSeconds`/`matched` por `#[napi(object)]`:
    // `Option::None` chega como `undefined`, e o contrato é `null`.
    entries: (adapter, side, hash, limit, nowMs) => {
      const page = bruto.entries(adapter, side, hash, limit, nowMs);
      return {
        items: page.items.map((item) => ({
          adapter: item.adapter,
          side: item.side,
          hash: item.hash,
          ttlRemainingSeconds: item.ttlRemainingSeconds ?? null,
        })),
        matched: page.matched,
        truncated: page.truncated,
      };
    },
    summary: (nowMs) => bruto.summary(nowMs),
    liveCount: (nowMs) => bruto.liveCount(nowMs),
    liveLies: (hashes, nowMs) => bruto.liveLies(hashes, nowMs),
    clear: () => bruto.clear(),
    sweep: (maxEntries, nowMs) => bruto.sweep(maxEntries, nowMs),
    // Agregado: o Record do contrato volta a ser montado aqui (a fronteira
    // plana existe só para o napi não aninhar `#[napi(object)]`).
    counts: (nowMs) => {
      const payload = bruto.counts(nowMs);
      if (!payload) return null;
      const adapters: Record<string, MagMetaTotals> = Object.create(null);
      for (const row of payload.adapters) {
        adapters[row.adapter] = {
          alive: row.alive, bad: row.bad, lie: row.lie,
          ttlRemainingSums: { alive: row.ttlAlive, bad: row.ttlBad, lie: row.ttlLie },
        };
      }
      // O núcleo só devolve payload versão 1: versão estranha vira `null`.
      return { version: 1, updatedAt: payload.updatedAt, adapters };
    },
    putCounts: (adapters, ttlSeconds, nowMs) => bruto.putCounts(
      Object.entries(adapters).map(([adapter, totals]) => ({
        adapter,
        alive: totals.alive,
        bad: totals.bad,
        lie: totals.lie,
        ttlAlive: totals.ttlRemainingSums.alive,
        ttlBad: totals.ttlRemainingSums.bad,
        ttlLie: totals.ttlRemainingSums.lie,
      })),
      ttlSeconds,
      nowMs,
    ),
    forgetCounts: () => bruto.forgetCounts(),
  };
}

let davailHandle: DavailStateHandle | null = null;
let magnetHandle: MagnetStateHandle | null = null;

/** O `cache.db` do config, ou `:memory:` quando a persistência está desligada. */
function defaultDbPath(): string {
  return config.cache.persist ? config.cache.dbPath : ':memory:';
}

/** Abre um par de handles no caminho pedido (default: o cache.db do config). */
export function debridStateHandles(dbPath?: string): { davail: DavailStateHandle; magnet: MagnetStateHandle } {
  const path = dbPath ?? defaultDbPath();
  const core = debridCore();
  const Davail = core.DavailState;
  const Magnet = core.MagnetStateStore;
  if (!Davail) throw missing('DavailState');
  if (!Magnet) throw missing('MagnetStateStore');
  return { davail: new Davail(path), magnet: normalizarMagnet(new Magnet(path)) };
}

/**
 * Handle único do processo para o `davail:v1` (lazy).
 *
 * `putMany` aplica UMA janela (`ttlSeconds`) a todas as flags: quem tem janelas
 * diferentes — positivo e negativo, como o `cache-check.ts` faz — chama duas
 * vezes, uma por janela. Quem tem `ttlSeconds <= 0` não grava (janela
 * desligada); não existe override por flag nesta porta.
 */
export function davailState(): DavailStateHandle {
  if (davailHandle) return davailHandle;
  const Davail = debridCore().DavailState;
  if (!Davail) throw missing('DavailState');
  davailHandle = new Davail(defaultDbPath());
  return davailHandle;
}

/** Handle único do processo para o `mag:v1` (lazy). */
export function magnetState(): MagnetStateHandle {
  if (magnetHandle) return magnetHandle;
  const Magnet = debridCore().MagnetStateStore;
  if (!Magnet) throw missing('MagnetStateStore');
  magnetHandle = normalizarMagnet(new Magnet(defaultDbPath()));
  return magnetHandle;
}

/**
 * Só para TESTE: injeta handles (dublê ou `:memory:`) sem abrir o `cache.db`.
 * Campo ausente mantém o handle atual; `null` no campo descarta só ele;
 * `null` no argumento inteiro equivale ao `resetDebridStateForTest()`.
 */
export function setDebridStateForTest(
  handles: { davail?: DavailStateHandle | null; magnet?: MagnetStateHandle | null } | null,
): void {
  if (!handles) {
    resetDebridStateForTest();
    return;
  }
  if (handles.davail !== undefined) davailHandle = handles.davail;
  if (handles.magnet !== undefined) magnetHandle = handles.magnet;
}

/** Só para testes: descarta os handles (o próximo abre outro). */
export function resetDebridStateForTest(): void {
  davailHandle = null;
  magnetHandle = null;
}
