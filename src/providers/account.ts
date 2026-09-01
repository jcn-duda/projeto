import config from '../config.js';
import debrid from '../debrid/index.js';
import { audioFromTitle, filterInventoryRelevant, hasExplicitForeignAudio, looksPtBr } from '../utils/format.js';
import { brOriginMark } from '../utils/br-origin.js';
import { raceWithDeadline } from '../utils/deadline.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';

/**
 * Origem BR FORTE (`brOriginMark`) como elegibilidade a VAGA RESERVADA — só no
 * caminho do inventário da conta (`fromAccount`). Caso Zombieland medido em
 * produção: "Zumbilândia 2009 [1080p] WWW.BLUDV.COM" e "Zumbilândia (2009)
 * Bluray 1080p Filmes M.H.G" estão Ready na conta AllDebrid, mas nenhum
 * declara Dublado/Dual/PT-BR — `looksPtBr` não marca, `isBr` fica false e com
 * q1=2 os 1080p globais de swarm alto (YTS/Kickass) tomam as vagas e os
 * candidatos da conta somem. A origem nomeada no título é a MESMA prova do
 * 8.4, que já protege estes títulos da limpeza (`audioBucket` balde `pt`);
 * aqui ela dá vaga reservada — e NUNCA `_dubbed`: origem brasileira não prova
 * áudio, `_dubbed` segue exigindo looksPtBr/explicitPtAudio (o `toStremioStream`
 * lê o flag `brOriginOnly` para manter o branch Dublado/Dual/Nacional fechado).
 *
 * Guardas em conjunção:
 * - `hasExplicitForeignAudio`: idioma estrangeiro declarado (FRENCH, RUS…)
 *   desmente a origem;
 * - `audioFromTitle === 'Legendado'`: LEGENDADA/LEG de site BR é conteúdo BR
 *   legendado — também não prova áudio dublado e não ocupa vaga de reserva.
 */
function origemBrSemProvaDeAudio(title: string, ptAudio: boolean): boolean {
  if (ptAudio) return false;
  if (hasExplicitForeignAudio(title)) return false;
  if (audioFromTitle(title) === 'Legendado') return false;
  return brOriginMark(title);
}

/**
 * A conta do debrid como fonte de busca: o que já está PRONTO na conta entra
 * como candidato com ⚡, sem depender de indexer nenhum. Caso medido: a
 * "FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS" (22 GB, Ready) nunca aparecia
 * porque nenhum tracker devolve o título — só a conta sabia dele.
 *
 * O corte por matchContext acontece AQUI, e não no buildStreams, para o lote
 * entrar já limpo: a conta real medida tem 1203 itens prontos e despejar
 * tudo no balde ocuparia o pool de candidatos com coisa de outra obra. O
 * casamento é o mesmo dos indexers mais a exceção de franquia
 * (`filterInventoryRelevant`).
 *
 * Teto curto próprio: a primeira leitura custa ~700ms (medido) e a resposta
 * não pode esperá-la — estourou, devolve [] e a próxima busca pega o
 * inventário do memo (aquecido no boot para a conta do operador).
 */
async function search(matchContext: any) {
  if (!matchContext?.names?.length) return [];
  try {
    const items = await raceWithDeadline(
      debrid.inventory(),
      config.debrid.inventoryTimeoutMs,
      () => [],
    );
    const raw = items.map((item: any) => {
      const title = String(item.title || '');
      // Origem BR pelo título: garante que itens em português passem por
      // `matchesBrTitle` (invariante 5) durante o `filterInventoryRelevant`,
      // em vez de usarem o caminho mais permissivo de trackers globais.
      // DE PROPÓSITO só `looksPtBr` aqui: rotear a origem-forte para
      // `matchesBrTitle` reprovaria "Zumbilândia 2009 [1080p] WWW.BLUDV.COM"
      // por precisão — o watermark BLUDV não está no vocabulário de ruído e
      // conta como conteúdo estranho (0.5 < 0.65). A marca nova
      // (`brOriginOnly`) existe para o corte final (`_br`), que roda DEPOIS
      // do filtro — por isso entra só no objeto devolvido, mais abaixo.
      const ptAudio = looksPtBr(title);
      return {
        ...item,
        isBr: ptAudio,
        brOriginOnly: origemBrSemProvaDeAudio(title, ptAudio),
      };
    });
    const relevant = filterInventoryRelevant(raw, matchContext);
    if (!relevant.length) return [];
    metrics.count('search.account.items', relevant.length);
    log.info(`[account] ${relevant.length} item(ns) pronto(s) na conta do debrid entraram como fonte`);
    return relevant.map((item) => ({
      title: item.title,
      infoHash: item.infoHash,
      // A conta não tem swarm: o torrent já está pronto. 1 é o valor neutro
      // das fontes BR — 0 morreria no filtro MIN_SEEDERS antes de virar stream.
      seeders: 1,
      size: item.size,
      tracker: debrid.current()?.label || 'debrid',
      indexer: 'debrid',
      // `_br` da origem-forte entra AQUI, depois do filtro que já rodou com o
      // `isBr` estreito (ver comentário no map de cima): dá vaga reservada
      // sem prometer áudio dublado — quem decide `_dubbed` é o
      // `toStremioStream`, lendo `brOriginOnly`.
      isBr: Boolean(item.isBr || item.brOriginOnly),
      brOriginOnly: Boolean(item.brOriginOnly),
      // Marca para o buildStreams: item de inventário já passou pelo filtro
      // DELE (estrito + exceção de franquia); o filtro estrito comum não pode
      // desfazer a exceção lá na frente.
      fromAccount: true,
    }));
  } catch (err) {
    log.warn('[account] inventário da conta falhou como fonte:', err?.message || err);
    return [];
  }
}

export { search };
