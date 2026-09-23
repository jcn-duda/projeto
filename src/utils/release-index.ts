// Índice de releases por obra (`idx:v6`): a memória que faz o addon virar
// servidor. O `raw:v1` guarda a raspagem por QUERY; aqui guarda o que a obra
// TEM, filtrado e dedupado por hash, e vive semanas.
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
import { extractInfoHash, qualityFromTitle, audioFromTitle, explicitPtAudio, looksPtBr } from './format.js';
import { magnetDisplayName } from './title-normalization.js';
import { bankRowsForMediaSource, mergeMediaSource } from './release-index-media.js';
import { routeWorkLocation } from './release-work.js';
// Prova de miss por episódio mora no irmão (extraído pela catraca); o pai reexporta.
import { markMissing, markMissingSeason, isMissing, isMissingQuiet } from './release-index-miss.js';
import { cutProtected } from './release-index-cut.js';
import { markFileEvidence, fileEvidence } from './release-index-file.js';
import type { IndexEntry, IndexedRelease, ObraLocation } from './release-index-types.js';
export type { IndexedRelease } from './release-index-types.js';
export { forgetAutofetchHash } from './release-index-maintenance.js';
export type { FileEvidence } from './release-index-file.js';
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
 * Onde a release PERTENCE — título e, se mais específico, o `dn=` do magnet.
 * Roteia, não descarta: consulta Jackett já paga vira cobertura do episódio
 * dela. Post "4ª Temporada" + dn `…S04E03…` → chave do E03, não do S4E1 pedido.
 */
function destinoDe(imdbId: string, pedido: ObraLocation, title: string, dn?: string) {
  return obraKey(imdbId, routeWorkLocation(
    { season: pedido.season ?? null, episode: pedido.episode ?? null },
    title,
    dn,
  ));
}

/** dn do item; sem ele, URI/título do banco vivo (mesma fonte do mediaSource). */
function dnForRecord(item: any, hash: string, bankByHash: Map<string, { uri?: string; title?: string }>): string {
  const fromItem = magnetDisplayName(item);
  if (fromItem) return fromItem;
  const row = bankByHash.get(hash);
  if (!row) return '';
  return magnetDisplayName({ magnet: row.uri }) || String(row.title || '') || '';
}

/**
 * Alimenta o índice com o que a busca provou existir. Idempotente: merge por
 * hash, mais recente vence; itens sem hash e da conta ficam fora.
 */
function record(
  imdbId: string,
  location: ObraLocation,
  items: any[],
  opts: { partial?: boolean; source?: 'autofetch' } = {},
) {
  if (!enabled() || !imdbId || !String(imdbId).startsWith('tt') || !Array.isArray(items) || items.length === 0) return 0;
  const now = Date.now();
  // Marca de registro PARCIAL (colheita interrompida por teto/preempção): cada
  // chave escrita recebe o flag. Gravação completa/default limpa (last-write-wins).
  const partial = Boolean(opts.partial);
  const pedida = obraKey(imdbId, location);
  // Candidatos ANTES do agrupamento: o bank precisa alimentar destinoDe (dn
  // mais específico que o título) — carregar depois do agrupamento chegava
  // tarde e o pack genérico caía na chave errada / era descartado no corte.
  const candidatos: { item: any; hash: string; title: string }[] = [];
  for (const item of items) {
    // Inventário da conta NÃO é evidência pública de existência: o que ele
    // tem pronto diz respeito à conta dele (davail/mag), nunca ao índice.
    if (item?.fromAccount) continue;
    const hash = String(extractInfoHash(item.infoHash || item.magnet || '') || '').toLowerCase();
    if (!hash) continue;
    candidatos.push({ item, hash, title: String(item.title || item.Title || '').trim() });
  }
  const bankByHash = bankRowsForMediaSource(candidatos);
  const porChave = new Map<string, typeof candidatos>();
  for (const cand of candidatos) {
    const dn = dnForRecord(cand.item, cand.hash, bankByHash);
    const destino = destinoDe(imdbId, location, cand.title, dn);
    if (destino !== pedida) metrics.count('search.idx.routed');
    const lote = porChave.get(destino) || [];
    lote.push(cand);
    porChave.set(destino, lote);
  }

  let added = 0;
  for (const [key, lote] of porChave) {
    const existing = new Map<string, IndexedRelease>();
    const novos = new Set<string>();
    const entry = cache.get(key);
    for (const rel of entry?.releases || []) existing.set(rel.hash, rel);
    for (const { item, hash, title } of lote) {
      const prior = existing.get(hash);
      const itemSource = item.indexSource === 'autofetch' ? 'autofetch' : opts.source;
      const promotesObserved = prior?.source === 'autofetch' && itemSource !== 'autofetch';
      if (prior && prior.seenAt >= now && !promotesObserved) continue;
      if (!prior) novos.add(hash);
      // DUAL sem PT explícito não vale como dublado fora dos sites BR (toStremioStream).
      // O item BRUTO chega com o isBr da LISTAGEM — que o overlay Jev (gateado)
      // pode ter derrubado ao vivo num generic DUB isolado. Aqui o campo
      // PERSISTE por semanas: reclassifica o título com {overlay:false} para o
      // acervo nascer determinístico (igual ao legado) em QUALQUER produtor
      // (jackett/colhedor/autofetch) — sem bump de namespace e sem tocar a
      // listagem, que reclassifica em toStremioStream com o overlay.
      const isBr = Boolean(item.isBr) || looksPtBr(title, { overlay: false }) || Boolean(prior?.isBr);
      // {overlay:false}: o índice PERSISTE `dubbed` por semanas — a
      // leitura viva do cache Jev (overlay gateado) não pode reescrever
      // retroativamente o acervo, então a classificação do idx fica
      // determinística (igual ao legado) e NÃO exige bump de namespace.
      const classifiedDubbed = isBr
        ? ['Dublado', 'Dual', 'Nacional'].includes(String(audioFromTitle(title, { overlay: false })))
        : explicitPtAudio(title, { overlay: false });
      // No autofetch a classificação já atravessou toStremioStream e pode incluir
      // prova de arquivo; reclassificar só pelo título perderia essa evidência.
      const dubbed = itemSource === 'autofetch' && item.dubbed !== undefined
        ? Boolean(item.dubbed)
        : classifiedDubbed;
      // Observação pública nunca rebaixa para "só autofetch"; o normal promove ao rever.
      const source = itemSource === 'autofetch' && (!prior || prior.source === 'autofetch')
        ? 'autofetch' as const
        : undefined;
      const mediaSource = mergeMediaSource(item, title, hash, prior, bankByHash);
      existing.set(hash, {
        hash,
        title: title || prior?.title || '',
        size: Number(item.size ?? item.Size) || null,
        // indexer: id da origem (legado pode cair no tracker). tracker: rótulo real, se houver.
        indexer: String(item.indexer || item.tracker || prior?.indexer || ''),
        tracker: String(item.tracker || prior?.tracker || '') || undefined,
        isBr,
        dubbed: Boolean(dubbed) || Boolean(prior?.dubbed),
        quality: String(itemSource === 'autofetch' && item.quality ? item.quality : qualityFromTitle(title)),
        // Fusão por hash: teto de seeders — snapshot pior não rebaixa (Mortuary).
        seeders: Math.max(Number(item.seeders ?? item.Seeders ?? 0) || 0, Number(prior?.seeders) || 0),
        seenAt: now,
        lied: Boolean(item.lied) || Boolean(prior?.lied),
        source,
        ...(mediaSource ? { mediaSource } : {}),
      });
    }
    if (existing.size === 0) continue;
    // Corte do teto com proteção BR/dublado — regras em release-index-cut.ts.
    const releases = cutProtected(existing.values(), Math.max(1, config.releaseIndex.maxReleases));
    added += releases.filter((r) => novos.has(r.hash)).length;
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
 * Limpa o flag `partial` em TODAS as chaves idx da obra, mantendo as releases.
 * Motivo: série semeada (season null) grava partial na raiz; busca de episódio
 * nunca reescreve a raiz; capped.dropped tira da fila e o flag ficava até o
 * TTL (~30d) bloqueando o fast-path da série inteira. `location` é opcional —
 * a limpeza é por obra inteira mesmo. Prefixo estrito (`key === base` ou
 * `base:`) evita colidir tt123 com tt1234 no `keysMatching`.
 */
function clearPartial(imdbId: string, _location: ObraLocation = {}): number {
  if (!enabled() || !imdbId || !String(imdbId).startsWith('tt')) return 0;
  const base = obraKey(imdbId);
  let cleared = 0;
  for (const key of cache.keysMatching(base)) {
    if (key !== base && !key.startsWith(`${base}:`)) continue;
    const entry = cache.peek(key) as IndexEntry | null;
    if (!entry?.partial) continue;
    // Preserva o TTL restante; sem peekRemaining, regrava com o TTL do índice
    // (mesma disciplina do markLied/record).
    const ttl = cache.peekRemaining(key) ?? config.releaseIndex.ttl;
    if (!ttl || ttl <= 0) continue;
    const { partial: _drop, ...rest } = entry;
    cache.set(key, { ...rest } satisfies IndexEntry, ttl);
    cleared += 1;
  }
  return cleared;
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
/** Para o painel: quanto do índice existe agora. */
function status() {
  const ns = cache.snapshot().namespaces as Record<string, any>;
  return {
    enabled: enabled(),
    ttlS: config.releaseIndex.ttl,
    entries: ns?.idx?.entries || 0,
    // Sem snapshot, inventar 4000 (promessa do PLANO_SERVIDOR, nunca entregue)
    // mentiria a ocupação no painel — zero é mais honesto que um teto fantasma.
    maxEntries: ns?.idx?.maxEntries || cache.QUOTAS?.idx || 0,
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

export { record, lookup, lookupQuiet, isPartial, clearPartial, markLied, markMissing, markMissingSeason, isMissing, isMissingQuiet, markFileEvidence, fileEvidence, status, snapshotWorks, snapshotAllWorks };
