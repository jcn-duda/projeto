// Registro de adaptadores do motor de raspagem (Fase 8: MULTI-SITE). Extraído
// de `crawler.ts` pela catraca de linhas: quem SABE resolver o site e quem
// memoiza o adaptador de cada site. Sem estado de ritmo/fila aqui: isso é do
// motor.
//
// A TABELA é explícita e fechada: os oito cards BR do Jackett mais o addon
// Mico Leão Dublado (nove no total), cada um com rótulo, módulo e NOME DO
// EXPORT da fábrica. Nenhuma varredura por `Object.values` chamando função
// desconhecida — o registro só carrega o que o próprio site exporta, e site sem
// entrada aparece como indisponível no status em vez de sumir (o operador
// precisa ver "sem adaptador" como diagnóstico).
//
// A memoização é um MAPA por id (o motor alterna entre sites na mesma rotação;
// resolver o módulo a cada passo custaria um import por página). O "site
// ativo" continua exposto para o status legado do topo.
import * as log from '../../utils/logger.js';
import type { CrawlSite } from '../crawl-types.js';

type SiteModule = Record<string, unknown>;

/** Uma entrada da tabela: onde o site está e como ele se apresenta. */
export interface SiteEntry {
  id: string;
  label: string;
  /** Módulo do adaptador; `null` = sem adaptador NESTA RODADA. */
  module: (() => Promise<SiteModule>) | null;
  /** Export nomeado que devolve o `CrawlSite` (ou a fábrica dele). */
  exportName: string | null;
  /** Observação para o status (por que não há adaptador, por exemplo). */
  note?: string;
  /** Adaptador no sidecar Rust (`adom-crawl`): o motor TS nunca o processa. */
  rust?: boolean;
  /**
   * Ritmo PRÓPRIO: o adaptador tem limitador interno e não usa Jackett nem
   * FlareSolverr (os recursos da busca ao vivo que o teto horário e a janela de
   * ociosidade protegem). Fica fora dos dois e do teto agregado do processo.
   */
  ownPace?: boolean;
}

/** Módulos resolvidos por import dinâmico (lazy: o módulo só entra em quem
 *  realmente precisa dele). Os oito cards do Jackett são raspados pelo sidecar
 *  Rust (`adom-crawl`); em TS ficou só o Mico, de ritmo próprio. */
const BUILTIN_MODULES: Record<string, () => Promise<SiteModule>> = {
  // NONO site: o Mico NÃO é card do Jackett — é um addon Stremio público (id
  // virtual `mico`, consultado por IMDb). O adaptador é `crawl-sites/mico.ts`
  // (o homônimo `../mico.ts` é a busca ao vivo). A entrada só existe com
  // `config.mico.enabled`: desligado, a fábrica lança e `ensureSite` devolve null.
  mico: () => import('./mico.js') as unknown as Promise<SiteModule>,
};

/** Site raspado pelo sidecar Rust: sem módulo TS, mas com adaptador (lá). */
const RUST = { module: null, exportName: null, rust: true, note: 'raspado pelo sidecar Rust' } as const;

/**
 * TABELA DOS SITES BR. O `id` é o do CARD do Jackett — é ele que amarra o item
 * raspado à reserva por indexer, ao `ji`/`jl` e ao "vazio suspeito" (decisão 3
 * do plano). EXCEÇÃO: `mico` é o id do card VIRTUAL do addon Mico Leão Dublado
 * (fora do Jackett), mas cumpre o mesmo papel de identidade. A ordem do rollout
 * é do operador (Nerd→TDF→Comando→Rede→Apache→HDR→BLUDV→Mico); esta lista é a
 * de CARDS, não a de rollout.
 */
export const SITE_TABLE: SiteEntry[] = [
  { id: 'vacatorrent', label: 'Vaca Torrent', ...RUST },
  { id: 'nerdfilmes', label: 'NerdFilmes', ...RUST },
  { id: 'torrentdosfilmesv2', label: 'TorrentDosFilmes', ...RUST },
  { id: 'comandotorrents', label: 'ComandoTorrents', ...RUST },
  { id: 'redetorrent-cardigann', label: 'RedeTorrent', ...RUST },
  { id: 'apachetorrent-cardigann', label: 'ApacheTorrent', ...RUST },
  { id: 'hdrtorrent-cardigann', label: 'HDRTorrent', ...RUST },
  { id: 'bludv-cardigann', label: 'BLUDV', ...RUST },
  // Ritmo próprio: `MICO_CRAWL_MIN_GAP_MS` (API JSON, sem Jackett/FlareSolverr).
  { id: 'mico', label: 'Mico Leão Dublado', module: BUILTIN_MODULES.mico, exportName: 'micoCrawlSite', ownPace: true },
];

const TABLE = new Map<string, SiteEntry>(SITE_TABLE.map((entry) => [entry.id, entry]));

let testSiteFactory: ((id: string) => CrawlSite | null) | null = null;
const memo = new Map<string, CrawlSite>();
const warned = new Set<string>();
let activeSite: CrawlSite | null = null;
let activeSiteId = '';

/** Há adaptador, em TS (módulo) ou no sidecar Rust. */
function hasAdapter(entry: SiteEntry): boolean {
  return Boolean((entry.module && entry.exportName) || entry.rust);
}

/** O site é raspado pelo sidecar Rust (ver `SiteEntry.rust`)? */
export function isRustSite(id: string): boolean {
  return SITE_TABLE.some((entry) => entry.id === id && entry.rust === true);
}

/** O site tem ritmo próprio (ver `SiteEntry.ownPace`)? */
export function isOwnPace(id: string): boolean {
  return SITE_TABLE.some((entry) => entry.id === id && entry.ownPace === true);
}

/** Ids canônicos dos sites BR (a tabela, na ordem da tabela). */
export function tableIds(): string[] {
  return SITE_TABLE.map((entry) => entry.id);
}

/**
 * Ids que TÊM adaptador nesta rodada — os que o painel pode ligar sem estarem
 * em `CRAWL_SITES`. Site sem adaptador aparece no catálogo, mas não liga: o
 * motor só o marcaria `sem-adaptador` a cada volta.
 */
export function adapterIds(): string[] {
  return SITE_TABLE.filter(hasAdapter).map((entry) => entry.id);
}

/** Entrada da tabela de um id; `null` quando o id nem existe na tabela. */
export function tableEntry(siteId: string): SiteEntry | null {
  return TABLE.get(String(siteId || '')) ?? null;
}

/**
 * Foto do site para o status do painel: rótulo e se HÁ adaptador nesta rodada.
 * Id fora da tabela devolve `known: false` — o operador vê "site desconhecido"
 * em vez de um cartão vazio.
 */
export function siteInfo(siteId: string): {
  id: string; label: string; known: boolean; adapter: boolean; note: string | null;
} {
  const id = String(siteId || '');
  const entry = TABLE.get(id);
  if (!entry) return { id, label: id, known: false, adapter: false, note: 'site fora da tabela BR' };
  const has = hasAdapter(entry);
  return { id, label: entry.label, known: true, adapter: has, note: has ? null : (entry.note ?? 'sem adaptador') };
}

/** Injeta fábrica de teste (o motor nunca toca o site real nos testes). */
export function setFactoryForTest(factory: ((id: string) => CrawlSite | null) | null): void {
  testSiteFactory = factory;
  memo.clear();
  warned.clear();
  activeSite = null;
  activeSiteId = '';
}

/** Site ativo memoizado (o status do painel o usa como "site ativo"). */
export function active(): { site: CrawlSite | null; id: string } {
  return { site: activeSite, id: activeSiteId };
}

/** Esquece o memo (reset de teste). */
export function forgetAll(): void {
  memo.clear();
  warned.clear();
  activeSite = null;
  activeSiteId = '';
}

/** True quando o objeto tem o par de métodos que o motor consome. */
function isCrawlSite(value: unknown): value is CrawlSite {
  if (!value || typeof value !== 'object') return false;
  const site = value as { discover?: unknown; fetchWork?: unknown };
  return typeof site.discover === 'function' && typeof site.fetchWork === 'function';
}

/**
 * Extrai o `CrawlSite` pelo NOME do export declarado na tabela. Aceita o objeto
 * pronto e a fábrica (sem argumentos). Export desconhecido ou incompatível é
 * `null` com aviso — nunca uma chamada cega em export desconhecido.
 */
function siteFromModule(mod: SiteModule, exportName: string): CrawlSite | null {
  const value = mod[exportName];
  if (isCrawlSite(value)) return value;
  if (typeof value === 'function') {
    try {
      const built = (value as () => unknown)();
      if (isCrawlSite(built)) return built;
    } catch (err: unknown) {
      log.warn(`[crawl] ${exportName}() falhou:`, log.errorMessage(err));
    }
  }
  return null;
}

function warnOnce(siteId: string, message: string, isError: boolean): void {
  if (warned.has(siteId)) return;
  warned.add(siteId);
  if (isError) log.error(message);
  else log.warn(message);
}

/**
 * Garante o adaptador de um site (resolve uma vez e memoiza por id).
 * `null` é sempre EXPLICITO: id fora da tabela, sem adaptador nesta rodada, ou
 * módulo/import quebrado. O motor marca o site como `sem-adaptador` e o painel
 * mostra o motivo no card.
 */
export async function ensureSite(siteId: string): Promise<CrawlSite | null> {
  const id = String(siteId || '');
  if (!id) return null;
  const cached = memo.get(id);
  if (cached) {
    activeSite = cached;
    activeSiteId = id;
    return cached;
  }
  try {
    let site: CrawlSite | null = null;
    if (testSiteFactory) {
      site = testSiteFactory(id);
    } else {
      const entry = TABLE.get(id);
      if (!entry) {
        warnOnce(id, `[crawl] site fora da tabela BR: ${id}`, false);
        return null;
      }
      if (!entry.module || !entry.exportName) {
        warnOnce(id, `[crawl] site sem adaptador nesta rodada: ${id} (${entry.note ?? 'pendente'})`, false);
        return null;
      }
      site = siteFromModule(await entry.module(), entry.exportName);
    }
    if (!site) {
      warnOnce(id, `[crawl] adaptador sem CrawlSite exportado: ${id}`, false);
      return null;
    }
    memo.set(id, site);
    warned.delete(id);
    activeSite = site;
    activeSiteId = id;
    return site;
  } catch (err: unknown) {
    warnOnce(id, `[crawl] adaptador ${id} indisponível: ${log.errorMessage(err)}`, true);
    return null;
  }
}

/** Compat com o nome antigo (o motor consome `ensureSite`). */
export const ensureActiveSite = ensureSite;
