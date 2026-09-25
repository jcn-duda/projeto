import type { MatchContext } from '../../types/domain.js';
import config from '../config.js';
import jackett from './jackett.js';
import { opts } from '../runtime.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { extractInfoHash } from '../utils/format.js';
import { SAFE_INDEXER_ID } from './stream-builder.js';
import { ptSweepIndexers } from './search-plan.js';
import { jackettOnly } from './mico.js';
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
export function schedulePtSweepTail({ raw, finish, responsePhase, enqueueTail, type, matchContext, sweepQuery, wantsJackettSweep, imdbId }: {
  raw: RawBatch;
  finish: (input: { items: any[]; partial: boolean; live?: any }, phase?: number) => Promise<any>;
  responsePhase: number;
  enqueueTail: (task: () => any) => Promise<unknown>;
  type: string;
  matchContext: MatchContext;
  sweepQuery: string | null;
  wantsJackettSweep: boolean;
  /** Obra da busca: alimenta o banco de magnets vivo (captura por item). */
  imdbId?: string | null;
}) {
  const configuredIndexers = opts().jackettIndexers?.length ? opts().jackettIndexers : config.jackett.indexers;
  const sweepSelectedIndexers: string[] = [...new Set(jackettOnly(configuredIndexers || []).filter((idx: any) =>
    SAFE_INDEXER_ID.test(String(idx)),
  ))].map(String);
  // A query já foi anexada ao plano crítico: título pt-BASE para filme e série,
  // sem subtítulo, ano ou SxxEyy. Os globais publicam episódios como
  // "T01 E004"; o matchContext faz o corte preciso depois da coleta.
  //
  // Index-only ficam fora da varredura de cauda: a busca viva já os tirou do
  // plano e o colhedor os consulta individualmente com orçamento dedicado —
  // o 1337x aqui recolocava na cauda a latência (12–19s frio + redirect /dl
  // de 1,8–6,5s) que o index-only existe para isolar.
  if (config.jackett.ptSweepGlobal && wantsJackettSweep && sweepQuery && sweepSelectedIndexers.length > 0) {
    const sweepTargets = ptSweepIndexers(sweepSelectedIndexers, config.jackett.ptBrIndexers, config.jackett.indexOnlyIndexers);
    if (sweepTargets.length > 0) {
      if (raw.partial || !raw.sweepInline) enqueueTail(async () => {
        // A via INSTANTÂNEA responde do banco e a coleta `all` do tail pode JÁ
        // ter rodado a varredura inline. `raw.sweepInline` é setado em runtime
        // (antes deste task na fila serial), então a marca aqui evita rodar a
        // mesma varredura duas vezes.
        if (raw.sweepInline) {
          log.debug('[search] varredura pt-BR já rodou inline; cauda não repete');
          return;
        }
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
            // Obra da busca para o banco de magnets vivo (captura por item).
            // A varredura de cauda entra no `raw.items` e passa pelo build: o
            // filtro roda e escreve o resultado, então a captura reseta.
            imdbId,
            season: matchContext.season,
            episode: matchContext.episode,
            resetPassedFilter: true,
            // Fora do caminho da resposta: o desperdício medido é trabalho de
            // fundo da caça pt-BR, não custo do orçamento crítico.
            background: true,
          });
          metrics.count('search.pt-sweep.found', found.length);
          if (!found.length) return;
          const known = new Set(
            raw.items.map((item) => extractInfoHash(item.infoHash || item.magnet)).filter(Boolean),
          );
          // TRÊS desfechos, não dois. Item de indexer fora de
          // `resolveDownloadIndexers` chega com `infoHash: null` e `magnet`
          // igual à URL da PÁGINA — `extractInfoHash` não tira hash de http,
          // então ele saía silenciosamente pelo mesmo balde de "já conhecido".
          // Medido no tt0415167: os dois dublados de 288 e 580 seeds vinham
          // assim, e o log dizia "nenhum novo" — indistinguível de "não achei
          // nada", que é justamente o diagnóstico oposto do que fazer.
          const semHash: any[] = [];
          const fresh = found.filter((item: any) => {
            const h = extractInfoHash(item.infoHash || item.magnet);
            if (!h) { semHash.push(item); return false; }
            return !known.has(h);
          });
          if (semHash.length) {
            // Estar FORA da lista de resolução é só uma das causas: indexer
            // dentro dela também devolve item sem magnet quando estoura
            // `maxDownloadResolves`, o orçamento ou o protetor de link. Mandar
            // conferir o .env nesse caso aponta para a coisa que já está certa.
            const indexers = [...new Set(semHash.map((i) => String(i.indexer || '')).filter(Boolean))];
            const foraDaLista = indexers.filter((idx) => !config.jackett.resolveDownloadIndexers.includes(idx));
            const naLista = indexers.filter((idx) => config.jackett.resolveDownloadIndexers.includes(idx));
            metrics.count('search.pt-sweep.sem-hash', semHash.length);
            const dicas = [
              foraDaLista.length ? `fora de JACKETT_RESOLVE_DOWNLOAD_INDEXERS: ${foraDaLista.join(', ')}` : '',
              naLista.length ? `resolução falhou/estourou limite ou orçamento: ${naLista.join(', ')}` : '',
            ].filter(Boolean);
            log.warn(
              `[search] varredura pt-BR: ${semHash.length} resultado(s) sem infoHash resolvível` +
                (dicas.length ? ` (${dicas.join('; ')})` : ''),
            );
          }
          if (!fresh.length) {
            // Achou, mas nada entra. `known` fica só para "achou e já
            // tínhamos": tudo sem hash é o balde `sem-hash`, contado acima —
            // somar os dois de novo esconderia a causa na métrica.
            const comHash = found.length - semHash.length;
            if (comHash > 0) metrics.count('search.pt-sweep.known');
            log.info(
              `[search] varredura pt-BR: ${found.length} resultado(s), nenhum novo ` +
                `(${comHash} já conhecido(s), ${semHash.length} sem hash; query "${sweepQuery}")`,
            );
            return;
          }
          raw.items.push(...fresh);
          metrics.count('search.pt-sweep.hit');
          log.info(`[search] varredura pt-BR nos globais trouxe ${fresh.length} resultado(s) novo(s) (query "${sweepQuery}"); recacheando`);
          // Etapa 4: usa o estado da COLETA (raw.live) — a varredura é
          // `recordStatus:false` e por contrato NÃO alimenta o estado vivo
          // (falha dela não pode pintar um indexer que a busca principal viu de
          // pé), então não há "live próprio" para mesclar aqui. Na via
          // instantânea, `raw.live` já é o live MESCLADO do tail (setado antes
          // deste task pela fila serial): é o que reinjeta a reserva 📦.
          await finish({ items: raw.items, partial: false, live: raw.live }, responsePhase);
        } catch (err) {
          log.warn('[search] varredura pt-BR nos globais falhou:', err?.message || err);
        } finally {
          metrics.observe('search.pt-sweep', Date.now() - sweepStarted);
        }
      });
    } else {
      log.debug('[search] varredura pt-BR não executada: nenhum indexer global elegível (só BR/index-only)');
    }
  } else if (config.jackett.ptSweepGlobal && wantsJackettSweep && !sweepQuery) {
    log.debug('[search] varredura pt-BR não executada: não há query localizada ativa');
  } else if (config.jackett.ptSweepGlobal && wantsJackettSweep && sweepSelectedIndexers.length === 0) {
    log.debug('[search] varredura pt-BR não executada: nenhum indexer selecionado');
  }
}
