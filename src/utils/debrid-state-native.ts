/**
 * Handles do ESTADO de debrid no núcleo Rust (`adom-index`): o ⚡ de
 * disponibilidade por hash (`davail:v1:<adapter>:<conta>:<hash>`, valor `1`/`0`)
 * e o banco de magnets (`mag:v1:<alive|bad|lie>:<adapter>:<conta>:<hash>`).
 * Os dois moram no MESMO `data/cache.db` que o Node e o gateway usam — aqui só
 * se abre o handle, como no `raw-store-native.ts`.
 *
 * A regra é do Rust: TTL (positivo e negativo têm janelas próprias; `ttlSeconds
 * <= 0` DESLIGA a janela e o store NÃO grava nada — a mesma regra do
 * `cache.setMany` do Node), escopo de conta, precedência `bad > lie > alive` e a
 * remoção do `alive` quando o `bad` nasce. Nada disso é reimplementado do lado
 * TS — os métodos devolvem o veredito cru do núcleo, e quem precisa do "não sei"
 * recebe `null` em vez de um falso ⚡.
 *
 * MOMENTO (T2-L5a): o Node AINDA NÃO é dono único destes namespaces — `davail`
 * e `mag` só entram em `RUST_OWNED` (`cache-keys.ts`) na fatia seguinte, T2-L5b.
 * Até lá o caminho antigo (cache L1/SQLite do Node) e esta ponte coexistem sobre
 * as mesmas chaves; a fatia que vira o dono é que decide qual deles escreve.
 */
import config from '../config.js';
import { requireCore } from './rust-core.js';

/** Marca viva do banco de magnets (`mag:v1`). */
export type MagnetSide = 'alive' | 'bad' | 'lie';

/** Veredito de disponibilidade de um hash, como o `davail:v1` guarda. */
export type DavailFlag = { hash: string; cached: boolean };

/** Foto de um hash no banco de magnets; `null` = nenhuma evidência viva. */
export type MagnetMark = { hash: string; state: MagnetSide | null };

export type DavailStateHandle = {
  /** `true`/`false` = evidência medida; `null` = ausente (não é "frio"). */
  get(adapter: string, apiKey: string, hash: string, nowMs: number): boolean | null;
  /** Só os hashes presentes e vivos, na ordem pedida, com hash em minúsculas. */
  getMany(adapter: string, apiKey: string, hashes: string[], nowMs: number): DavailFlag[];
  /** `ttlSeconds <= 0` não grava (janela desligada); sem conta, idem. */
  put(adapter: string, apiKey: string, hash: string, cached: boolean, ttlSeconds: number, nowMs: number): void;
  /** `ttlSeconds <= 0` não grava; a janela é UMA para todas as flags. */
  putMany(adapter: string, apiKey: string, flags: DavailFlag[], ttlSeconds: number, nowMs: number): void;
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
  state(adapter: string, apiKey: string, hash: string, nowMs: number): MagnetSide | null;
  /** Uma entrada por hash pedido, na ordem pedida (inclusive os sem marca). */
  stateSnapshot(adapter: string, apiKey: string, hashes: string[], nowMs: number): MagnetMark[];
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
  MagnetStateStore?: NativeClass<MagnetStateHandle>;
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
function normalizarMagnet(bruto: MagnetStateHandle): MagnetStateHandle {
  return {
    markAlive: (adapter, apiKey, hashes, ttlSeconds, nowMs) =>
      bruto.markAlive(adapter, apiKey, hashes, ttlSeconds, nowMs),
    markBad: (adapter, apiKey, hash, ttlSeconds, nowMs) =>
      bruto.markBad(adapter, apiKey, hash, ttlSeconds, nowMs),
    markLie: (adapter, apiKey, hash, ttlSeconds, nowMs) =>
      bruto.markLie(adapter, apiKey, hash, ttlSeconds, nowMs),
    forgetBad: (adapter, apiKey, hash) => bruto.forgetBad(adapter, apiKey, hash),
    state: (adapter, apiKey, hash, nowMs) => bruto.state(adapter, apiKey, hash, nowMs) ?? null,
    stateSnapshot: (adapter, apiKey, hashes, nowMs) =>
      bruto.stateSnapshot(adapter, apiKey, hashes, nowMs).map((mark) => ({
        hash: mark.hash,
        state: mark.state ?? null,
      })),
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
