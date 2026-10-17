import config from '../config.js';
import * as log from './logger.js';
import { nativeCore } from './native-core.js';
import { fetchJsonWithin } from './deadline.js';

const API = 'https://api.themoviedb.org/3';

/** Teto de aliases por obra — mesmo do provider BR Dublado (kBrDubMaxTmdbAliases). */
const MAX_BR_ALIASES = 2;

interface BrAliasesResult {
  /** Títulos alternativos BR já filtrados; vazio quando não há. */
  titles: string[];
  /** `true` = a API respondeu (ausência é autoritativa); `false` = falha/prazo. */
  ok: boolean;
}

/** Funções de alias no `.node` (camelCase do napi-rs). */
type AliasesCore = {
  filterBrAliasesNapi(candidates: Array<string | null>, canonical: Array<string | null>): string[];
};

const core = () => nativeCore<AliasesCore>();

/**
 * Filtro PURO dos aliases BR — decisão INTEIRA no núcleo
 * (`adom-core::tmdb_br_aliases`, golden contra o TS do `esm`). Só entra alias
 * que CONTÉM todas as palavras significativas de algum nome canônico:
 * "Operação: Lioness" é o nome "Lioness" acrescido do marketing BR. Palavra em
 * comum não basta — "Kill" divide "kill" com "Django Kill… If You Live,
 * Shoot!" e é justamente o alias solto que derrubou os `alternative_titles` em
 * b223ffd (abriria release de outra obra). Alias idêntico a um canônico também
 * sai (não acrescenta). `fetchBrAliases` FICA em TS: é rede + config, e efeito
 * de I/O não pertence ao núcleo.
 */
function filterBrAliases(candidates: string[], canonical: Array<string | null | undefined>): string[] {
  return core().filterBrAliasesNapi(
    candidates.map((raw) => (typeof raw === 'string' ? raw : null)),
    canonical.map((name) => (typeof name === 'string' ? name : null)),
  );
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
    const { res, data } = await fetchJsonWithin(url, { headers: { Accept: 'application/json' } }, remaining);
    if (!res.ok) return { titles: [], ok: false };
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
