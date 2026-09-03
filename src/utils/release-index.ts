// Índice de releases por obra (`idx:v6`): a memória que faz o addon virar
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
// Prova de episódio errado (miss por episódio) mora no irmão, extraído pela
// catraca de linhas; o pai reexporta para quem consome `releaseIndex.*`.
import { markMissing, isMissing, isMissingQuiet } from './release-index-miss.js';

export type IndexedRelease = {
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

type IndexEntry = { at: number; releases: IndexedRelease[]; partial?: boolean };

type ObraLocation = { season?: number | null; episode?: number | null };

function enabled() {
  return config.releaseIndex.enabled && config.releaseIndex.ttl > 0;
}

/** `idx:v6:tt123` no filme; `idx:v6:tt123:S2:E5` / `idx:v6:tt123:S2` em série. */
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

function record(imdbId: string, location: ObraLocation, items: any[], opts: { partial?: boolean } = {}) {
  if (!enabled() || !imdbId || !String(imdbId).startsWith('tt') || !Array.isArray(items) || items.length === 0) return 0;
  const now = Date.now();
  // Marca de registro PARCIAL (colheita interrompida por teto/preempção): cada
  // chave escrita recebe o flag. Gravação completa/default limpa (last-write-wins).
  const partial = Boolean(opts.partial);
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
    cache.set(key, { at: now, partial, releases } satisfies IndexEntry, config.releaseIndex.ttl);
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

/** Variante de leitura sem efeito para ordenadores/sondas de fundo. */
function lookupQuiet(imdbId: string, { season, episode }: ObraLocation = {}): IndexedRelease[] {
  if (!enabled() || !imdbId || !String(imdbId).startsWith('tt')) return [];
  const merged = new Map<string, IndexedRelease>();
  const keys: string[] = [];
  if (season != null && episode != null) keys.push(obraKey(imdbId, { season, episode }));
  if (season != null) keys.push(obraKey(imdbId, { season }));
  keys.push(obraKey(imdbId));
  for (const key of keys) {
    const entry = cache.peek(key) as IndexEntry | null;
    for (const rel of entry?.releases || []) {
      const prior = merged.get(rel.hash);
      if (!prior || rel.seenAt > prior.seenAt) merged.set(rel.hash, rel);
    }
  }
  return [...merged.values()];
}

/**
 * Registro PARCIAL: a colheita foi interrompida (teto horário ou preempção por
 * tráfego) e o que está gravado não é a obra inteira. Espelha as três chaves
 * do lookup — episódio, temporada e raiz — com `cache.peek`: qualquer uma
 * marcada bloqueia o fast-path. Partial só BLOQUEIA, nunca libera; a gravação
 * completa seguinte (busca ao vivo ou colheita concluída) limpa o flag.
 */
function isPartial(imdbId: string, { season, episode }: ObraLocation = {}): boolean {
  if (!enabled() || !imdbId || !String(imdbId).startsWith('tt')) return false;
  const keys: string[] = [];
  if (season != null && episode != null) keys.push(obraKey(imdbId, { season, episode }));
  if (season != null) keys.push(obraKey(imdbId, { season }));
  keys.push(obraKey(imdbId));
  for (const key of keys) {
    const entry = cache.peek(key) as IndexEntry | null;
    if (entry?.partial) return true;
  }
  return false;
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

/**
 * O que os ARQUIVOS provaram sobre o torrent — áudio e resolução reais, lidos
 * quando o debrid entregou a listagem (play ou tail). É a única informação que
 * o título do post não carrega e mente com frequência:
 *
 * - "BR" na listagem é a NACIONALIDADE DO INDEXER, não o áudio. O RedeTorrent
 *   espelha release de cena em inglês e ela herda o mesmo BR do post dublado —
 *   medido no S03E03: "…H264-METCON" (inglês) e "…DUAL" (dublado) lado a lado,
 *   com rótulo idêntico e o inglês por cima.
 * - A resolução do post também mente: o 4014bd0d anuncia "3ª Temporada HD DL
 *   1080p" e contém um arquivo 720p. Filtrar 1080p escondia justamente o
 *   dublado, porque o dublado desta temporada só existe em 720p.
 *
 * Por hash e SEM escopo de conta: o conteúdo de um torrent é o mesmo para todo
 * mundo — igual ao resto do índice, que guarda o que EXISTE, não o que está
 * pronto em qual conta.
 */
type FileEvidence = { a: string; e?: 0 | 1; q: string; n: string };

function fileKey(hash: string) {
  return `${prefix('idx')}file:${String(hash || '').toLowerCase()}`;
}

function markFileEvidence(hash: string, evidence: FileEvidence) {
  if (!enabled() || !hash || !evidence) return 0;
  const key = fileKey(hash);
  const isNew = cache.get(key) == null;
  cache.set(key, evidence, config.releaseIndex.ttl);
  if (isNew) metrics.count('search.idx.file');
  return isNew ? 1 : 0;
}

function fileEvidence(hash: string): FileEvidence | null {
  if (!enabled() || !hash) return null;
  return (cache.get(fileKey(hash)) as FileEvidence) || null;
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

/**
 * Leitura em LOTE para o sampler de cobertura BR: agrega TODAS as chaves `idx`
 * de cada obra pedida (filme `idx:v6:ttX`, temporada `…:S2`, episódio
 * `…:S2E5`) numa lista única, dedupada por hash mantendo o `seenAt` mais
 * recente. Não muda formato nem namespace — é o agrupador do `lookup`, só que
 * sem a escala do episódio: aqui uma obra de um episódio agrupa todos os seus
 * episódios, porque a pergunta é "a OBRA tem ⚡", não "este episódio".
 *
 * Read-only de propósito: `keysMatching` + `peek` não promovem LRU nem contam
 * `cache.hit`/`cache.miss` — a varredura roda a cada 5 min e não pode reordenar
 * o cache nem inflar o painel com as próprias leituras.
 */
function snapshotWorks(imdbIds: string[]): Map<string, IndexedRelease[]> {
  const result = new Map<string, IndexedRelease[]>();
  const needed = new Set<string>();
  for (const id of imdbIds || []) {
    const norm = String(id || '');
    if (norm.startsWith('tt')) needed.add(norm);
  }
  const base = prefix('idx');
  const mergedByWork = new Map<string, Map<string, IndexedRelease>>();
  // UMA varredura do namespace: chamar keysMatching uma vez por cada uma das
  // 200 obras faria o sampler pagar O(coorte × índice) a cada cinco minutos.
  for (const key of cache.keysMatching(base)) {
    const match = key.slice(base.length).match(/^(tt\d+)(?::|$)/);
    const imdbId = match?.[1];
    if (!imdbId || !needed.has(imdbId)) continue;
    const entry = cache.peek(key) as { releases?: IndexedRelease[] } | undefined;
    if (!entry || !Array.isArray(entry.releases)) continue;
    const merged = mergedByWork.get(imdbId) || new Map<string, IndexedRelease>();
    for (const rel of entry.releases) {
      if (!rel || !rel.hash) continue;
      const prior = merged.get(rel.hash);
      if (!prior || rel.seenAt > prior.seenAt) merged.set(rel.hash, rel);
    }
    mergedByWork.set(imdbId, merged);
  }
  for (const [imdbId, merged] of mergedByWork) {
    if (merged.size) result.set(imdbId, [...merged.values()]);
  }
  return result;
}

/**
 * Variação de `snapshotWorks` SEM o filtro `needed` para o CATÁLOGO: agrega
 * TODAS as chaves `idx` em um Mapa hash → Obra. O catálogo da conta consulta
 * com um único hash (o magnet) e precisa saber a que obra ele pertence —
 * percorrer chave a chave seria O(índice) por magnet. Mesma disciplina
 * read-only: `keysMatching` + `peek` não promovem LRU nem contam hit/miss, e o
 * dedupe por hash mantém o registro mais recente. Retorna Map<imdbId,
 * IndexedRelease[]>, como o `snapshotWorks`.
 */
function snapshotAllWorks(): Map<string, IndexedRelease[]> {
  const result = new Map<string, IndexedRelease[]>();
  const base = prefix('idx');
  const mergedByWork = new Map<string, Map<string, IndexedRelease>>();
  for (const key of cache.keysMatching(base)) {
    const match = key.slice(base.length).match(/^(tt\d+)(?::|$)/);
    const imdbId = match?.[1];
    if (!imdbId) continue;
    const entry = cache.peek(key) as { releases?: IndexedRelease[] } | undefined;
    if (!entry || !Array.isArray(entry.releases)) continue;
    const merged = mergedByWork.get(imdbId) || new Map<string, IndexedRelease>();
    for (const rel of entry.releases) {
      if (!rel || !rel.hash) continue;
      const prior = merged.get(rel.hash);
      if (!prior || rel.seenAt > prior.seenAt) merged.set(rel.hash, rel);
    }
    mergedByWork.set(imdbId, merged);
  }
  for (const [imdbId, merged] of mergedByWork) {
    if (merged.size) result.set(imdbId, [...merged.values()]);
  }
  return result;
}

export { record, lookup, lookupQuiet, isPartial, markLied, markMissing, isMissing, isMissingQuiet, markFileEvidence, fileEvidence, status, snapshotWorks, snapshotAllWorks };
