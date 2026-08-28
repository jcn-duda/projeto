import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import { batched } from './common.js';
import * as held from './protected.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { call, id } from './alldebrid-api.js';
import { preexisting, knownBefore, waitInventory, rememberSubmitted } from './alldebrid-inventory.js';
import { skipCleanup, deleteMagnets as dropMagnets } from './alldebrid-cleanup.js';

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
  const account = accountScope(apiKey);
  const hadInventory = preexisting.has(account);
  // `knownBefore` já dispara o refresh quando o snapshot vence e devolve null
  // enquanto ele não chega: referência vencida nunca autoriza apagar nada.
  let preexistentes = config.debrid.dropReady ? knownBefore(apiKey, account) : null;
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

  const result = await batched(infoHashes, config.debrid.batchSize, async (batch: string[], ctx?: { timeoutMs?: number }) => {
    const data = await call(
      apiKey,
      '/magnet/upload',
      { 'magnets[]': batch },
      { timeout: ctx?.timeoutMs ?? config.debrid.cacheCheckTimeout },
    );
    const ready: string[] = [];
    for (const magnet of data?.magnets || []) {
      const hash = String(magnet.hash || '').toLowerCase();
      rememberSubmitted(account, hash);
      if (magnet.ready) {
        ready.push(hash);
        // Ready de hash com registro durável assenta a proteção (noteReady): o
        // ⚡ já existe no serviço. É renovação/confirmação — nunca destrava.
        held.noteReady(id, account, hash);
        // Só entra na limpeza o que o inventário garante não ser do usuário e
        // não está protegido — volátil NEM durável (BR retido no acervo).
        if (!skipReadyDrop && preexistentes && magnet.id && !preexistentes.has(hash) && !skipCleanup(account, hash)) {
          dropReady.push(magnet.id);
        }
      // Hash em download automático não entra na limpeza: ele está "não pronto"
      // justamente porque pedimos que baixasse. Antes de decidir, porém, o
      // registro durável é reconciliado com o estado real — pending que nunca
      // tocou no prazo do settle, ou acervo que deixou de ter ⚡, destravam na
      // hora (é o único reaper que a conta de um USUÁRIO vê, sem varredura
      // agendada própria).
      } else {
        held.reconcile(id, account, hash);
        if (magnet.id && !skipCleanup(account, hash)) dropDownload.push(magnet.id);
      }
    }
    return ready;
  }, { timeoutMs });

  const scheduleDrop = (ids: Array<string | number>, kind: 'prontos' | 'downloads') => {
    if (!ids.length) return;
    // Sem travar a busca: limpeza é efeito colateral, não resposta.
    // O resultado É lido — antes o allSettled engolia a rejeição, o log contava
    // TENTATIVA como remoção, e a conta crescia enquanto o addon afirmava estar
    // limpando. Ver dropMagnets: as falhas eram 503 por rajada.
    dropMagnets(apiKey, ids).then(({ ok, falhas }) => {
      metrics.count('debrid.dropped', ok);
      if (kind === 'downloads') metrics.count('debrid.dropped.download', ok);
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
  if (config.debrid.dropReady) scheduleDrop(dropReady, 'prontos');
  if (config.debrid.dropUncached) scheduleDrop(dropDownload, 'downloads');
  return result;
}
