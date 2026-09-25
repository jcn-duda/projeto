import config from '../config.js';
import type { RawItem } from '../../types/domain.js';
import { looksPtBr } from '../utils/format.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import * as indexerStatus from './indexer-status.js';
import { captureItems } from '../utils/magnet-bank.js';

/**
 * Addon público "Mico Leão Dublado V2" como card de indexer VIRTUAL.
 *
 * Aparece no catálogo da /configure ao lado dos cards do Jackett (id `mico`) e
 * obedece a seleção `ji`, a prioridade `ip` e o limite `jl` como qualquer
 * indexer — mas não passa pelo Jackett: o Mico é um addon Stremio, consultado
 * por IMDb, e o Cardigann só manda texto. Por isso o id é retirado de toda
 * lista que vira consulta ao Jackett (`jackettOnly`).
 *
 * O matching dele é fraco (Coringa traz Harley Quinn/South Park; em 48 hashes
 * de 5 obras só ~5 eram acréscimo útil): os itens entram no lote cru ANTES do
 * filtro de relevância — o lixo de outra obra morre lá, como o do Jackett.
 * Falha NUNCA derruba a busca nem a colheita: devolve `[]`.
 */
export const MICO_ID = 'mico';

/** Tira o card virtual de uma lista que vai virar consulta ao Jackett. */
export function jackettOnly<T>(ids: readonly T[]): T[] {
  return ids.filter((id) => String(id).trim().toLowerCase() !== MICO_ID);
}

/** Entrada do catálogo da /configure (mesmo shape dos cards do Jackett). */
export function catalogEntry(): { id: string; label: string; language: string; isBr: boolean; virtual: true } | null {
  if (!config.mico.enabled) return null;
  // `virtual` separa o card da prova de vida do Jackett: catálogo vivo só com
  // ele continua sendo "Jackett sem indexer" no painel.
  return { id: MICO_ID, label: 'Mico Leão Dublado', language: 'pt-BR', isBr: true, virtual: true };
}

interface SearchArgs {
  type: string;
  imdbId: string;
  season?: number | null;
  episode?: number | null;
}

interface SearchOptions {
  /** Pinta o card (online/offline). O colhedor passa `false`. */
  recordStatus?: boolean;
  /** Mesma semântica do `jackett.search`: coleta viva zera o `passed_filter`
   * da obra (o build reescreve); a de fundo preserva a última avaliação. */
  resetPassedFilter?: boolean;
  /** Estado vivo da coleta (fallback do acervo): `responded` por consulta. */
  onQueryResult?: (info: { indexer: string; responded: boolean; reason?: 'error' | 'breaker' }) => void;
}

const INFO_HASH = /^[0-9a-f]{40}$/i;
const IMDB_ID = /^tt\d{1,10}$/;
const SEEDERS = /👥\s*([\d.,]+)/u;
const SIZE = /💾\s*([\d.]+)\s*(TB|GB|MB|KB)/iu;
const SIZE_MULT: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

/** Primeira linha sem os sufixos `(brazilian, eng)`, `👥 N`, `💾 X GB` e emojis. */
function cleanTitle(firstLine: string): string {
  return firstLine
    .replace(/\s*👥.*$/u, '')
    .replace(/\s*💾.*$/u, '')
    .replace(/\s*\((?:[a-z]+(?:\s*,\s*[a-z]+)*)\)\s*$/i, '')
    // O Mico corta a linha longa no meio do sufixo: "…DUAL-RICKSZ (brazili…".
    .replace(/\s*\([a-z ,]*…\s*$/i, '')
    .replace(/…\s*$/u, '')
    .replace(/\p{Extended_Pictographic}|\u{FE0F}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TRACKER = /^(?:udp|https?|wss?):\/\/[^\s&#]+$/i;

/**
 * Magnet com os trackers que o Mico publica em `sources` (formato do Stremio:
 * `tracker:`/`dht:` prefixados ou a URL crua). SEM `dn=`: o título do Mico é o
 * texto do post, não o nome do torrent, e `dn=` é evidência de arquivo para o
 * resto do pipeline (ano, promessa de dublado). O banco sanitiza e soma o piso.
 */
function magnetOf(hash: string, sources: unknown): string {
  const trackers = new Set<string>();
  for (const raw of Array.isArray(sources) ? sources : []) {
    const url = String(raw || '').trim().replace(/^tracker:/i, '');
    if (TRACKER.test(url)) trackers.add(url);
  }
  return `magnet:?xt=urn:btih:${hash}${[...trackers].map((t) => `&tr=${encodeURIComponent(t)}`).join('')}`;
}

function mapStream(s: any): RawItem | null {
  const infoHash = String(s?.infoHash || '').trim();
  if (!INFO_HASH.test(infoHash)) return null;
  const full = String(s?.title || '');
  const title = cleanTitle(full.split('\n')[0] || '');
  if (!title) return null;
  const seedMatch = full.match(SEEDERS);
  const seeders = seedMatch ? Number(seedMatch[1].replace(/[.,]/g, '')) : NaN;
  const sizeMatch = full.match(SIZE);
  const size = sizeMatch ? Math.round(Number(sizeMatch[1]) * (SIZE_MULT[sizeMatch[2].toUpperCase()] || 0)) : 0;
  const hash = infoHash.toLowerCase();
  return {
    title,
    infoHash: hash,
    magnet: magnetOf(hash, s?.sources),
    // Sem 👥 a fonte não publicou seeders: 1 é o neutro das fontes BR (0 seria
    // descartado por MIN_SEEDERS antes de qualquer avaliação).
    seeders: Number.isFinite(seeders) ? seeders : 1,
    size: size > 0 ? size : undefined,
    indexer: 'mico',
    isBr: looksPtBr(title) || /\(brazil/i.test(full),
  };
}

let breakerFailures = 0;
let breakerOpenedAt = 0;

function breakerOpen(): boolean {
  if (breakerFailures < config.mico.breakerFailures) return false;
  return Date.now() - breakerOpenedAt < config.mico.breakerCooldown;
}

function noteFailure() {
  breakerFailures += 1;
  if (breakerFailures >= config.mico.breakerFailures) {
    breakerOpenedAt = Date.now();
    if (breakerFailures === config.mico.breakerFailures) log.warn(`[mico] circuito aberto após ${breakerFailures} falha(s) seguidas`);
  }
}

function _resetBreaker() {
  breakerFailures = 0;
  breakerOpenedAt = 0;
}

function endpointUrl({ type, imdbId, season, episode }: SearchArgs): string | null {
  if (!IMDB_ID.test(String(imdbId || ''))) return null;
  const base = config.mico.url;
  if (type === 'movie') return `${base}/stream/movie/${imdbId}.json`;
  if (type !== 'series' || !Number.isInteger(season) || !Number.isInteger(episode)) return null;
  return `${base}/stream/series/${imdbId}:${season}:${episode}.json`;
}

/**
 * `recordStatus` pinta o card (online/slow/offline) como a busca viva do
 * Jackett faz; o colhedor passa `false` — medição de fundo não é a da resposta.
 * Tudo que tem hash vai para o banco de magnets vivo ANTES de qualquer filtro,
 * como no Jackett: o acervo guarda o que a fonte devolveu, a lista decide.
 */
async function search(args: SearchArgs, options: SearchOptions = {}): Promise<RawItem[]> {
  const { recordStatus = true, resetPassedFilter = true, onQueryResult } = options;
  if (!config.mico.enabled) return [];
  const url = endpointUrl(args);
  // Nada a perguntar (id/episódio inválido) não é falha da fonte; circuito
  // aberto é — o estado vivo precisa saber para a reserva do acervo cobrir.
  if (!url) {
    onQueryResult?.({ indexer: MICO_ID, responded: true });
    return [];
  }
  if (breakerOpen()) {
    onQueryResult?.({ indexer: MICO_ID, responded: false, reason: 'breaker' });
    return [];
  }
  const started = Date.now();
  const note = (ok: boolean, results = 0) => {
    if (recordStatus) indexerStatus.record(MICO_ID, { ok, ms: Date.now() - started, budgetMs: config.mico.timeout, results });
    onQueryResult?.(ok ? { indexer: MICO_ID, responded: true } : { indexer: MICO_ID, responded: false, reason: 'error' });
  };
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(config.mico.timeout),
    });
    if (!res.ok) {
      // 4xx (salvo 429) é da obra, não prova host caído.
      if (res.status < 500 && res.status !== 429) {
        log.warn(`[mico] HTTP ${res.status} para ${args.imdbId}`);
        note(true);
        return [];
      }
      throw new Error(`HTTP ${res.status}`);
    }
    const data: any = await res.json();
    const raw = Array.isArray(data?.streams) ? data.streams : [];
    const seen = new Set<string>();
    const out: RawItem[] = [];
    for (const item of raw) {
      const parsed = mapStream(item);
      if (!parsed?.infoHash || seen.has(parsed.infoHash)) continue;
      seen.add(parsed.infoHash);
      out.push(parsed);
    }
    breakerFailures = 0;
    captureItems(out, MICO_ID, {
      imdbId: args.imdbId,
      season: args.season ?? null,
      episode: args.episode ?? null,
      resetPassedFilter,
    });
    metrics.count('mico.items', out.length);
    note(true, out.length);
    return out;
  } catch (err: any) {
    noteFailure();
    metrics.count('mico.error');
    note(false);
    log.warn(`[mico] falha na consulta de ${args.imdbId}:`, err?.message || String(err));
    return [];
  }
}

/**
 * Diagnóstico do card (`/test-indexer.json?id=mico` e o "testar todos" do
 * painel): mesmo shape do `jackett.test`. Coringa (tt7286456) tem acervo
 * dublado conhecido no Mico; ignora o breaker, que é atalho da busca viva.
 */
async function test(imdbId = 'tt7286456') {
  // Como no /test-indexer do Jackett, o diagnóstico é quem repara: zera o
  // circuito e mede de novo. Falha real volta a contar pela própria search.
  breakerFailures = 0;
  const started = Date.now();
  const items = await search({ type: 'movie', imdbId });
  const ms = Date.now() - started;
  return {
    indexer: MICO_ID,
    ok: items.length > 0,
    results: items.length,
    withMagnet: items.length,
    ms,
    sample: items[0]?.title ? String(items[0].title).slice(0, 120) : null,
    query: imdbId,
    type: 'movie',
    br: true,
    budgetMs: config.mico.timeout,
    overBudget: ms > config.mico.timeout,
  };
}

export { search, test, _resetBreaker };
