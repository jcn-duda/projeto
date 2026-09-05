import config from '../config.js';
import type { DebridAdapter, Stream, WorkHint } from '../../types/domain.js';
import { parseTitleSeasonEpisode } from '../utils/format.js';
import debrid from '../debrid/index.js';
import * as magnetdb from '../utils/magnetdb.js';
import * as releaseIndex from '../utils/release-index.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import * as cache from '../utils/cache.js';
import { opts } from '../runtime.js';
import { accountScope } from '../utils/request-key.js';
import * as protectedApi from '../debrid/protected.js';
import { isDubLieError, isEpisodePickError } from '../debrid/common.js';
import type { ApplyDebridOptions } from './debrid-pipeline-core.js';

// Fase D da auditoria de áudio: candidatos ⚡ dublados confirmados em cache
// nesta busca. A prova (paths reais dos vídeos) só existe no debrid; esperar
// o play descobrir entrega inglês sob selo DUB BR uma vez por hash — o tail
// prova ANTES, grava a mesma evidência do play e a próxima lista já nasce
// honesta. Fila curta de propósito: sobra de busca sem tail não acumula.
type DubAuditCandidate = {
  hash: string;
  season: number | null;
  episode: number | null;
  imdbId: string | null;
  work?: WorkHint;
  dubbed: boolean;
  key?: string | null;
  extraKeys?: string[];
};
// Estado mutável com dono único: a fila pendente vive AQUI e em mais nenhum
// módulo — o pipeline só enfileira candidatos, nunca toca o array direto.
const dubAuditPending: DubAuditCandidate[] = [];

/** ⚡ em cache = o que o usuário vai tocar; é isso que o tail interrogará.
 * Dois grupos: (1) dublados — provam a promessa de áudio; (2) em série, os
 * que NÃO nomeiam o episódio pedido — pack de temporada pode conter outra
 * coisa (caso True Detective). Dedupe por hash preserva a variante dublada. */
export function collectAuditCandidates(
  list: Stream[],
  cached: Set<string>,
  { season, episode, imdbId, workHint }: Pick<ApplyDebridOptions, 'season' | 'episode' | 'imdbId' | 'workHint'>,
) {
  const work = (s: Stream): WorkHint | undefined => (workHint ? { names: workHint.n, year: workHint.y, pack: Boolean(s._multiWork) } : undefined);
  const byHash = new Map<string, DubAuditCandidate>();
  for (const s of list) {
    if (!s.infoHash || !s._dubbed || !cached.has(s.infoHash)) continue;
    byHash.set(String(s.infoHash), {
      hash: String(s.infoHash),
      season: season ?? null,
      episode: episode ?? null,
      imdbId: imdbId || null,
      work: work(s),
      dubbed: true,
    });
  }
  if (season != null && episode != null) {
    for (const s of list) {
      if (!s.infoHash || !cached.has(s.infoHash)) continue;
      const hash = String(s.infoHash);
      // A variante dublada já interrogará este hash — e o resultado dela vale
      // para os dois grupos (a prova é sobre o conteúdo, não sobre o selo).
      if (byHash.has(hash)) continue;
      if (nomeiaEpisodio(s.title || s.name || '', season, episode)) continue;
      byHash.set(hash, {
        hash,
        season,
        episode,
        imdbId: imdbId || null,
        work: work(s),
        dubbed: false,
      });
    }
  }
  return [...byHash.values()];
}

export function queueDubAudit(adapterId: string, apiKey: string, candidates: DubAuditCandidate[], searchKey: string | null = null) {
  if (!config.audioAudit.enabled || config.debrid.dubAuditTailMax <= 0) return;
  let added = false;
  for (const cand of candidates) {
    // Já condenado nesta conta não gasta consulta de novo.
    if (magnetdb.isLie(adapterId, apiKey, cand.hash)) continue;
    // Já está na fila para o MESMO episódio: busca repetida não pode duplicar
    // o interrogatório. Temporada/episódio entram na comparação porque o
    // MESMO pack serve episódios diferentes (navegação E01 → E02 enfileira de
    // novo, com a própria chave de lista). Se a candidatura repete com chave
    // de busca diferente, acumula a chave extra: a prova invalida TODAS as
    // listas afetadas, não só a primeira.
    const candHash = String(cand.hash || '').toLowerCase();
    const prev = dubAuditPending.find((p) => String(p.hash || '').toLowerCase() === candHash
      && p.season === cand.season && p.episode === cand.episode);
    if (prev) {
      if (cand.key && prev.key && cand.key !== prev.key) {
        prev.extraKeys = prev.extraKeys || [];
        if (!prev.extraKeys.includes(cand.key)) prev.extraKeys.push(cand.key);
      }
      continue;
    }
    // Já provou não servir ESTE episódio (play ou tail anterior).
    if (cand.imdbId && cand.season != null && cand.episode != null
      && releaseIndex.isMissing(cand.imdbId, { season: cand.season, episode: cand.episode }, cand.hash)) continue;
    dubAuditPending.push({ ...cand, key: searchKey });
    added = true;
  }
  if (dubAuditPending.length > 50) dubAuditPending.splice(0, dubAuditPending.length - 50);
  // A drenagem é agendada NO enfileiramento, de propósito: os candidatos BR
  // costumam chegar pelo passe tardio, DEPOIS do ponto da busca que responderia
  // — e a busca seguinte pode sair do cache sem rodar doSearch de novo. O
  // setImmediate criado AQUI herda o AsyncLocalStorage da requisição que
  // enfileirou (opts() continua vendo a conta certa), e cada drenagem leva
  // consigo a chave da lista para invalidar quem provou mentira.
  if (added) {
    const handle = setImmediate(async () => {
      try {
        const r = await runDubAudit();
        if (r.audited > 0) log.info(`[audit] tail: ${r.audited} candidato(s) provado(s), ${r.lies} mentira(s), ${r.wrongEpisodes} episódio(s) errado(s)`);
      } catch (err) {
        log.warn('[audit] drenagem falhou:', err?.message || err);
      }
    });
    handle.unref?.();
  }
}

/**
 * Prova os candidatos pendentes no debrid; mentira vira a MESMA evidência do
 * play (mag lie + idx.lied). Falha de rede/credencial não é evidência — o
 * candidato volta a entrar na próxima busca. O link resolvido é descartado:
 * aqui não é play, é interrogatório.
 */
export async function runDubAudit(limit = config.debrid.dubAuditTailMax) {
  const batch = dubAuditPending.splice(0, Math.max(0, Math.trunc(Number(limit) || 0)));
  let lies = 0;
  let wrongEpisodes = 0;
  const liedKeys = new Set<string>();
  for (const cand of batch) {
    try {
      await debrid.resolveLink(cand.hash, { season: cand.season, episode: cand.episode, work: cand.work, dubbed: Boolean(cand.dubbed) });
    } catch (err) {
      if (isDubLieError(err)) {
        lies += 1;
        const adapter = debrid.current() as DebridAdapter | null;
        if (adapter) magnetdb.markLie(adapter.id, opts().debridApiKey, cand.hash);
        if (adapter) {
          // Release provou EN apesar da promessa de dublado: não é acervo BR
          // confiável — destrava a proteção durável daquela conta/adapter.
          protectedApi.unprotect(adapter.id, accountScope(opts().debridApiKey), cand.hash);
        }
        if (cand.imdbId) releaseIndex.markLied(cand.imdbId, { season: cand.season, episode: cand.episode }, cand.hash);
        if (cand.key) liedKeys.add(cand.key);
        for (const extra of cand.extraKeys || []) if (extra) liedKeys.add(extra);
        metrics.count('debrid.audit.lie.tail');
        log.warn(`[audit] tail provou mentira ${String(cand.hash).slice(0, 8)}${err.evidence?.matchedGroup ? ` (${err.evidence.matchedGroup})` : ''}`);
      } else if (isEpisodePickError(err)) {
        // Ambiguidade (SEM evidência): o throw multi-vídeo diz "não
        // identifiquei", não "é outro episódio" — loga para observabilidade
        // e segue sem gravar nada nem invalidar lista.
        if (!err.evidence) {
          log.warn(
            `[audit] tail: episódio não identificado em ${String(cand.hash).slice(0, 8)} (ambiguidade, sem prova)` +
            `${err.context ? ` — ${err.context.videoCount} vídeo(s): ${err.context.samples.join(' | ')}` : ''}`,
          );
          continue;
        }
        // Prova MEDIDA (com evidência): o nome do arquivo declarou outro s/e.
        // NÃO é mentira de áudio nem magnet quebrado: markLie/markLied ficam
        // de fora — a evidência é fina, só o episódio pedido está errado.
        wrongEpisodes += 1;
        metrics.count('debrid.audit.episode');
        if (cand.imdbId && cand.season != null && cand.episode != null) {
          releaseIndex.markMissing(cand.imdbId, { season: cand.season, episode: cand.episode }, cand.hash);
        }
        if (cand.key) liedKeys.add(cand.key);
        for (const extra of cand.extraKeys || []) if (extra) liedKeys.add(extra);
        log.warn(`[audit] tail provou episódio errado ${String(cand.hash).slice(0, 8)} (declara S${err.evidence.declaredSeasons.join(',') || '?'}E${err.evidence.declaredEpisodes.join(',') || '?'})`);
      }
    }
  }
  // A lista corrente ainda carrega o candidato provado-ruim: invalida para a
  // próxima busca nascer limpa, sem esperar TTL nem play de ninguém.
  for (const key of liedKeys) cache.forget(key);
  return { audited: batch.length, lies, wrongEpisodes };
}

/** O título NOMEIA este episódio? Pack de temporada casa o episódio no
 * `matchesEpisode` de propósito (ele contém o episódio), mas não o NOMEIA —
 * e a diferença decide quem pode sustentar a cobertura do índice. */
export function nomeiaEpisodio(title: string, season: number, episode: number) {
  const { seasons, episodes } = parseTitleSeasonEpisode(String(title || ''));
  return episodes.includes(episode) && (seasons.length === 0 || seasons.includes(season));
}
