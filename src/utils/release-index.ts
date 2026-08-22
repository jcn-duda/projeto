// Índice de releases por obra (`idx:v1`): a memória que faz o addon virar
// servidor. O `raw:v1` guarda a raspagem por QUERY de indexer e vive minutos;
// aqui guarda o que a obra TEM, filtrado e dedupado por hash, e vive semanas.
//
// Invariantes (os mesmos do raw:v1, pelas mesmas razões):
// 1. Sem config do usuário e sem chave de debrid na chave — o índice é
//    compartilhado entre instalações DE PROPÓSITO. Ele guarda o que EXISTE,
//    nunca o que está pronto em qual conta: isso é davail/mag, escopados por
//    conta. Item de inventário (`fromAccount`) não entra: é conhecimento da
//    conta, não evidência pública de existência.
// 2. Só o que já passou pelo filtro de relevância — quem grava recebe o lote
//    pós-`filterRelevantRaw`; lixo de outra obra não vira índice.
// 3. Deduplicação por hash, mantendo o registro mais recente (OR na marca BR:
//    tracker global que publicou dublado titulado em PT não pode perder a
//    marca para uma re-gravação sem ela).
// 4. `seeders` é foto datada (`seenAt`), não verdade corrente — quem decide
//    ordem final é o sortAndLimit sobre o estado atual (alive/davail).
import config from '../config.js';
import * as cache from './cache.js';
import * as metrics from './metrics.js';
import { prefix } from './cache-keys.js';
import { extractInfoHash, qualityFromTitle, audioFromTitle, explicitPtAudio, parseTitleSeasonEpisode } from './format.js';

type IndexedRelease = {
  hash: string;
  title: string;
  size: number | null;
  indexer: string;
  isBr: boolean;
  dubbed: boolean;
  quality: string;
  seeders: number;
  seenAt: number;
  /** Prova por arquivo real: o post prometia PT, mas era release EN. */
  lied?: boolean;
};

type IndexEntry = { at: number; releases: IndexedRelease[] };

type ObraLocation = { season?: number | null; episode?: number | null };

function enabled() {
  return config.releaseIndex.enabled && config.releaseIndex.ttl > 0;
}

/** `idx:v1:tt123` no filme; `idx:v1:tt123:S2:E5` / `idx:v1:tt123:S2` em série. */
function obraKey(imdbId: string, { season, episode }: ObraLocation = {}) {
  let key = `${prefix('idx')}${imdbId}`;
  if (season != null) key += `:S${season}`;
  if (episode != null) key += `E${episode}`;
  return key;
}

/**
 * Alimenta o índice com o que a busca provou existir. Idempotente: merge por
 * hash, registro mais recente vence. Itens sem hash e itens da conta são
 * ignorados — ver invariantes no cabeçalho.
 */
/**
 * Onde a release PERTENCE, pelo que o título dela declara — não pela busca que
 * a trouxe. É a diferença entre índice e despejo: a coleta de S04E07 arrasta
 * releases de S03 (o Jackett casa por nome, não por episódio), e gravá-las sob
 * a chave do episódio pedido envenenava o índice duas vezes — ocupando as
 * vagas do teto que pertenciam ao episódio certo, e dando cobertura FALSA ao
 * idxPoolCovered, que servia a busca de um balde cujo conteúdo o matchesEpisode
 * descartava na hora de exibir. Medido antes desta regra: 328 de 659 releases
 * (50%) estavam sob chave que não casavam, e TODOS declaravam onde pertenciam.
 *
 * Roteia, não descarta: a consulta ao Jackett já foi paga, então a release de
 * outro episódio vira cobertura de graça do episódio dela.
 */
function destinoDe(imdbId: string, pedido: ObraLocation, title: string) {
  // Filme não tem episódio: a chave é sempre a da obra.
  if (pedido.season == null) return obraKey(imdbId, pedido);
  const { seasons, episodes, complete } = parseTitleSeasonEpisode(title);
  // Série inteira ou faixa de temporadas cobre qualquer episódio: chave da obra.
  if (complete || seasons.length > 1) return obraKey(imdbId, {});
  // Nada declarado é ambíguo, e o contexto da busca é a melhor evidência que
  // existe: fica onde foi encontrada.
  if (seasons.length === 0) return obraKey(imdbId, pedido);
  const season = seasons[0];
  // Um episódio só: chave dele. Vários (pack E01-E02) ou nenhum (pack de
  // temporada): chave da TEMPORADA, que o lookup lê para qualquer episódio.
  if (episodes.length === 1) return obraKey(imdbId, { season, episode: episodes[0] });
  return obraKey(imdbId, { season });
}

function record(imdbId: string, location: ObraLocation, items: any[]) {
  if (!enabled() || !imdbId || !String(imdbId).startsWith('tt') || !Array.isArray(items) || items.length === 0) return 0;
  const now = Date.now();
  const pedida = obraKey(imdbId, location);
  // Primeiro passe: agrupa por DESTINO. O merge com o registro anterior precisa
  // do estado da chave de destino, não da chave da busca.
  const porChave = new Map<string, any[]>();
  for (const item of items) {
    // Inventário da conta NÃO é evidência pública de existência: o que ele
    // tem pronto diz respeito à conta dele (davail/mag), nunca ao índice.
    if (item?.fromAccount) continue;
    const hash = String(extractInfoHash(item.infoHash || item.magnet || '') || '').toLowerCase();
    if (!hash) continue;
    const title = String(item.title || item.Title || '').trim();
    const destino = destinoDe(imdbId, location, title);
    if (destino !== pedida) metrics.count('search.idx.routed');
    const lote = porChave.get(destino) || [];
    lote.push({ item, hash, title });
    porChave.set(destino, lote);
  }

  let added = 0;
  for (const [key, lote] of porChave) {
    const existing = new Map<string, IndexedRelease>();
    const entry = cache.get(key);
    for (const rel of entry?.releases || []) existing.set(rel.hash, rel);
    for (const { item, hash, title } of lote) {
      const prior = existing.get(hash);
      if (prior && prior.seenAt >= now) continue;
      if (!prior) added += 1;
      // Mesma regra do toStremioStream: DUAL sem PT explícito não vale como
      // dublado fora dos sites BR — o degrau "dublado global" do gate de
      // cobertura depende deste flag ser honesto.
      const isBr = Boolean(item.isBr) || Boolean(prior?.isBr);
      const dubbed = isBr
        ? ['Dublado', 'Dual', 'Nacional'].includes(String(audioFromTitle(title)))
        : explicitPtAudio(title);
      existing.set(hash, {
        hash,
        title: title || prior?.title || '',
        size: Number(item.size ?? item.Size) || null,
        indexer: String(item.indexer || item.tracker || prior?.indexer || ''),
        isBr,
        dubbed: Boolean(dubbed) || Boolean(prior?.dubbed),
        quality: qualityFromTitle(title),
        seeders: Number(item.seeders ?? item.Seeders ?? 0) || 0,
        seenAt: now,
        // Campo aditivo: uma nova coleta não pode apagar prova de play/tail.
        lied: Boolean(prior?.lied),
      });
    }
    if (existing.size === 0) continue;
    const releases = [...existing.values()]
      .sort((a, b) => b.seenAt - a.seenAt)
      .slice(0, Math.max(1, config.releaseIndex.maxReleases));
    cache.set(key, { at: now, releases } satisfies IndexEntry, config.releaseIndex.ttl);
  }
  metrics.count('search.idx.recorded', added);
  if (added > 0) metrics.count('search.idx.grown');
  return added;
}

/**
 * Consulta por obra: episódio primeiro, temporada como fallback (pack cobre os
 * episódios dela — a desqualificação fina por episódio continua sendo papel do
 * matchesEpisode no buildStreams). Dedupe por hash preserva a variante vista
 * mais recente.
 */
function lookup(imdbId: string, { season, episode }: ObraLocation = {}): IndexedRelease[] {
  if (!enabled() || !imdbId || !String(imdbId).startsWith('tt')) return [];
  const merged = new Map<string, IndexedRelease>();
  const keys: string[] = [];
  if (season != null && episode != null) keys.push(obraKey(imdbId, { season, episode }));
  if (season != null) keys.push(obraKey(imdbId, { season }));
  keys.push(obraKey(imdbId));
  for (const key of keys) {
    const entry = cache.get(key);
    for (const rel of entry?.releases || []) {
      const prior = merged.get(rel.hash);
      if (!prior || rel.seenAt > prior.seenAt) merged.set(rel.hash, rel);
    }
  }
  return [...merged.values()];
}

/**
 * A evidência de mentira chega do play/tail com hash e obra conhecidos. Campo
 * opcional preserva entradas antigas e evita invalidar o índice inteiro.
 */
function markLied(imdbId: string, location: ObraLocation, hash: string) {
  if (!enabled() || !imdbId || !String(imdbId).startsWith('tt') || !hash) return 0;
  const normalized = String(hash).toLowerCase();
  const keys = new Set<string>([
    obraKey(imdbId, location),
    obraKey(imdbId, { season: location.season }),
    obraKey(imdbId),
  ]);
  let changed = 0;
  for (const key of keys) {
    const entry = cache.get(key) as IndexEntry | undefined;
    if (!entry?.releases?.some((release) => release.hash === normalized)) continue;
    const releases = entry.releases.map((release) => {
      if (release.hash !== normalized || release.lied) return release;
      changed += 1;
      return { ...release, lied: true };
    });
    cache.set(key, { ...entry, releases } satisfies IndexEntry, config.releaseIndex.ttl);
  }
  if (changed) metrics.count('search.idx.lied', changed);
  return changed;
}

/** Para o painel: quanto do índice existe agora. */
function status() {
  const ns = cache.snapshot().namespaces as Record<string, any>;
  return {
    enabled: enabled(),
    ttlS: config.releaseIndex.ttl,
    entries: ns?.idx?.entries || 0,
    maxEntries: ns?.idx?.maxEntries || 4000,
  };
}

export { record, lookup, markLied, status };
