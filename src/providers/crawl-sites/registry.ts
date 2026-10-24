// Tabela dos sites do raspador (Fase 8: MULTI-SITE). Fechada e explícita: os
// oito cards BR do Jackett mais o addon Mico Leão Dublado (nove no total),
// todos raspados pelo sidecar Rust (`adom-crawl`). A máquina de adaptador TS
// (módulo/export resolvido por import dinâmico, memo e fábrica de teste) saiu
// com o loop TS: não sobrou site com adaptador TS. Site fora da tabela aparece
// como desconhecido no status em vez de sumir.

/** Uma entrada da tabela: onde o site está e como ele se apresenta. */
export interface SiteEntry {
  id: string;
  label: string;
  /** Observação para o status (por que não há adaptador, por exemplo). */
  note?: string;
  /** Adaptador no sidecar Rust (`adom-crawl`). */
  rust?: boolean;
  /**
   * Ritmo PRÓPRIO: o adaptador tem limitador interno e não usa Jackett nem
   * FlareSolverr (os recursos da busca ao vivo que o teto horário e a janela de
   * ociosidade protegem). Fica fora dos dois e do teto agregado do processo.
   */
  ownPace?: boolean;
}

/** Site raspado pelo sidecar Rust: sem módulo TS, mas com adaptador (lá). */
const RUST = { rust: true, note: 'raspado pelo sidecar Rust' } as const;

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
  // NONO site: o Mico NÃO é card do Jackett — é um addon Stremio público (id
  // virtual `mico`, consultado por IMDb), raspado pela lane de ritmo próprio
  // do sidecar (`motor::mico_lane`). Ritmo próprio: `MICO_CRAWL_MIN_GAP_MS`
  // (API JSON, sem Jackett/FlareSolverr).
  { id: 'mico', label: 'Mico Leão Dublado', ...RUST, ownPace: true },
];

const TABLE = new Map<string, SiteEntry>(SITE_TABLE.map((entry) => [entry.id, entry]));

/** Há adaptador (no sidecar Rust). */
function hasAdapter(entry: SiteEntry): boolean {
  return entry.rust === true;
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
