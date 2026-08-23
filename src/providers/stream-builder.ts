import config from '../config.js';
import type { Stream } from '../../types/domain.js';
import {
  decodeEntities,
  resolveSearchNames,
  filterRelevantRaw,
  isMultiWorkCollection,
  matchesEpisode,
  UNKNOWN_QUALITY,
  toStremioStream,
  extractInfoHash,
  sortAndLimit,
  limitReservingBr,
} from '../utils/format.js';
import debrid from '../debrid/index.js';
import * as magnetdb from '../utils/magnetdb.js';
import * as releaseIndex from '../utils/release-index.js';
import { opts, prefix, origin } from '../runtime.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { applyDebrid } from './debrid-pipeline.js';

// Indexer id vindo da config do usuario (URL) precisa validar antes de
// entrar em query, limite por id ou desempate -- id fora do padrao e
// descartado silenciosamente, nunca interpolado.
export const SAFE_INDEXER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Corrige o stream com o que os ARQUIVOS provaram (áudio e resolução reais,
 * gravados pelo play/tail em `releaseIndex`). Roda ANTES do sortAndLimit de
 * propósito: `_dubbed` decide o preferDubbed/brFirst e `_quality` decide o
 * filtro de resolução e as cotas — corrigir depois arrumaria só o rótulo.
 *
 * O título do post é palpite; o nome do arquivo é fato. Medido no True
 * Detective S03: duas fontes RedeTorrent com rótulo idêntico "1080p BR", uma
 * inglesa ("H264-METCON") e uma dublada ("DUAL"), com a inglesa por cima; e o
 * dublado anunciado como 1080p sendo um arquivo 720p — filtrar 1080p escondia
 * justamente o dublado, porque nesta temporada o dublado só existe em 720p.
 *
 * Só corrige o que foi PROVADO: sem evidência o stream passa intacto.
 */
export function applyFileEvidence(items: any[]) {
  let corrigidos = 0;
  const out = items.map((item) => {
    const hash = String(extractInfoHash(item?.infoHash || item?.magnet || '') || '').toLowerCase();
    if (!hash) return item;
    const ev = releaseIndex.fileEvidence(hash);
    if (!ev) return item;
    corrigidos += 1;
    return {
      ...item,
      // Rótulo vazio com prova de release EN também é veredito: força o
      // stream a NÃO passar por dublado (o `_br` do indexer o empatava).
      ...(ev.a || ev.e ? { provenAudio: ev.a || '', provenName: ev.n || '' } : {}),
      ...(ev.q ? { provenQuality: ev.q } : {}),
    };
  });
  if (corrigidos) metrics.count('search.file.corrected', corrigidos);
  return out;
}

/**
 * Bruto dos providers → streams do Stremio: corte por título, por episódio,
 * ordenação, debrid e limite final.
 * @returns {Promise<import('../../types/domain').Stream[]>}
 */
export async function buildStreams(
  rawInput: any[],
  { meta, titles, imdbId, season, episode, isDemo, searchKey, deadlineAt, onDebridResult }: any,
) {
  // Entidade HTML some AQUI, onde todas as origens já se juntaram — Jackett,
  // resolvedores BR, índice e o inventário da conta do debrid. Decodificar só
  // na saída (toStremioStream) deixava a DECISÃO com a entidade crua: medido
  // no "Dois Homens e Meio 4&ordf; Temporada Completa", que o parser lia como
  // pack SEM temporada declarada — e pack sem temporada casa qualquer
  // episódio, então os packs da 4ª, 5ª e 6ª entravam na lista do S01E01.
  // O inventário da conta é o que obriga a normalização a ficar aqui: o nome
  // dele vem do torrent, nunca passou pelo provider.
  let raw = rawInput.map((item: any) => {
    const title = item?.title ?? item?.Title;
    if (typeof title !== 'string' || !title.includes('&')) return item;
    const limpo = decodeEntities(title);
    return limpo === title ? item : { ...item, title: limpo, ...(item.Title ? { Title: limpo } : {}) };
  });
  let autofetchCount = 0;

  // No modo demo, se não for BBB, lista vazia (esperado)
  if (isDemo && raw.length === 0) {
    log.info('[search] modo demo: só tt1254207 (Big Buck Bunny) tem stream de teste');
  }

  // Aceita qualquer um dos nomes: release BR vem como "Coringa", a do Jackett
  // como "Joker" — filtrar só pelo inglês jogaria fora a fonte dublada.
  // As releases BR passam pelo filtro mais estrito (`matchesBrTitle`): os
  // buscadores WordPress devolvem posts "parecidos" ("Missão: Impossível –
  // Efeito Fallout" numa busca por "Fallout") que disputavam as vagas
  // reservadas com a fonte real.
  //
  // O gate é a existência de ALGUM nome, não do Cinemeta: quando ele volta 404
  // mas o TMDB responde, os nomes estão ali e o filtro precisa rodar. Preso a
  // `meta?.name` ele se desligava inteiro e a lista saía sem corte nenhum.
  const { names, year: catalogYear } = resolveSearchNames({ meta, titles });
  if (names.length && !isDemo) {
    const before = raw.length;
    // Itens do inventário da conta já passaram pelo filtro DELES no provider
    // (estrito + exceção de franquia, `filterInventoryRelevant`): re-aplicar
    // o estrito aqui mataria justamente o pack de franquia que a exceção
    // deixou passar ("FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS" para Star
    // Trek). Os nomes são os mesmos do matchContext que filtrou lá.
    const fromAccount = raw.filter((r: any) => r.fromAccount);
    const titleCtx = { names, year: catalogYear, isSeries: season != null };
    raw = fromAccount.length
      ? [...fromAccount, ...filterRelevantRaw(raw.filter((r: any) => !r.fromAccount), titleCtx)]
      : filterRelevantRaw(raw, titleCtx);
    if (before !== raw.length) log.info(`[search] ${before - raw.length} resultado(s) fora do título descartado(s)`);
  }

  // Fase 2: toda busca alimenta o índice com o que sobreviveu ao filtro de
  // relevância — nada muda no caminho da resposta, a leitura vem depois. O
  // record é idempotente (merge por hash): os múltiplos passes (parcial,
  // tardio, pack, varredura) convergem para o mesmo conjunto.
  if (!isDemo && imdbId) {
    releaseIndex.record(imdbId, { season, episode }, raw);
  }

  // Guarda de coleção: pack multi-obra ("Todos os filmes 1979-2016") só é
  // oferecido quando alguém sabe escolher o arquivo certo dentro dele. Com
  // debrid, a dica de obra viaja assinada na URL e o pickFile escolhe; em P2P
  // o cliente baixaria o torrent inteiro e tocaria o MAIOR arquivo — quase
  // sempre o filme errado. Sem escolha por arquivo, o pack fica de fora.
  // Sem ano de catálogo, a dica assinada não consegue selecionar uma obra
  // dentro de uma coleção mesmo com debrid; retenha o pack nesse caso também.
  if (season == null && !isDemo && (!debrid.current() || !catalogYear)) {
    const beforePack = raw.length;
    raw = raw.filter((r: any) => !isMultiWorkCollection(r.title || r.Title || ''));
    if (beforePack !== raw.length) {
      log.info(`[search] ${beforePack - raw.length} pack(s) multi-obra retido(s) sem escolha por arquivo`);
    }
  }

  // Dica de obra para o pickFile no play (só filme): nomes + ano limpo. O ano
  // do catálogo vem sujo ("2024–" para série em andamento); sem extrair o
  // primeiro token de 4 dígitos a dica levaria NaN e o casamento falharia.
  const workHint = season == null && names.length
    ? {
      n: names.slice(0, 4),
      y: Number(String(catalogYear || '').match(/(?:19|20)\d{2}/)?.[0] || 0) || null,
    }
    : null;

  // Série: o indexer responde a "Nome S01E01" com a temporada inteira, então
  // sem este corte a lista do E01 vinha cheia de E03/E04/E09. Packs (título com
  // a temporada e sem episódio) passam — o debrid escolhe o arquivo no play.
  if (season != null && episode != null && !isDemo) {
    const before = raw.length;
    raw = raw.filter((r: any) => matchesEpisode(r.title || r.Title || '', { season, episode }));
    if (before !== raw.length) {
      log.info(`[search] ${before - raw.length} resultado(s) de outro episódio descartado(s)`);
    }
  }

  // Pool maior que MAX_RESULTS: o corte final é DEPOIS do debrid, senão fontes
  // sem seeders publicados (BLUDV) e não-cacheados ocupariam as vagas e sumiriam.
  const {
    minSeeders,
    maxResults,
    qualities,
    preferDubbed,
    excludeCam,
    maxSizeGb,
    max2160p,
    max1080p,
    max720p,
    max480p,
    maxSd,
    maxUnknown,
    maxPerIndexer,
    indexerLimits,
    brReservedSlots,
    brOnly,
    brFirst,
    indexerPriority,
  } = opts();
  const safeIndexerPriority = indexerPriority
    .filter((id: any) => SAFE_INDEXER_ID.test(String(id)))
    .slice(0, 100);
  const safeIndexerLimits: Record<string, number> = {};
  for (const [rawId, rawLimit] of Object.entries(indexerLimits || {}).slice(0, 100)) {
    const id = String(rawId).toLowerCase();
    if (!SAFE_INDEXER_ID.test(id)) continue;
    const limit = Number(rawLimit);
    if (!Number.isFinite(limit)) continue;
    safeIndexerLimits[id] = Math.min(20, Math.max(0, Math.trunc(limit)));
  }
  const qualityLimits = {
    '2160p': max2160p,
    '1080p': max1080p,
    '720p': max720p,
    '480p': max480p,
    SD: maxSd,
    // Balde separado do SD: as fontes BR não publicam resolução e zerar SD não
    // pode desligar a prioridade brasileira junto.
    [UNKNOWN_QUALITY]: maxUnknown,
  };
  // Tipado como Stream[] de propósito: é este array que `applyNoticeOrigin`
  // fecha como item de aviso e entrega ao Stremio. Um item sem `url`/`infoHash`/
  // `externalUrl` (e sem a marca interna `notice`) morre fora da união — o que
  // deixa explícito na origem o aviso que nenhum cliente renderizava.
  // O que os arquivos provaram entra ANTES do mapeamento: o nome, o `_quality`
  // e o `_dubbed` nascem do item, e sao eles que o filtro de resolucao, as cotas
  // e o preferDubbed leem depois.
  const mappedStreams = applyFileEvidence(raw).map(toStremioStream);
  // Histórico durável do banco de magnets: quem o debrid desta conta comprovou
  // como play instantâneo ganha desempate acima dos seeders no sort.
  const aliveAdapter = debrid.current();
  const aliveApiKey = opts().debridApiKey;
  const liedHashes = new Set(
    raw
      .filter((item: any) => item?.lied)
      .map((item: any) => String(extractInfoHash(item.infoHash || item.magnet || '') || '').toLowerCase())
      .filter(Boolean),
  );
  // `toStremioStream` devolve NULL para item sem infoHash (link que nenhum
  // resolvedor abriu), e `sortAndLimit` recebe `(Stream | null)[]` de propósito
  // — o buraco tem que ser filtrado ANTES do acesso, senão um único resultado
  // sem hash derruba a lista inteira com TypeError.
  const instantSet = aliveAdapter && aliveApiKey
    ? new Set(mappedStreams.map((s: any) => s?.infoHash).filter(Boolean)
        .filter((h: string) => magnetdb.isAlive(aliveAdapter.id, aliveApiKey, h)))
    : null;
  const liedSet = aliveAdapter && aliveApiKey
    ? new Set(mappedStreams.map((s: any) => s?.infoHash).filter(Boolean)
        .filter((h: string) => liedHashes.has(String(h).toLowerCase()) || magnetdb.isLie(aliveAdapter.id, aliveApiKey, h)))
    : liedHashes;
  const markedStreams = mappedStreams.map((stream: any) =>
    stream && liedSet.has(String(stream.infoHash || '').toLowerCase()) ? { ...stream, _lied: true } : stream,
  );
  let streams: Stream[] = sortAndLimit(markedStreams, {
    minSeeders,
    maxResults: maxResults * config.candidatePoolFactor,
    qualityFilter: qualities,
    season,
    episode,
    preferDubbed,
    excludeCam,
    maxSizeGb,
    qualityLimits,
    brReservedSlots,
    brReservedPerQuality: config.brReservedPerQuality,
    candidateFactor: config.candidatePoolFactor,
    brFirst,
    indexerPriority: safeIndexerPriority,
    instant: instantSet ? (h: string) => instantSet.has(String(h).toLowerCase()) : undefined,
  });

  // Contagem ANTES do debrid: `applyDebrid` já devolve a lista pós-cachedOnly,
  // então usar o retorno dele para decidir o aviso era medir depois do corte —
  // no caso que motivou o aviso (nada em cache) ele volta VAZIO e a condição
  // nunca ligava.
  const candidatesBeforeDebrid = streams.length;
  // Cortados pelo filtro pré-checagem (histórico ruim), reportados pelo
  // applyDebrid só quando eles esvaziam a lista — é a única vez em que o texto
  // "fora do cache" mentiria sobre o motivo.
  let trustDropped = 0;
  const beforeCut = await applyDebrid(streams, {
    season,
    episode,
    imdbId,
    searchKey,
    deadlineAt,
    onCacheResult: (result: any) => {
      autofetchCount += result.autofetchCount || 0;
      trustDropped += result.trustDropped || 0;
      if (onDebridResult) onDebridResult(result);
    },
    workHint,
  });
  streams = limitReservingBr(beforeCut, {
    brReservedSlots,
    brReservedPerQuality: config.brReservedPerQuality,
    maxResults,
    brOnly,
    qualityLimits,
    brFirst,
    maxPerIndexer,
    indexerLimits: safeIndexerLimits,
    season,
  });

  // Tres estados, nesta ordem de precisao: ja mandamos baixar / achamos mas o
  // cachedOnly cortou / nao achamos nada ainda. O terceiro so vale para SERIE,
  // que e onde a busca tardia de pack roda de verdade — prometer "reabra em
  // instantes" num filme sem resultado seria mentira.
  const noticeText = () => {
    if (autofetchCount > 0) return '⏳ Baixando no debrid — reabra em alguns minutos';
    if (candidatesBeforeDebrid > 0 && trustDropped >= candidatesBeforeDebrid) {
      return `Nenhuma fonte pronta — ${trustDropped} resultado(s) descartado(s) por histórico ruim nesta conta do debrid`;
    }
    if (candidatesBeforeDebrid > 0) {
      return `Nenhuma fonte pronta — ${candidatesBeforeDebrid} resultado(s) fora do cache`;
    }
    if (season != null) return 'Nada pronto ainda — procurando a temporada; reabra em instantes';
    return null;
  };
  // Só o TEXTO nasce aqui: ele depende da busca (autofetch, cortados pelo
  // cachedOnly, temporada) e viaja para o cache junto com a lista. O link sai no
  // `applyNoticeOrigin`, na resposta — ver lá por que ele não pode ser montado
  // neste ponto.
  if (config.search.noticeStream && streams.length === 0) {
    const name = noticeText();
    if (name) streams = [{ name, notice: true }];
  }

  // "A dublada não ficou em cima" é a queixa mais comum e tem três causas
  // distintas (não veio da fonte / veio mas foi cortada / veio e ficou abaixo).
  // Sem este log as três são indistinguíveis a partir da lista final, porque o
  // corte apaga os campos internos que responderiam a pergunta.
  const brIn = beforeCut.filter((s: any) => s._br);
  const dubIn = brIn.filter((s: any) => s._dubbed);
  const head = streams.slice(0, 3).map((s) => (s.name || '').split('\n')[1] || '?').join(' / ');
  log.info(
    `[search] entrada do corte: ${beforeCut.length} stream(s), ${brIn.length} BR (${dubIn.length} dublada(s))` +
      ` | brFirst=${brFirst} preferDubbed=${preferDubbed} | topo: ${head}`,
  );

  return streams;
}

// `buildStreams` sai exportado pelo mesmo motivo do `applyDebrid`: e o unico
// jeito de testar o item de aviso sem subir uma busca inteira com Jackett.
/**
 * Fecha o aviso de lista vazia na RESPOSTA, com o origin de quem está
 * perguntando agora. O texto é conteúdo da busca e fica no cache; o link não
 * pode: `streamsCacheKey` não carrega o origin, então montá-lo dentro do
 * `buildStreams` gravava na entrada compartilhada o endereço do primeiro
 * cliente — a TV que chama 192.168.0.23 deixava esse link para o celular que
 * chama pelo domínio, e um `Host` forjado envenenava a entrada para o próximo.
 *
 * PUBLIC_URL (endereço público) tem precedência; sem ela vale o origin da
 * requisição, que por definição é um endereço que aquele cliente alcança.
 *
 * Sem origin nenhum (chamada interna, teste sem req) o item é DESCARTADO: sem
 * `url`/`infoHash`/`externalUrl` nenhum cliente Stremio renderiza a linha, então
 * ela só ocuparia a resposta e sumiria na tela — foi o que deixou o app com
 * "Nenhum stream disponível" enquanto a busca já tinha resultado.
 */
export function applyNoticeOrigin(streams: Stream[] = []) {
  if (!streams.some((stream) => stream?.notice)) return streams;
  const base = (config.debrid.publicUrl || origin() || '').replace(/\/$/, '');
  const link = base ? `${base}${prefix()}/configure` : '';
  return streams.flatMap((stream) => {
    if (!stream?.notice) return [stream];
    if (!link) return [];
    // `notice` é marca interna: não faz parte do objeto que o Stremio recebe.
    const { notice, ...rest } = stream;
    return [{ ...rest, externalUrl: link }];
  });
}

/** A lista não tem resultado nenhum — só o aviso. */
export function onlyNotice(streams: Stream[] = []) {
  return streams.length > 0 && streams.every((stream) => stream?.notice);
}
