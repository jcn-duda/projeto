const config = require('../config');
const debrid = require('../debrid');
const { filterInventoryRelevant, looksPtBr } = require('../utils/format');
const { raceWithDeadline } = require('../utils/deadline');
const metrics = require('../utils/metrics');
const log = require('../utils/logger');

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
async function search(matchContext) {
  if (!matchContext?.names?.length) return [];
  try {
    const items = await raceWithDeadline(
      debrid.inventory(),
      config.debrid.inventoryTimeoutMs,
      () => [],
    );
    const raw = items.map((item) => ({
      ...item,
      // Origem BR pelo título: garante que itens em português passem por
      // `matchesBrTitle` (invariante 5) durante o `filterInventoryRelevant`,
      // em vez de usarem o caminho mais permissivo de trackers globais.
      isBr: looksPtBr(item.title),
    }));
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
      isBr: item.isBr,
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

module.exports = { search };
