// `resolveLink` (o play) saiu daqui: o `/resolve` é nativo e o corpo TS mora no
// oráculo (`test/helpers/pipeline-oracle/debrid-bodies/alldebrid.ts`). Sobra o
// que o autofetch e o inventário ainda executam no Node: enfileirar, o status
// detalhado e a remoção por id.
import { accountScope } from '../utils/request-key.js';
import * as log from '../utils/logger.js';
import { call, isDeadMagnet, ACTIVE_STATES, type AllDebridMagnet } from './alldebrid-api.js';
import { rememberSubmitted, waitProvenanceReference } from './alldebrid-inventory.js';
import { reuploadBlocked, unblockIfInventoryReady } from './alldebrid-reupload.js';
import * as metrics from '../utils/metrics.js';
import type { TorrentStatusEntry } from '../../types/domain.js';

/**
 * O /magnet/upload já é o próprio "começa a baixar" da AllDebrid: o mesmo
 * endpoint que responde `ready` para o cache é o que enfileira o que não está.
 */
export async function enqueue(apiKey: string, infoHash: string) {
  const account = accountScope(apiKey);
  const hash = String(infoHash || '').toLowerCase();
  // 8.14 — o chupim não re-sobe o que a limpeza intencional apagou: enfileirar
  // hash bloqueado reabriria a ferida que o marcador fecha. O play explícito
  // (`resolveLink`, hoje nativo) NÃO é bloqueado de propósito — escolha do usuário vence.
  //
  // Exceção decisiva: bloqueado que o memo dinv prova PRONTO na conta não
  // precisa de upload nenhum — o ⚡ já existe. A marca é expurgada e o enqueue
  // devolve sucesso (o item está pronto no serviço), sem recusa e sem log de
  // recusa; métrica/log únicos no helper. Ausente do inventário segue recusa.
  if (reuploadBlocked(account, hash)) {
    if (unblockIfInventoryReady(apiKey, account, hash)) return true;
    metrics.count('debrid.reupload.blocked');
    log.info(`[alldebrid] enqueue de ${hash.slice(0, 8)}… recusado: hash bloqueado para re-upload`);
    return false;
  }
  // Antes de subir o magnet, AGUARDA (com teto) existir referência de
  // proveniência para a conta. O enqueue é background do autofetch — 1,5s
  // (o teto do debridCheckFloor) não custa resposta nenhuma — e sem a
  // referência o fail-safe do rememberSubmitted não etiquetaria o primeiro
  // download de conta fria, que viraria "preexistente" no snapshot seguinte
  // (a catraca do 8.15 pelo caminho do chupim). Nunca lança e nunca derruba
  // o enqueue: estourou o teto, segue sem referência.
  await waitProvenanceReference(account).catch(() => {});
  const data = await call(apiKey, '/magnet/upload', { 'magnets[]': infoHash });
  // MESMA proveniência estrita da checagem: snapshot contém o hash ⇒ magnet
  // do usuário reusado, não etiqueta; ausente ⇒ etiqueta (o upload criou);
  // sem referência NÃO etiqueta — fail-safe fecha no lado que protege.
  // Resíduo aceito: o download do chupim subido sem referência (inventário
  // frio que nem o teto resolveu) pode virar "preexistente" no snapshot
  // seguinte e escapar da limpeza por posse — o held do autofetch cobre o
  // download em curso e a polaridade errada aqui seria etiquetar acervo do
  // usuário por engano, que é a perda que o contrato não permite.
  if (data?.magnets?.length) rememberSubmitted(account, hash);
  return Boolean(data?.magnets?.length);
}

/**
 * Status detalhado de torrents na conta para o ciclo de recheck / detecção de mortos.
 *
 * `progress` sai dos campos REAIS medidos no `/magnet/status` (2026-09-15):
 * `downloaded` (bytes), `size` (total em bytes), `downloadSpeed` (bytes/s) e
 * `seeders`. Eles só existem em download ATIVO; magnet pronto ou terminal não
 * os traz, e aí `progress` fica ausente de propósito — ausência é "sem sinal",
 * não "parado". NÃO derivamos `stalled` aqui: a parada por progresso é
 * conservadora e mora no passo nativo do recheck (`recheck.rs`, que exige N
 * observações consecutivas) — o corpo TS `autofetch-progress` saiu na B4; o
 * `stalled` nativo dos outros serviços continua saindo do próprio adaptador.
 */
export async function torrentStatus(apiKey: string, _infoHashes?: string[]) {
  const data = await call(apiKey, '/magnet/status');
  const list: AllDebridMagnet[] = Array.isArray(data?.magnets) ? data.magnets : [];
  const out: Record<string, TorrentStatusEntry> = {};
  for (const magnet of list) {
    const hash = String(magnet.hash || '').toLowerCase();
    if (!hash) continue;
    let state: 'ready' | 'downloading' | 'dead' | 'unknown' = 'unknown';
    const statusStr = String(magnet.status || '');
    if (magnet.ready || /^ready$/i.test(statusStr)) {
      state = 'ready';
    } else if (isDeadMagnet(statusStr)) {
      state = 'dead';
    } else if (ACTIVE_STATES.test(statusStr)) {
      state = 'downloading';
    }
    // Progresso SÓ de download ATIVO e com os campos CRUS tipados como número
    // finito. `Number(null)`/`Number('')`/`Number(false)` viram 0 e fabricariam
    // uma parada inexistente — por isso o guard é `typeof === 'number'`, sem
    // coerção. `size` é sempre presente; `downloaded`/`downloadSpeed`/`seeders`
    // só existem em `status: "Downloading"` (medido 2026-09-15). `total > 0` e
    // `bytes < total`: completo/limítrofe não é progresso útil (o `ready` cuida).
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    const bytes = num(magnet.downloaded);
    const total = num(magnet.size);
    const speed = num(magnet.downloadSpeed);
    const seeders = num(magnet.seeders);
    const ativo = String(magnet.status || '') === 'Downloading';
    const progress = ativo && bytes !== undefined && total !== undefined
      && speed !== undefined && seeders !== undefined
      && total > 0 && bytes < total
      ? { bytes, total, speed, seeders }
      : undefined;
    // `via: 'hash'` DELIBERADO: o status sai da listagem autoritativa por hash
    // do `/magnet/status`, e o `id` já estava disponível nela. Marcar `via:id`
    // aqui prendia a remoção terminal ao gate `DEBRID_REMOVE_BY_ID` (default
    // false) SEM que a AllDebrid dependesse de id para o delete — resultado:
    // morto/expirado ficava na conta e o `sweepDead`/painel era a única saída.
    // Com `hash`, o recheck remove o terminal direto (o `id` continua sendo a
    // âncora do `removeTorrent`); o ramo progress-stalled NÃO usa este campo,
    // ele é sempre represado.
    out[hash] = {
      state,
      id: magnet.id,
      via: 'hash',
      ...(progress ? { progress } : {}),
    };
  }
  return out;
}

/**
 * Remove torrent específico pelo id na AllDebrid.
 */
export async function removeTorrent(apiKey: string, id: string | number) {
  try {
    await call(apiKey, '/magnet/delete', { id });
    return true;
  } catch (err) {
    log.warn(`[alldebrid] falha ao remover torrent ${id}:`, err?.message || err);
    return false;
  }
}
