// `enrichInstantWithoutCacheCheck`: complemento de ⚡ do autofetch (lote
// nativo) para adaptador sem `cacheCheck`. Saiu de `src/providers/`: a produção
// não o chama desde o corte do Chupim (B4); só o oráculo congelado o mede. As
// demais etapas do corte (`countFirstBr`, `pruneKnownBroken`) estão em
// `debrid-cache-steps.ts`, aqui ao lado.
import config from '../../../src/config.js';
import type { DebridAdapter, Stream } from '../../../types/domain.js';
import debrid from '../../../src/debrid/index.js';
import { peekDavail } from '../../../src/debrid/cache-check.js';
import { reuploadBlocked } from '../../../src/debrid/alldebrid-reupload.js';
import { accountScope } from '../../../src/utils/request-key.js';
import { magnetState } from '../../../src/utils/debrid-state-native.js';
import * as rdLedger from '../../../src/debrid/rd-ledger.js';
import * as autofetch from '../../../src/providers/autofetch.js';
import * as log from '../../../src/utils/logger.js';
import * as metrics from '../../../src/utils/metrics.js';
import { assertSafeTestDb } from '../db-guard.js';

// Lê `magnetdb`/ledger/KV: sem setup-env o destino seria o banco real.
assertSafeTestDb('pipeline-oracle/debrid-instant-steps');

// Leitura LOCAL do banco de magnets: o oráculo chama a PONTE nativa
// (`magnetState()`) direto, com a MESMA guarda da régua que estava em
// `src/utils/magnetdb.ts` (o módulo vivo conservou só leitura/reparo do
// painel — a escrita de produção é do gateway e do play_effects nativo).
function isAlive(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && adapterId && apiKey && hash
    ? magnetState().state(adapterId, apiKey, hash, Date.now()) === 'alive'
    : false;
}

/** Resultado da complementação de ⚡ para adaptador sem `cacheCheck`. */
export type InstantEnrichment = {
  /** Conjunto que o autofetch enxerga (inventário quando ele responde). */
  cachedForAutofetch: Set<string>;
  /** `known` do chamador, salvo quando o inventário responde (aí é true). */
  knownForAutofetch: boolean;
  /** Retrato COMPLETO da conta obtido — é o que autoriza o corte cachedOnly. */
  accountKnown: boolean;
};

/**
 * Complementa o conjunto `cached` (cujo dono continua sendo o applyDebrid —
 * aqui só se ACRESCENTAM hits gratuitos) com duas fontes que só valem para
 * adaptador SEM `cacheCheck` (Real-Debrid / Debrid-Link): o inventário pronto
 * da conta e o histórico durável de play desta credencial.
 *
 * Apesar do nome, a função é também o ponto de gancho do atalho do histórico
 * em adaptador COM `cacheCheck` quando a checagem DEGRADA
 * (`DEBRID_ALIVE_AS_CACHE`): o núcleo do pipeline chama este passo para todo
 * adaptador, então a sobra da checagem mora aqui sem tocar o `debrid-pipeline-core.ts`.
 */
export function enrichInstantWithoutCacheCheck(
  adapter: DebridAdapter,
  streams: Stream[],
  cached: Set<string>,
  known: boolean,
  apiKey: string,
): InstantEnrichment {
  // Dedupe por inventário para adaptadores sem cacheCheck (Real-Debrid / Debrid-Link)
  let cachedForAutofetch: Set<string> = cached;
  let knownForAutofetch = known;
  // O inventario da conta respondeu? So com ele em maos o corte do cachedOnly
  // pode rodar num adaptador sem cacheCheck — com memo frio o conjunto vem
  // vazio e o corte apagaria a lista inteira.
  let accountKnown = false;
  if (!adapter.cacheCheck && adapter.autofetchSource) {
    const peek = debrid.inventoryPeek(adapter, apiKey);
    if (peek) {
      const inv = new Set(peek.map((i) => String(i.infoHash || '').toLowerCase()));
      knownForAutofetch = true;
      // O que ja esta PRONTO na conta toca na hora — isso e ⚡ de verdade, e o
      // unico que sobrou desde que o Real-Debrid aposentou o
      // /torrents/instantAvailability. Sem isto o inventario so alimentava o
      // autofetch e a lista inteira saia [RD Download] mesmo com o arquivo
      // baixado. `known` fica como esta de proposito: a conta nao responde pelo
      // cache GLOBAL do servico, entao o corte do cachedOnly continua sem base
      // para descartar o resto.
      let fromInventory = 0;
      for (const hash of inv) {
        if (cached.has(hash)) continue;
        cached.add(hash);
        fromInventory += 1;
      }
      if (fromInventory) metrics.count('debrid.instant.fromInventory', fromInventory);
      // Inventário pronto é uma observação gratuita do CDN do RD. O magnetdb
      // continua por conta; o ledger é global porque o cache é do serviço.
      if (adapter.id === 'realdebrid') rdLedger.noteHit([...inv]);
      accountKnown = true;
      return { cachedForAutofetch: inv, knownForAutofetch, accountKnown };
    }
    knownForAutofetch = false;
    debrid.inventory().catch((err: unknown) =>
      log.warn(`[${adapter.id}] aquecimento de inventário em fundo falhou:`, log.errorMessage(err)),
    );
  }

  // Historico duravel desta conta: hash que JA tocou pelo /resolve volta com ⚡.
  // O markAlive grava no play bem-sucedido (TTL de 7 dias) e o `bad`/`lie`, mais
  // recentes e mais especificos, vencem sobre ele no filtro la de cima — o que
  // provou quebrar ja saiu da lista antes de chegar aqui.
  //
  // So para adaptador SEM cacheCheck: onde a checagem de cache funciona de
  // verdade (AllDebrid) ela e a autoridade, e sobrepor com memoria antiga criaria
  // ⚡ falso justamente onde existe resposta melhor. Isto tambem NAO liga
  // `accountKnown`: e conhecimento pontual, nao um retrato completo da conta,
  // entao nao pode autorizar o corte do cachedOnly a descartar o resto.
  if (!adapter.cacheCheck && apiKey) {
    let doHistorico = 0;
    const aliveHashes: string[] = [];
    for (const s of streams) {
      const hash = String(s.infoHash || '').toLowerCase();
      if (!hash || cached.has(hash)) continue;
      if (isAlive(adapter.id, apiKey, hash)) {
        cached.add(hash);
        doHistorico += 1;
        aliveHashes.push(hash);
      }
    }
    if (adapter.id === 'realdebrid') rdLedger.noteHit(aliveHashes);
    if (doHistorico) {
      metrics.count('debrid.instant.fromHistory', doHistorico);
      log.info(`[debrid] ${doHistorico} stream(s) com ⚡ pelo histórico de play desta conta`);
    }
  }

  // DEBRID_ALIVE_AS_CACHE — sobra da checagem em adaptador COM cacheCheck
  // (AllDebrid na prática): a resposta do serviço é a autoridade e vale sobre
  // a memória; o que se faz aqui é completar, APENAS quando ela degrada
  // (`known:false` — prazo, lote perdido, hash omitido), os hashes que o
  // banco de magnets provou vivos (play desta conta, TTL 7d) e nenhum davail 0
  // fresco contradiz. Guardas do desenho, todas obrigatórias:
  //   - bad/lie venceram antes (pruneKnownBroken cortou na entrada) e markBad
  //     apaga o alive do mesmo hash — histórico ruim não ressuscita aqui;
  //   - peekDavail 0 fresco VETA: o play acabou de provar o hash frio;
  //   - accountKnown segue false — memória com TTL não é retrato da conta e
  //     não pode autorizar o corte do cachedOnly a descartar o resto;
  //   - o snapshot para o autofetch é capturado ANTES da inflação: ⚡ pintado
  //     por histórico não pode convencer o chupim de que o download já está
  //     pronto (ele decide com a evidência medida, que degradou);
  //   - nada é escrito (davail, magnetdb, ledger): falso positivo do atalho
  //     morre no TTL do alive, não se consolida; um play que se apoiar nele e
  //     voltar não-ready grava o negativo de 120s pelo noteUnavailable.
  if (adapter.cacheCheck && apiKey && config.debrid.aliveAsCache && !known) {
    cachedForAutofetch = new Set(cached);
    const account = accountScope(apiKey);
    let doHistorico = 0;
    for (const s of streams) {
      const hash = String(s.infoHash || '').toLowerCase();
      if (!hash || cached.has(hash)) continue;
      // O negativo só VETA quando negativos estão ligados (availNegTtl > 0):
      // 0 desliga a leitura/escrita negativa por contrato, então um 0 na chave
      // não é evidência — é lixo que o próprio sistema deixaria de escrever.
      const negativoFresco = config.debrid.availNegTtl > 0 && peekDavail(adapter.id, apiKey, hash) === 0;
      // 8.14 — hash marcado "não re-subir" não ganha ⚡ do atalho: o registro
      // diz que a limpeza INTENCIONAL o apagou, e pintá-lo de tocável ofereceria
      // um play que o serviço não tem (o enqueue dele já é recusado). Para
      // adaptador não-AD não há registro — a guarda é um peek síncrono, sem rede.
      if (reuploadBlocked(account, hash)) continue;
      if (isAlive(adapter.id, apiKey, hash) && !negativoFresco) {
        cached.add(hash);
        doHistorico += 1;
      }
    }
    if (doHistorico) {
      // Métrica PRÓPRIA, distinta do `fromHistory` legado (RD/DL por play):
      // misturar as duas semânticas esconderia qual fonte pintou o ⚡.
      metrics.count('debrid.instant.fromAliveAsCache', doHistorico);
      log.info(`[debrid] ${doHistorico} stream(s) com ⚡ pelo histórico (checagem degradada, alive-as-cache)`);
    }
  }
  return { cachedForAutofetch, knownForAutofetch, accountKnown };
}
