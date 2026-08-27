// Semente do colhedor: as listas de populares do IMDb (via RapidAPI) viram
// fila de obras a indexar ANTES de alguém pedir, e a COORTE popular persistida
// vira a base do baseline de cobertura BR (F3).
//
// Por que existe: o índice só sabia o que já tinha sido buscado — a
// independência do Jackett era retroativa, nunca prospectiva. Título que
// ninguém abriu ainda custava os 5s de coleta ao vivo na primeira vez, sempre.
// Com a semente, o que os populares estão prestes a buscar já está indexado.
//
// Economia medida (2026-08-21): `most-popular-movies` e `most-popular-tv`
// devolvem 100 títulos CADA em UMA requisição (~170 KB), e a cota da conta é de
// 10.000 requisições por período. Duas requisições por dia é ruído — o gargalo
// nunca é a API, é a vazão do colhedor (~4 obras/hora), e por isso o corte por
// ciclo é pequeno e a lista chega ordenada por popularidade.
//
// As DUAS listas são sempre baixadas, mesmo quando o teto de enfileiramento já
// encheu na primeira: o baseline `f3.br.popular.*` precisa do top completo de
// filmes E de séries (o teto de até `config.f3.br.topPerType` por tipo limita
// só as escolhas para enqueue). A coorte é a persistência dessa leitura.
//
// Invariantes:
// 1. A chave da RapidAPI vive no .env e NUNCA é logada — nem em debug, nem em
//    mensagem de erro (o catch loga só `err.message`, que não a carrega).
// 2. Sem chave o módulo é inerte: não faz requisição, não enfileira nada nem
//    grava coorte.
// 3. Só entra obra JÁ LANÇADA e com público real. Estreia futura não tem
//    release para colher — colher um título futuro é queimar consulta do teto
//    horário contra um swarm que não existe.
// 4. Obra que já está no índice não é re-enfileirada: a semente serve para
//    descobrir, não para renovar (renovar é papel de quem busca).
// 5. A coorte inclui obras conhecidas e novas: ela alimenta a pergunta de
//    "quantas das populares já têm ⚡", e a resposta precisa do denominador
//    inteiro, não só do que ainda falta indexar.
// 6. Se uma lista falha, a coorte anterior DAQUELE tipo é preservada — a
//    baseline nunca regride por uma tremedeira de rede.
import config from '../config.js';
import * as cache from '../utils/cache.js';
import { prefix } from '../utils/cache-keys.js';
import * as releaseIndex from '../utils/release-index.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import * as harvesterLive from '../utils/harvester-live.js';

type SeedEntry = { imdbId: string; type: 'movie' | 'series'; reason: string };

/** Coorte popular persistida: IDs e timestamp — nunca credencial. */
export type PopularCohort = { at: number; movies: string[]; series: string[] };

const LISTS: { path: string; type: 'movie' | 'series' }[] = [
  { path: 'most-popular-movies', type: 'movie' },
  { path: 'most-popular-tv', type: 'series' },
];

/** `tvMovie` conta como filme e `tvMiniSeries` como série — o resto é ruído. */
const TIPOS: Record<string, 'movie' | 'series'> = {
  movie: 'movie',
  tvMovie: 'movie',
  tvSeries: 'series',
  tvMiniSeries: 'series',
};

// Chave versionada pelo namespace `seed` (`seed:v1:`). Keep `last` para o
// cooldown do ciclo; `cohort` para a coorte do baseline.
const COHORT_KEY = `${prefix('seed')}cohort`;

function enabled() {
  const live = harvesterLive.effective();
  return live.seedEnabled && Boolean(config.seed.apiKey) && config.releaseIndex.enabled;
}

async function fetchList(path: string): Promise<any[]> {
  const res = await fetch(`https://${config.seed.host}/api/imdb/${path}`, {
    headers: {
      Accept: 'application/json',
      'x-rapidapi-host': config.seed.host,
      'x-rapidapi-key': config.seed.apiKey,
    },
    signal: AbortSignal.timeout(config.seed.timeoutMs),
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/** Já lançada, com público real e id utilizável. */
function aproveitavel(item: any, hoje: string) {
  if (!/^tt\d+$/.test(String(item?.id || ''))) return false;
  if (!TIPOS[String(item?.type || '')]) return false;
  const live = harvesterLive.effective();
  if (Number(item?.numVotes || 0) < live.seedMinVotes) return false;
  const lancamento = String(item?.releaseDate || '');
  // Sem data conhecida, o ano serve de aproximação grosseira: melhor deixar
  // passar um limítrofe do que descartar obra antiga por metadado ausente.
  if (!lancamento) return Number(item?.startYear || 0) > 0 && Number(item.startYear) <= Number(hoje.slice(0, 4));
  return lancamento <= hoje;
}

/** Filtra e deduplica os ids aproveitáveis de uma lista, na ordem da API. */
function idsAprovados(itens: any[], hoje: string, topo: number, type: 'movie' | 'series'): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of itens || []) {
    if (out.length >= topo) break;
    if (!aproveitavel(item, hoje)) continue;
    if (TIPOS[String(item?.type || '')] !== type) continue;
    const id = String(item.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Valida o shape de uma lista de ids vinda do cache: só `tt…`, sem duplicata. */
function sanitizeIds(list: unknown, topo: number): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of list) {
    const id = String(value || '');
    if (!/^tt\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= topo) break;
  }
  return out;
}

/**
 * A coorte popular persistida, read-only. `cache.peek` não promove LRU nem
 * conta cache.hit/miss — vital para o sampler de fundo, que roda a cada 5 min.
 * Shape validado por construção (sanitizeIds clampa ao teto de `topPerType`);
 * sem coorte válida devolve null, e o chamador não inventa denominador.
 * Nunca expõe a API key — só `{at, movies, series}` de ids.
 */
function popularCohort(): PopularCohort | null {
  const raw = cache.peek(COHORT_KEY) as Partial<PopularCohort> | null;
  if (!raw || typeof raw !== 'object' || typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return null;
  const topo = Math.max(1, config.f3.br.topPerType);
  const movies = sanitizeIds(raw.movies, topo);
  const series = sanitizeIds(raw.series, topo);
  if (!movies.length && !series.length) return null;
  return { at: raw.at, movies, series };
}

/** TTL da coorte: nunca menos que 3 ciclos de semente (>= 3 × seedIntervalH). */
function cohortTtl(): number {
  const live = harvesterLive.effective();
  return Math.ceil(Math.max(1, live.seedIntervalH) * 3) * 3600;
}

function persistCohort(coorte: PopularCohort): void {
  try {
    cache.set(COHORT_KEY, coorte, cohortTtl());
  } catch (err) {
    log.warn('[seed] falha ao persistir coorte:', log.errorMessage(err));
  }
}

/**
 * Obras novas a enfileirar neste ciclo, ou `[]` quando não é hora (cooldown),
 * falta chave ou nada é novidade. Nunca lança: semente é oportunidade, não
 * caminho crítico — quem chama não pode quebrar porque a RapidAPI caiu.
 * De quebra, grava a `PopularCohort` usada pelo baseline do F3.
 */
async function nextSeeds(): Promise<SeedEntry[]> {
  if (!enabled()) return [];
  const marca = `${prefix('seed')}last`;
  if (cache.get(marca)) return [];
  const live = harvesterLive.effective();
  // A marca é gravada ANTES da rede: API fora do ar não pode fazer o ciclo
  // seguinte tentar de novo em 60s, que é o intervalo do tick.
  cache.set(marca, Date.now(), Math.max(1, live.seedIntervalH) * 3600);

  const hoje = new Date().toISOString().slice(0, 10);
  const topoPorTipo = Math.max(1, config.f3.br.topPerType);
  const previa = popularCohort();
  const coorte: PopularCohort = {
    at: Date.now(),
    movies: previa?.movies || [],
    series: previa?.series || [],
  };
  const escolhidas: SeedEntry[] = [];
  let vistos = 0;
  let conhecidas = 0;
  let fetchedAny = false;

  // As DUAS listas são sempre consultadas, mesmo que o teto de enfileiramento
  // já tenha enxido na primeira: a coorte precisa do top real de cada tipo.
  // O cap (live.seedMaxPerCycle) limita apenas o que entra em `escolhidas`.
  for (const lista of LISTS) {
    const balde: 'movies' | 'series' = lista.type === 'movie' ? 'movies' : 'series';
    let itens: any[] = [];
    try {
      itens = await fetchList(lista.path);
      fetchedAny = true;
      metrics.count('seed.fetched', itens.length);
    } catch (err: unknown) {
      // Uma lista fora não derruba o ciclo nem regride a coorte: o balde
      // anterior daquele tipo é preservado intacto.
      log.warn(`[seed] lista ${lista.path} falhou:`, log.errorMessage(err));
      continue;
    }
    coorte[balde] = idsAprovados(itens, hoje, topoPorTipo, lista.type);
    for (const item of itens) {
      if (escolhidas.length >= live.seedMaxPerCycle) break;
      vistos += 1;
      if (!aproveitavel(item, hoje)) continue;
      const itemType = TIPOS[String(item.type)];
      if (itemType !== lista.type) continue;
      const imdbId = String(item.id);
      // Já indexada: a semente descobre, não renova.
      if (releaseIndex.lookup(imdbId, {}).length > 0) {
        conhecidas += 1;
        continue;
      }
      escolhidas.push({ imdbId, type: itemType, reason: 'popular' });
    }
  }

  if (fetchedAny) {
    coorte.at = Date.now();
    persistCohort(coorte);
  }
  metrics.count('seed.enqueued', escolhidas.length);
  metrics.count('seed.known', conhecidas);
  if (escolhidas.length) {
    log.info(`[seed] ${escolhidas.length} obra(s) popular(es) nova(s) para o colhedor (${vistos} avaliadas, ${conhecidas} já no índice)`);
  }
  return escolhidas;
}

export { nextSeeds, popularCohort };
export default { nextSeeds, popularCohort };
