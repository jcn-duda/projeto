// Semente do colhedor: as listas de populares do IMDb (via RapidAPI) viram
// fila de obras a indexar ANTES de alguém pedir.
//
// Por que existe: o índice só sabia o que já tinha sido buscado — a
// independência do Jackett era retroativa, nunca prospectiva. Título que
// ninguém abriu ainda custava os 5s de coleta ao vivo na primeira vez, sempre.
// Com a semente, o que as pessoas estão prestes a buscar já está indexado.
//
// Economia medida (2026-08-21): `most-popular-movies` e `most-popular-tv`
// devolvem 100 títulos CADA em UMA requisição (~170 KB), e a cota da conta é de
// 10.000 requisições por período. Duas requisições por dia é ruído — o gargalo
// nunca é a API, é a vazão do colhedor (~4 obras/hora), e por isso o corte por
// ciclo é pequeno e a lista chega ordenada por popularidade.
//
// Invariantes:
// 1. A chave da RapidAPI vive no .env e NUNCA é logada — nem em debug, nem em
//    mensagem de erro (o catch loga só `err.message`, que não a carrega).
// 2. Sem chave o módulo é inerte: não faz requisição, não enfileira nada.
// 3. Só entra obra JÁ LANÇADA e com público real. Estreia futura não tem
//    release para colher — colher `Avengers: Doomsday` é queimar consulta do
//    teto horário contra um swarm que não existe.
// 4. Obra que já está no índice não é re-enfileirada: a semente serve para
//    descobrir, não para renovar (renovar é papel de quem busca).
import config from '../config.js';
import * as cache from '../utils/cache.js';
import { prefix } from '../utils/cache-keys.js';
import * as releaseIndex from '../utils/release-index.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import * as harvesterLive from '../utils/harvester-live.js';

type SeedEntry = { imdbId: string; type: 'movie' | 'series'; reason: string };

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

/**
 * Obras novas a enfileirar neste ciclo, ou `[]` quando não é hora (cooldown),
 * falta chave ou nada é novidade. Nunca lança: semente é oportunidade, não
 * caminho crítico — quem chama não pode quebrar porque a RapidAPI caiu.
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
  const escolhidas: SeedEntry[] = [];
  let vistos = 0;
  let conhecidas = 0;
  for (const lista of LISTS) {
    if (escolhidas.length >= live.seedMaxPerCycle) break;
    let itens: any[] = [];
    try {
      itens = await fetchList(lista.path);
      metrics.count('seed.fetched', itens.length);
    } catch (err: unknown) {
      log.warn(`[seed] lista ${lista.path} falhou:`, log.errorMessage(err));
      continue;
    }
    for (const item of itens) {
      if (escolhidas.length >= config.seed.maxPerCycle) break;
      vistos += 1;
      if (!aproveitavel(item, hoje)) continue;
      const imdbId = String(item.id);
      // Já indexada: a semente descobre, não renova.
      if (releaseIndex.lookup(imdbId, {}).length > 0) {
        conhecidas += 1;
        continue;
      }
      escolhidas.push({ imdbId, type: TIPOS[String(item.type)], reason: 'popular' });
    }
  }
  metrics.count('seed.enqueued', escolhidas.length);
  metrics.count('seed.known', conhecidas);
  if (escolhidas.length) {
    log.info(`[seed] ${escolhidas.length} obra(s) popular(es) nova(s) para o colhedor (${vistos} avaliadas, ${conhecidas} já no índice)`);
  }
  return escolhidas;
}

export { nextSeeds };
export default { nextSeeds };
