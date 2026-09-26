// Identificação segura da obra de uma página raspada (plano "Raspagem total",
// Fase 2). A Fase 1 só grava IMDb quando a ficha técnica da página ANCORAVA um
// tt único; toda a cauda de páginas sem âncora — a maioria — passa por aqui:
// título + ano que o site publica → obra única no TMDB → IMDb id.
//
// A preferência é de SEGURANÇA e não é negociável: obra errada é pior que
// obra nenhuma. Um IMDb trocado contaminaria índice, banco vivo, reserva BR e
// play da obra ALHEIA; um `null` custa apenas a URL entrar em `no-work` e
// aparecer no painel. Daí as quatro travas:
//
//   - nome: igualdade ESTRITA pós-normalização (`normalizeTitle` — a mesma
//     do filtro de título do addon) contra o título localizado pt-BR OU o
//     original do candidato. Sem prefixo, sem substring, sem sinônimo e SEM
//     Jev: decisão determinística, auditável e reproduzível;
//   - ano da PÁGINA: página sem ano declarado não entra em busca nenhuma —
//     sem ano não há com que discriminar homônimo de qualquer época, e
//     aceitar "o único que casou hoje" é chute com cara de acerto. O desfecho
//     é `unidentified/pagina-sem-ano`, sem rede; a URL sobe para
//     identificação de novo se um layout novo trouxer o ano;
//   - ano: tolerância ±1 (aplicada na busca, ver tmdb-search) e candidato sem
//     ano legível é descartado quando a página declara ano;
//   - ambíguo: DUAS ou mais obras distintas casando (tmdbId diferente) é
//     `ambiguous` → null. Nunca desempate por popularidade: o mais famoso não
//     é o certo, é só o mais famoso.
//
// `unavailable` (TMDB fora, sem chave, external_ids falhou) é distinto de
// `unidentified`: o primeiro é retentável, o segundo é estado próprio da
// página. Quem consome é o motor (fase 3); nada aqui grava banco.
import { searchByTitle, externalImdbId } from '../utils/tmdb.js';
import type { TmdbSearchHit } from '../utils/tmdb-search.js';
import { normalizeTitle } from '../utils/title-normalization.js';
import type { SearchWorkType } from '../utils/tmdb-search.js';

/** Desfecho da identificação de UMA página. */
export type IdentifyOutcome =
  | 'identified'   // obra única casou e o IMDb id veio
  | 'unidentified' // decisão autoritativa: não identificou (null, estado próprio)
  | 'ambiguous'    // dois ou mais homônimos válidos → null por segurança
  | 'unavailable'; // TMDB indisponível (retentável, não é veredicto)

export interface IdentifyInput {
  type: SearchWorkType;
  /** Título da página (h1), sem ano. */
  title: string;
  /** Ano declarado pela página; `null`/ausente = página sem ano. */
  year?: number | null;
}

export interface IdentifyResult {
  outcome: IdentifyOutcome;
  /** IMDb id só em `identified`; em todo o resto é `null` — nunca um chute. */
  imdb: string | null;
  /** Motivo curto e estável (agrupamento no painel/log do motor). */
  reason: string;
  /** Id TMDB da obra única, quando existiu (diagnóstico; nunca é credencial). */
  tmdbId?: number;
}

/**
 * Igualdade ESTRITA de nome: o título da página normalizado tem que ser IGUAL
 * ao título localizado ou ao original do candidato. `normalizeTitle` tira
 * acento/caixa/pontuação — "Expresso do Amanhã" e "expresso do amanha" casam;
 * "Snowpiercer" NÃO casa "Expresso do Amanhã" (para isso existe o par
 * título/original do próprio candidato).
 */
export function strictNameMatches(
  pageTitle: string,
  candidateTitles: Array<string | null | undefined>,
): boolean {
  const norm = normalizeTitle(pageTitle);
  if (!norm) return false;
  return candidateTitles.some((candidate) => {
    const normCandidate = normalizeTitle(String(candidate ?? ''));
    return !!normCandidate && normCandidate === norm;
  });
}

export type CandidateSelection =
  | { kind: 'unique'; hit: TmdbSearchHit }
  | { kind: 'ambiguous'; hits: TmdbSearchHit[] }
  | { kind: 'none' };

/**
 * Seleção do candidato entre os hits (JÁ filtrados por ano pela busca):
 * nome estrito decide a entrada e a quantidade de obras DISTINTAS decide o
 * desfecho — uma é única, duas ou mais é homônimo ambíguo (null), zero é
 * "não casou".
 */
export function selectCandidate(hits: TmdbSearchHit[], pageTitle: string): CandidateSelection {
  const matches = (Array.isArray(hits) ? hits : [])
    .filter((hit) => strictNameMatches(pageTitle, [hit?.title, hit?.originalTitle]));
  const distinct = [...new Map(matches.filter((hit) => hit).map((hit) => [hit.tmdbId, hit])).values()];
  if (distinct.length === 1) return { kind: 'unique', hit: distinct[0] };
  if (distinct.length > 1) return { kind: 'ambiguous', hits: distinct };
  return { kind: 'none' };
}

/**
 * Identifica a obra de uma página: busca no TMDB, aplica o casamento estrito
 * e resolve o IMDb id. Fail-open: nunca lança — erro de rede vira
 * `unavailable`, que é retentável, e a decisão de identificação só sai
 * autoritativa quando a API respondeu de verdade.
 */
export async function identifyWork(input: IdentifyInput): Promise<IdentifyResult> {
  const title = String(input?.title || '').trim();
  // Página sem título é quebra de layout (o adaptador já devolve `error`);
  // por aquí é só a guarda barata — sem rede.
  if (!title) return { outcome: 'unidentified', imdb: null, reason: 'pagina-sem-titulo' };

  // Página SEM ano não consulta o TMDB: o filtro de ano é local e sem ele
  // QUALQUER homônimo de qualquer época casaria o nome estrito — era a única
  // brecha real de falso positivo da Fase 2 (revisão). Motivo estável para o
  // painel agrupar; não é falha e não é retentativa de rede.
  const pageYear = Number(input?.year);
  if (!Number.isFinite(pageYear) || pageYear <= 0) {
    return { outcome: 'unidentified', imdb: null, reason: 'pagina-sem-ano' };
  }

  const search = await searchByTitle(input.type, title, pageYear);
  if (!search.ok) return { outcome: 'unavailable', imdb: null, reason: 'tmdb-indisponivel' };
  if (!search.hits.length) return { outcome: 'unidentified', imdb: null, reason: 'tmdb-sem-resultado' };

  const selection = selectCandidate(search.hits, title);
  if (selection.kind === 'none') {
    return { outcome: 'unidentified', imdb: null, reason: 'nome-sem-casamento' };
  }
  if (selection.kind === 'ambiguous') {
    return { outcome: 'ambiguous', imdb: null, reason: 'homonimo-ambiguo' };
  }

  const hit = selection.hit;
  const ext = await externalImdbId(hit.tmdbId, input.type);
  if (!ext.ok) {
    return { outcome: 'unavailable', imdb: null, reason: 'tmdb-external-indisponivel', tmdbId: hit.tmdbId };
  }
  if (!ext.imdb) {
    return { outcome: 'unidentified', imdb: null, reason: 'obra-sem-imdb', tmdbId: hit.tmdbId };
  }
  return { outcome: 'identified', imdb: ext.imdb, reason: 'casamento-unico', tmdbId: hit.tmdbId };
}
