import config from '../config.js';
import * as log from './logger.js';
import { LEADING_ARTICLES, titleTokens } from './matching-vocabulary.js';

const API = 'https://api.themoviedb.org/3';

/** Teto de aliases por obra — mesmo do provider BR Dublado (kBrDubMaxTmdbAliases). */
const MAX_BR_ALIASES = 2;

interface BrAliasesResult {
  /** Títulos alternativos BR já filtrados; vazio quando não há. */
  titles: string[];
  /** `true` = a API respondeu (ausência é autoritativa); `false` = falha/prazo. */
  ok: boolean;
}

function significantTokens(text: string): string[] {
  return titleTokens(text).filter((t) => t.length > 2 && !LEADING_ARTICLES.has(t) && !/^\d+$/.test(t));
}

/**
 * Filtro PURO dos aliases BR. Só entra alias que CONTÉM todas as palavras
 * significativas de algum nome canônico (pt/original/en): "Operação: Lioness"
 * é o nome "Lioness" acrescido do marketing BR. Palavra em comum não basta —
 * "Kill" divide "kill" com "Django Kill… If You Live, Shoot!" e é justamente o
 * alias solto que derrubou os `alternative_titles` em b223ffd (abriria release
 * de outra obra). Alias idêntico a um canônico também sai (não acrescenta).
 */
function filterBrAliases(candidates: string[], canonical: Array<string | null | undefined>): string[] {
  const canonSets = canonical
    .filter(Boolean)
    .map((n) => significantTokens(String(n)))
    .filter((toks) => toks.length > 0);
  const canonNorm = new Set(canonical.filter(Boolean).map((n) => titleTokens(String(n)).join(' ')));
  const out: string[] = [];
  for (const raw of candidates) {
    const title = String(raw || '').trim();
    if (!title) continue;
    const norm = titleTokens(title).join(' ');
    if (!norm || canonNorm.has(norm) || out.some((o) => titleTokens(o).join(' ') === norm)) continue;
    const own = new Set(significantTokens(title));
    if (!canonSets.some((toks) => toks.every((t) => own.has(t)))) continue;
    out.push(title);
    if (out.length >= MAX_BR_ALIASES) break;
  }
  return out;
}

/**
 * Títulos alternativos do TMDB marcados como BRASIL (`iso_3166_1 = BR`). O
 * `/find` em pt-BR devolve o nome traduzido pelo TMDB, que às vezes não é o
 * que os sites brasileiros publicam: Lioness volta "Lioness", e todo post BR
 * diz "Operação Lioness" (título da Paramount+ no Brasil) — a regra de prefixo
 * do filtro BR cortava todos. Só país BR entra: os aliases de outros países
 * são as grafias arbitrárias que o b223ffd removeu. Roda no MESMO `deadlineAt`
 * do `/find`; fail-open (falha devolve `ok:false` e lista vazia).
 */
async function fetchBrAliases(
  tmdbId: number,
  isSeries: boolean,
  deadlineAt: number,
): Promise<BrAliasesResult> {
  const remaining = deadlineAt - Date.now();
  // Sem id numérico não há o que perguntar: ausência, não falha (falha
  // encurtaria o TTL da entrada inteira sem motivo).
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return { titles: [], ok: true };
  if (!(remaining > 0)) return { titles: [], ok: false };
  try {
    const url = new URL(`${API}/${isSeries ? 'tv' : 'movie'}/${tmdbId}/alternative_titles`);
    url.searchParams.set('api_key', config.tmdb.apiKey);
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(1, remaining)),
    });
    if (!res.ok) return { titles: [], ok: false };
    const data = await res.json();
    // O endpoint de filme devolve a lista em `titles`; o de série em `results`.
    const entries = data?.[isSeries ? 'results' : 'titles'];
    if (!Array.isArray(entries)) return { titles: [], ok: true };
    const titles = entries
      .filter((e: any) => e?.iso_3166_1 === 'BR' && typeof e?.title === 'string')
      .map((e: any) => String(e.title));
    return { titles, ok: true };
  } catch (err) {
    log.warn('[tmdb] alternative_titles:', err.message);
    return { titles: [], ok: false };
  }
}

export { fetchBrAliases, filterBrAliases, MAX_BR_ALIASES };
export type { BrAliasesResult };
