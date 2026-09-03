import type { MatchContext } from '../../types/domain.js';
import config from '../config.js';
import jackett from './jackett.js';
import { opts } from '../runtime.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { extractInfoHash } from '../utils/format.js';
import { SAFE_INDEXER_ID } from './stream-builder.js';
import { ptSweepIndexers } from './search-plan.js';
import type { RawBatch } from './search-index-path.js';

/**
 * Varredura pt-BR nos indexers GLOBAIS: tracker global hospeda bastante dublado
 * titulado em português ("Jornada Nas Estrelas … Dublado") que a query em inglês
 * não encontra. Roda FORA do caminho da resposta (nunca disputa o orçamento), com
 * `recordStatus:false` para a segunda consulta não poluir o card de status, e
 * `ignoreBreaker:true` para consultar mesmo indexer recém-derrubado — o dublado
 * raro mora justamente ali. Só adiciona hashes novos: título pt para hash já
 * listado é assunto do merge, não da varredura.
 *
 * `enqueueTail` é a mesma fila serial compartilhada com o refresh de debrid (para
 * não executar applyDebrid/upload concorrentes na mesma chave); `raw`/`finish`/
 * `responsePhase` vêm fechados sobre a execução corrente de `doSearch`.
 */
export function schedulePtSweepTail({ raw, finish, responsePhase, enqueueTail, type, matchContext, sweepQuery, wantsJackettSweep }: {
  raw: RawBatch;
  finish: (input: { items: any[]; partial: boolean }, phase?: number) => Promise<any>;
  responsePhase: number;
  enqueueTail: (task: () => any) => Promise<unknown>;
  type: string;
  matchContext: MatchContext;
  sweepQuery: string | null;
  wantsJackettSweep: boolean;
}) {
  const configuredIndexers = opts().jackettIndexers?.length ? opts().jackettIndexers : config.jackett.indexers;
  const sweepSelectedIndexers: string[] = [...new Set((configuredIndexers || []).filter((idx: any) =>
    SAFE_INDEXER_ID.test(String(idx)),
  ))].map(String);
  // A query já foi anexada ao plano crítico: título pt-BASE para filme e série,
  // sem subtítulo, ano ou SxxEyy. Os globais publicam episódios como
  // "T01 E004"; o matchContext faz o corte preciso depois da coleta.
  if (config.jackett.ptSweepGlobal && wantsJackettSweep && sweepQuery && sweepSelectedIndexers.length > 0) {
    const sweepTargets = ptSweepIndexers(sweepSelectedIndexers, config.jackett.ptBrIndexers);
    if (sweepTargets.length > 0) {
      if (raw.partial || !raw.sweepInline) enqueueTail(async () => {
        metrics.count('search.pt-sweep.run');
        const sweepStarted = Date.now();
        try {
          // Se a coleta ainda estava aberta, espera o balde estabilizar para o
          // inventário de hashes conhecidos não sair incompleto.
          if (raw.partial && raw.completion) await raw.completion;
          const found = await jackett.search(sweepQuery, type, sweepTargets, {
            matchContext,
            recordStatus: false,
            ignoreBreaker: true,
            // Fora do caminho da resposta: o desperdício medido é trabalho de
            // fundo da caça pt-BR, não custo do orçamento crítico.
            background: true,
          });
          metrics.count('search.pt-sweep.found', found.length);
          if (!found.length) return;
          const known = new Set(
            raw.items.map((item) => extractInfoHash(item.infoHash || item.magnet)).filter(Boolean),
          );
          const fresh = found.filter((item: any) => {
            const h = extractInfoHash(item.infoHash || item.magnet);
            return h && !known.has(h);
          });
          if (!fresh.length) {
            // Achou, mas tudo já era conhecido: a métrica distingue "não
            // achou" de "achou e já tínhamos" — juntar os dois escondia o
            // caso real de "varredura está caindo cedo demais".
            metrics.count('search.pt-sweep.known');
            log.info(`[search] varredura pt-BR: ${found.length} resultado(s), nenhum novo (query "${sweepQuery}")`);
            return;
          }
          raw.items.push(...fresh);
          metrics.count('search.pt-sweep.hit');
          log.info(`[search] varredura pt-BR nos globais trouxe ${fresh.length} resultado(s) novo(s) (query "${sweepQuery}"); recacheando`);
          await finish({ items: raw.items, partial: false }, responsePhase);
        } catch (err) {
          log.warn('[search] varredura pt-BR nos globais falhou:', err?.message || err);
        } finally {
          metrics.observe('search.pt-sweep', Date.now() - sweepStarted);
        }
      });
    } else {
      log.debug('[search] varredura pt-BR não executada: nenhum indexer global selecionado');
    }
  } else if (config.jackett.ptSweepGlobal && wantsJackettSweep && !sweepQuery) {
    log.debug('[search] varredura pt-BR não executada: não há query localizada ativa');
  } else if (config.jackett.ptSweepGlobal && wantsJackettSweep && sweepSelectedIndexers.length === 0) {
    log.debug('[search] varredura pt-BR não executada: nenhum indexer selecionado');
  }
}
