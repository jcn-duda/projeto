/**
 * Corpos TS da AllDebrid (checagem de cache e play) para o oráculo de teste.
 *
 * Saíram de `src/debrid/alldebrid-check.ts` e `alldebrid-play.ts` porque a
 * produção não roda mais essa régua: `registry.ts::current()` sempre embrulha o
 * adaptador na ponte nativa (`rust-remote.ts`), que sobrepõe `checkCached` e
 * `resolveLink` pelo `adom-debrid` (8710). Esta cópia é a régua de paridade: os
 * testes de limpeza, autoridade e posse da AllDebrid exercitam aqui o mesmo
 * comportamento que o Rust precisa reproduzir. Os estados que este corpo lê
 * e grava (inventário, posse, adrm, referência de proveniência) continuam nos
 * módulos de `src/`, então o oráculo e a produção compartilham a MESMA memória
 * do processo quando um teste monta os dois lados.
 *
 * Não reintroduza este corpo em `src/`: o que a conta recebe em produção é o
 * veredito nativo. Mudou a regra da AllDebrid? Mude no `adom-debrid` e use esta
 * cópia só para conferir o contrato.
 */
import config from '../../../../src/config.js';
import { accountScope } from '../../../../src/utils/request-key.js';
import { batched, pickFile, wait } from '../../../../src/debrid/common.js';
import * as held from '../../../../src/debrid/protected.js';
import * as log from '../../../../src/utils/logger.js';
import * as metrics from '../../../../src/utils/metrics.js';
import { call, flattenFiles, id, magnetFiles } from '../../../../src/debrid/alldebrid-api.js';
import { recordFileSizes } from '../../../../src/debrid/file-sizes.js';
import { preexisting, knownBefore, waitInventory, rememberSubmitted, forgetSubmitted } from '../../../../src/debrid/alldebrid-inventory.js';
import { skipCleanup, deleteMagnets as dropMagnets } from '../../../../src/debrid/alldebrid-cleanup.js';
import { raceWithDeadline } from '../../../../src/utils/deadline.js';
import { filterReuploadBlocked, unblockIfInventoryReady } from '../../../../src/debrid/alldebrid-reupload.js';
import { mayDeleteHash } from '../../../../src/utils/rust-debrid-clean.js';
import { assertDubbedFiles, recordFileEvidence } from '../../../../src/debrid/audio-audit.js';
import type { PlayHint } from '../../../../types/domain.js';
import { assertSafeTestDb } from '../../db-guard.js';

// Grava davail e magnetdb pelos módulos que este corpo importa: sem setup-env o
// destino seria o banco real.
assertSafeTestDb('pipeline-oracle/debrid-bodies/alldebrid');

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
// Um /magnet/status por pack pronto, em grupos pequenos para não virar rajada
// contra o limite de requisições da AllDebrid. Falha de um pack não derruba os
// outros: sem a lista, a listagem cai na estimativa.
async function readPackFiles(apiKey: string, items: Array<{ magnetId: string | number; hash: string }>) {
  for (let i = 0; i < items.length; i += 3) {
    await Promise.allSettled(items.slice(i, i + 3).map(async ({ magnetId, hash }) => {
      recordFileSizes(hash, await magnetFiles(apiKey, magnetId));
    }));
  }
  metrics.count('debrid.packFiles.read', items.length);
}

export async function checkCached(
  apiKey: string,
  infoHashes: string[],
  { timeoutMs, fileHashes, fileWaitTimeoutMs }: { timeoutMs?: number; fileHashes?: string[]; fileWaitTimeoutMs?: number } = {},
) {
  const startedAt = Date.now();
  const wantFiles = new Set((fileHashes || []).map((hash) => String(hash).toLowerCase()));
  const filesToRead: Array<{ magnetId: string | number; hash: string }> = [];
  const dropReady: Array<string | number> = [];
  const dropDownload: Array<string | number> = [];
  // id → hash de cada lista de limpeza: o delete consome id, mas a purga da
  // posse (`forgetSubmitted`) precisa do hash que o id representa.
  const readyHashById = new Map<string, string>();
  const downloadHashById = new Map<string, string>();
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
  //
  // EXCEÇÃO decisiva: bloqueado que o memo dinv prova estar PRONTO na conta
  // NÃO vai ao upload, mas é destravado (adrm expurgado) e entra direto no Set
  // de cache/ready — o ⚡ é real e a razão da marca acabou. Bloqueado AUSENTE
  // do inventário continua fora de upload e de cache.
  const { send, blocked } = filterReuploadBlocked(account, infoHashes);
  const desbloqueados: string[] = [];
  for (const hash of blocked) {
    if (unblockIfInventoryReady(apiKey, account, hash)) desbloqueados.push(hash);
  }
  const aindaBloqueados = blocked.length - desbloqueados.length;
  if (aindaBloqueados) {
    log.info(`[alldebrid] ${aindaBloqueados} hash(es) bloqueado(s) para re-upload ficam fora da checagem`);
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
      rememberSubmitted(account, hash);
      if (magnet.ready) {
        ready.push(hash);
        // Ready de hash com registro durável assenta a proteção (noteReady): o
        // ⚡ já existe no serviço. É renovação/confirmação — nunca destrava.
        held.noteReady(id, account, hash);
        if (magnet.id && wantFiles.has(hash) && filesToRead.length < config.debrid.packFilesPerCheck) {
          filesToRead.push({ magnetId: magnet.id, hash });
        }
        // Só entra na limpeza o que o inventário garante não ser do usuário e
        // não está protegido — volátil NEM durável (BR retido no acervo).
        if (config.debrid.dropReady && magnet.id && hash && !skipCleanup(account, hash)) {
          if (preexistentes !== null && preexistentes.has(hash)) {
            mayDeleteHash({ inventoryLoaded: !skipReadyDrop, knownBefore: true, protected: false });
          } else if (skipReadyDrop || preexistentes === null) {
            mayDeleteHash({ inventoryLoaded: false, knownBefore: false, protected: false });
            // Supressão por FALTA DE AUTORIDADE (primeira checagem do processo
            // ou inventário ausente): a rodada não pôde decidir nada. Conta à
            // parte para o diagnóstico não confundir com a proteção.
            metrics.count('debrid.drop.suppressedReady');
          } else if (mayDeleteHash({ inventoryLoaded: true, knownBefore: false, protected: false })) {
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
        if (magnet.id && hash && mayDeleteHash({
          inventoryLoaded: preexistentes != null,
          knownBefore: preexistentes != null && preexistentes.has(hash),
          protected: skipCleanup(account, hash),
        })) {
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
  // A lista de arquivos precisa do `id` do magnet, que some quando a limpeza o
  // remove da conta. Ler antes e só então limpar não segura a resposta: a
  // limpeza já era fire-and-forget, ela só espera a leitura terminar.
  const scheduleCleanup = () => {
    if (config.debrid.dropReady) scheduleDrop(dropReady, 'prontos', readyHashById);
    if (config.debrid.dropUncached) scheduleDrop(dropDownload, 'downloads', downloadHashById);
  };
  // Cadeia ÚNICA leitura→limpeza: o `finally` acopla a limpeza ao FIM da
  // leitura (sucesso OU falha) e nenhuma promise derivada fica sem consumidor.
  // Não há mais nada agendado antes disto: evicção, reconcile e as varreduras
  // saíram do Node no corte (são NATIVAS, `al_sweeps`) — a higiene da checagem
  // (`dropReady`/`dropDownload`) é o que resta aqui.
  //
  // A leitura não é abortável (cancelar depois do upload perderia os ids). O
  // limite da ESPERA chega como `fileWaitTimeoutMs` — orçamento dinâmico da
  // resposta JÁ COM A MARGEM deduzida pelo nonAbortableCheck
  // (DEBRID_PACK_FILES_WAIT_MARGIN_MS): o timer da corrida externa começa antes
  // desta checagem, então esperar o orçamento cheio aqui viraria known:false
  // (⚡ perdido) só porque a leitura do pack foi lenta. NUNCA é o `timeoutMs`
  // de rede, que aqui fica `undefined` e devolve a cada chamada o teto próprio
  // do adaptador (upload e leitura seguem com os timeouts normais). Estourou o
  // orçamento, segue fail-open: o ⚡ já está no retorno e o fsz aquece para a
  // reanotação na próxima leitura. Passe sem orçamento usa o timeout completo
  // do adaptador como limite da espera.
  let espera: Promise<void | 'prazo'> | null = null;
  if (filesToRead.length > 0) {
    const read = readPackFiles(apiKey, filesToRead).finally(scheduleCleanup);
    const limite = fileWaitTimeoutMs ?? config.debrid.cacheCheckTimeout;
    const restante = Math.max(0, limite - (Date.now() - startedAt));
    if (restante > 0) {
      espera = raceWithDeadline(read, restante, () => 'prazo' as const);
    } else {
      // Sem orçamento: não esperamos, mas a cadeia fica CONSUMIDA (handler
      // anexado) para nunca haver rejeição unhandled; a limpeza segue no
      // `finally` da mesma cadeia e o resultado sai na volta.
      void read.catch(() => {});
      espera = Promise.resolve('prazo' as const);
    }
  } else {
    scheduleCleanup();
  }
  // Destravados pelo inventário entram no Set de cache SEM upload: o pronto é
  // prova da própria conta, e o eco do upload os teria omitido de propósito.
  for (const hash of desbloqueados) result.cached.add(hash);
  if (espera) {
    try {
      if ((await espera) === 'prazo') {
        metrics.count('debrid.packFiles.waitDeadline');
        log.info(`[alldebrid] leitura de arquivos de ${filesToRead.length} pack(s) segue em fundo; limpeza acoplada ao fim dela`);
      }
    } catch (err) {
      // Falha da leitura: a limpeza já correu no `finally` da MESMA cadeia e a
      // checagem nunca a derruba — o ⚡ já está no retorno.
      log.warn(`[alldebrid] leitura de arquivos de pack falhou: ${log.errorMessage(err)}`);
    }
  }
  return result;
}

/**
 * Anota o negativo medido pelo play (davail=0 pela janela do availNegTtl) para
 * o atalho do histórico (`DEBRID_ALIVE_AS_CACHE`) não pintar ⚡ no hash que o
 * play acabou de provar frio. Import dinâmico DE PROPÓSITO: um estático
 * criaria o ciclo alldebrid-play → cache-check → registry → alldebrid →
 * alldebrid-play, e o grafo dos irmãos alldebrid é sem ciclo por contrato
 * (ver cabeçalho de alldebrid.ts). Best-effort: falha de anotação nunca
 * derruba o play.
 */
async function annotateUnavailable(apiKey: string, infoHash: string) {
  try {
    const { noteUnavailable } = await import('../play/davail.js');
    noteUnavailable(id, apiKey, infoHash);
  } catch (err) {
    log.warn('[alldebrid] não consegui anotar davail=0 do play:', log.errorMessage(err));
  }
}

/**
 * @param {string} apiKey
 * @param {string} infoHash
 * @param {object} [options]
 * @param {?number} [options.season]
 * @param {?number} [options.episode]
 * @param {*} [options.work]
 */
export async function resolveLink(apiKey: string, infoHash: string, { season, episode, work, dubbed }: PlayHint = {}) {
  const account = accountScope(apiKey);
  const upload = await call(apiKey, '/magnet/upload', { 'magnets[]': infoHash });
  const magnet = (upload?.magnets || [])[0];
  if (!magnet?.id) return null;

  let status = await call(apiKey, '/magnet/status', { id: magnet.id });
  let info = status?.magnets;
  // A resposta às vezes vem como lista de um item só.
  if (Array.isArray(info)) info = info[0];

  // Em cache, vira "Ready" na hora. Se não, o torrent entraria em download e o
  // play ficaria travado — melhor devolver nada e deixar escolher outro.
  for (let attempt = 0; attempt < 3 && info && info.status !== 'Ready'; attempt += 1) {
    await wait(700);
    status = await call(apiKey, '/magnet/status', { id: magnet.id });
    info = Array.isArray(status?.magnets) ? status.magnets[0] : status?.magnets;
  }
  if (!info || info.status !== 'Ready') {
    log.warn(`[alldebrid] torrent não está em cache (status: ${info?.status})`);
    // Sem isso o magnet fica baixando na conta pra sempre: como a AllDebrid não
    // tem consulta de cache, TODO play que falha deixa um download fantasma
    // (foram 226 acumulados até este bug aparecer). O upload é idempotente,
    // então apagar não custa nada — se o usuário voltar, ele é reenviado.
    // Idem no play: se o usuário clicou num BR que está baixando por nossa
    // conta, apagar aqui jogaria fora o progresso.
    if (config.debrid.dropUncached && mayDeleteHash({
      // O magnet acabou de ser enviado por este play. Não é varredura do acervo:
      // knownBefore não se aplica, e o inventário não autoriza nem barra este id.
      inventoryLoaded: true,
      knownBefore: false,
      protected: skipCleanup(account, infoHash),
    })) {
      try {
        await call(apiKey, '/magnet/delete', { id: magnet.id });
      } catch (err) {
        log.warn('[alldebrid] não consegui remover o magnet:', err.message);
      }
      // MESMA GUARDA do delete: só onde o magnet saiu (ou sairia) da conta é
      // que "não está pronto" é evidência sobre o cache. Magnet protegido
      // (hold/adprot) continua na conta baixando — gravar 0 aqui esconderia o
      // ⚡ do download que o próprio autofetch está fazendo.
      await annotateUnavailable(apiKey, infoHash);
    }
    return null;
  }

  const files = flattenFiles(info.files);
  const file = pickFile(files, { season, episode, work });
  recordFileEvidence(infoHash, files);
  assertDubbedFiles(files, Boolean(dubbed));
  if (!file) return null;

  const unlocked = await call(apiKey, '/link/unlock', { link: file.link });
  return unlocked?.link || null;
}

export const bodies = { checkCached, resolveLink };
