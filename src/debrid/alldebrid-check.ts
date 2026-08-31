import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import { batched } from './common.js';
import * as held from './protected.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { call, id } from './alldebrid-api.js';
import { preexisting, knownBefore, waitInventory, rememberSubmitted, forgetSubmitted } from './alldebrid-inventory.js';
import { skipCleanup, deleteMagnets as dropMagnets } from './alldebrid-cleanup.js';
import { filterReuploadBlocked } from './alldebrid-reupload.js';
import { scheduleEvict } from './alldebrid-evict.js';
import { scheduleReconcile } from './alldebrid-reconcile.js';

/**
 * O /magnet/instant foi removido, mas o próprio /magnet/upload responde
 * `ready` por magnet — é essa a checagem de cache da AllDebrid. Aceita lote.
 *
 * O que não está pronto é removido em seguida: sem isso cada consulta deixaria
 * um download rodando na conta (chegaram a 226 fantasmas antes disso existir).
 *
 * O que ESTÁ pronto também sai, e essa é a diferença que segura a conta: cada
 * busca sobe dezenas de hashes e os prontos ficavam para sempre — 2300 magnets
 * em quatro dias de uso, até bater o teto da AllDebrid e derrubar a checagem
 * inteira (aí o ⚡ some de TODOS os streams). Apagar é seguro porque o cache é
 * do serviço, não da conta: no play o upload traz de volta na hora. Ficam de
 * fora os do autofetch (`held`) e os que já eram do usuário (`knownBefore`).
 *
 * @param {string} apiKey
 * @param {string[]} infoHashes
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 */
export async function checkCached(apiKey: string, infoHashes: string[], { timeoutMs }: { timeoutMs?: number } = {}) {
  const dropReady: Array<string | number> = [];
  const dropDownload: Array<string | number> = [];
  // id → hash de cada lista de limpeza: o delete consome id, mas a purga da
  // posse (`forgetSubmitted`) precisa do hash que o id representa.
  const readyHashById = new Map<string, string>();
  const downloadHashById = new Map<string, string>();
  // 8.16 — hashes que ESTA busca realmente consultou: o ECO do /magnet/upload
  // é o que prova o que trafegou (lote que estourou o prazo não ecoa). Alimenta
  // o alvo da evicção, a exclusão do que a própria busca acabou de subir e o
  // reconcile.
  const consultados = new Set<string>();
  const account = accountScope(apiKey);
  const hadInventory = preexisting.has(account);
  // `knownBefore` já dispara o refresh quando o snapshot vence e devolve null
  // enquanto ele não chega: referência vencida nunca autoriza apagar nada.
  //
  // O snapshot é adquirido quando QUALQUER limpeza está ativa, não só o
  // dropReady: o dropDownload herdou o MESMO fail-safe (só remove com
  // referência em mãos) — desligar o dropReady não pode desligar a autoridade
  // do dropDownload, senão o guard novo suprimiria a limpeza inteira.
  let preexistentes = config.debrid.dropReady || config.debrid.dropUncached
    ? knownBefore(apiKey, account)
    : null;
  const loading = preexisting.get(account);
  if (!hadInventory && loading?.hashes === null) {
    // Não há proveniência na resposta idempotente do upload. Antes de subir o
    // primeiro lote desta conta, esperamos o inventário para não confundir um
    // magnet que já era do usuário com um que a busca acabou de criar. Mantém o
    // fail-safe: a primeira checagem ainda não remove prontos.
    //
    // Só o PRIMEIRO inventário é esperado. O refresh por TTL roda em fundo e
    // vale da próxima busca em diante: aguardá-lo aqui punia uma busca a cada
    // `ALLDEBRID_PREEXISTING_TTL_MS` com uma chamada de rede inteira dentro da
    // reserva do debrid — e, com o `/magnet/status` fora do ar, TODA busca,
    // porque a falha limpa o registro e a próxima passada tenta de novo.
    preexistentes = (await waitInventory(loading.promise, timeoutMs)) || null;
  }
  const skipReadyDrop = !hadInventory;

  // 8.14 — anti-reenchimento: hash que a limpeza INTENCIONAL apagou não volta
  // ao /magnet/upload (que é a própria checagem). O bloqueado fica FORA do Set
  // de cache — vazio conhecido é intencional, o hash foi apagado de propósito —
  // e nunca chega à resposta do upload, portanto não entra em dropReady/
  // dropDownload. Leitura é peek síncrono: zero rede adicional no prazo.
  const { send, blocked } = filterReuploadBlocked(account, infoHashes);
  if (blocked.length) {
    log.info(`[alldebrid] ${blocked.length} hash(es) bloqueado(s) para re-upload ficam fora da checagem`);
  }

  const result = await batched(send, config.debrid.batchSize, async (batch: string[], ctx?: { timeoutMs?: number }) => {
    const data = await call(
      apiKey,
      '/magnet/upload',
      { 'magnets[]': batch },
      { timeout: ctx?.timeoutMs ?? config.debrid.cacheCheckTimeout },
    );
    const ready: string[] = [];
    for (const magnet of data?.magnets || []) {
      const hash = String(magnet.hash || '').toLowerCase();
      if (hash) consultados.add(hash);
      rememberSubmitted(account, hash);
      if (magnet.ready) {
        ready.push(hash);
        // Ready de hash com registro durável assenta a proteção (noteReady): o
        // ⚡ já existe no serviço. É renovação/confirmação — nunca destrava.
        held.noteReady(id, account, hash);
        // Só entra na limpeza o que o inventário garante não ser do usuário e
        // não está protegido — volátil NEM durável (BR retido no acervo).
        if (config.debrid.dropReady && magnet.id && hash && !skipCleanup(account, hash)) {
          if (preexistentes !== null && preexistentes.has(hash)) {
            // Decisão, não supressão: é do usuário (prova do inventário).
          } else if (skipReadyDrop || preexistentes === null) {
            // Supressão por FALTA DE AUTORIDADE (primeira checagem do processo
            // ou inventário ausente): a rodada não pôde decidir nada. Conta à
            // parte para o diagnóstico não confundir com a proteção.
            metrics.count('debrid.drop.suppressedReady');
          } else {
            dropReady.push(magnet.id);
            readyHashById.set(String(magnet.id), hash);
          }
        }
      // Hash em download automático não entra na limpeza: ele está "não pronto"
      // justamente porque pedimos que baixasse. Antes de decidir, porém, o
      // registro durável é reconciliado com o estado real — pending que nunca
      // tocou no prazo do settle, ou acervo que deixou de ter ⚡, destravam na
      // hora (é o único reaper que a conta de um USUÁRIO vê, sem varredura
      // agendada própria).
      } else {
        held.reconcile(id, account, hash);
        // MESMO fail-safe do dropReady: só sai da conta o que o snapshot prova
        // não ser do usuário. `null` ⇒ nada sai — a ausência de referência
        // nunca autoriza remoção, em nenhuma das duas listas. Sem hash no
        // magnet, pula: sem ele não há nem prova de proveniência nem purga.
        if (magnet.id && hash && !skipCleanup(account, hash) && preexistentes && !preexistentes.has(hash)) {
          dropDownload.push(magnet.id);
          downloadHashById.set(String(magnet.id), hash);
        }
      }
    }
    return ready;
  }, { timeoutMs });

  const scheduleDrop = (ids: Array<string | number>, kind: 'prontos' | 'downloads', hashById: Map<string, string>) => {
    if (!ids.length) return;
    // Sem travar a busca: limpeza é efeito colateral, não resposta.
    // O resultado É lido — antes o allSettled engolia a rejeição, o log contava
    // TENTATIVA como remoção, e a conta crescia enquanto o addon afirmava estar
    // limpando. Ver dropMagnets: as falhas eram 503 por rajada.
    dropMagnets(apiKey, ids).then(({ ok, falhas, removedIds }) => {
      metrics.count('debrid.dropped', ok);
      if (kind === 'downloads') metrics.count('debrid.dropped.download', ok);
      // Purga da posse: o que saiu DE VERDADE da conta (removedIds) deixa de
      // ser "nosso". Falha de delete NÃO purga — o magnet continua lá e
      // continua sendo nosso.
      for (const rid of removedIds || []) {
        const hash = hashById.get(String(rid));
        if (hash) forgetSubmitted(account, hash);
      }
      if (falhas.length) {
        metrics.count('debrid.drop_failed', falhas.length);
        const motivo = falhas[0]?.message || String(falhas[0]);
        log.warn(
          `[alldebrid] ${ok}/${ids.length} magnet(s) ${kind} removido(s) da conta — ${falhas.length} falhou(ram): ${motivo}`,
        );
        return;
      }
      log.info(`[alldebrid] ${ok} magnet(s) ${kind} da checagem removido(s) da conta`);
    });
  };
  if (config.debrid.dropReady) scheduleDrop(dropReady, 'prontos', readyHashById);
  if (config.debrid.dropUncached) scheduleDrop(dropDownload, 'downloads', downloadHashById);
  // 8.16 — evicção por busca, irmã de dropReady/dropUncached: fire-and-forget
  // DEPOIS da checagem, zero await da seleção/rede no prazo da resposta. O
  // guard do knob mora aqui (custo zero quando OFF) e de novo dentro do módulo
  // (a função é pública); escopo B-2 e anti-reentrada são do módulo.
  if (config.debrid.evictPerSearch) scheduleEvict(apiKey, consultados);
  // Reconcile da posse (adsub × conta real), irmão do evictor e também
  // fire-and-forget DEPOIS dele: a checagem é o gatilho natural porque é ela
  // que deposita e que limpa. Os guards (knob, escopo B-2, intervalo mínimo,
  // anti-reentrada, dependência de drop ativo) moram todos no módulo — o
  // chamador paga só uma chamada síncrona.
  scheduleReconcile(apiKey, consultados);
  return result;
}
