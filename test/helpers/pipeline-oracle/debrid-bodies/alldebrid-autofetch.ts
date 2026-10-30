/**
 * Corpos TS do lado de AUTOFETCH da AllDebrid (enfileirar, status e remoção) e
 * os auxiliares de inventário/reupload que só eles e o `checkCached` usam.
 *
 * Saíram de `src/debrid/alldebrid-play.ts`, `alldebrid-inventory.ts` e
 * `alldebrid-reupload.ts` porque, em produção, o worker nativo do Chupim é o
 * dono (`AUTOFETCH_WORKER=on`): o Node não chama mais `enqueue`,
 * `torrentStatus` nem `removeTorrent`. Esta cópia é a régua de paridade do
 * oráculo. O estado mutável (`preexisting`, `submitted`, `adrm`) continua em
 * `src/`, então o oráculo e a produção compartilham a MESMA memória do processo.
 *
 * Não reintroduza estes corpos em `src/`: a conta recebe o veredito nativo.
 */
import config from '../../../../src/config.js';
import { accountScope } from '../../../../src/utils/request-key.js';
import * as log from '../../../../src/utils/logger.js';
import * as metrics from '../../../../src/utils/metrics.js';
import { raceWithDeadline } from '../../../../src/utils/deadline.js';
import { call, isDeadMagnet, ACTIVE_STATES, id as adapterId, type AllDebridMagnet } from '../../../../src/debrid/alldebrid-api.js';
import { preexisting, knownBefore, rememberSubmitted } from '../../../../src/debrid/alldebrid-inventory.js';
import { reuploadBlocked, forgetReuploadBlock } from '../../../../src/debrid/alldebrid-reupload.js';
import { peek as inventoryMemoPeek } from '../../../../src/debrid/inventory-memo.js';
import type { TorrentStatusEntry } from '../../../../types/domain.js';
import { assertSafeTestDb } from '../../db-guard.js';

// Escreve a referência de proveniência e a marca adrm pelos módulos importados:
// sem setup-env o destino seria o banco real.
assertSafeTestDb('pipeline-oracle/debrid-bodies/alldebrid-autofetch');

/**
 * Espera EXISTIR referência de proveniência para a conta (snapshot corrente,
 * ou o anterior durante o refresh), com teto. Para o enqueue do autofetch:
 * ele é background e pode aguardar um instante a referência antes de decidir
 * a etiqueta. Nunca lança e nunca espera além do teto: vencido, devolve false.
 * O teto é o `debridCheckFloor`, não o prazo da resposta.
 */
export async function waitProvenanceReference(account: string, timeoutMs?: number): Promise<boolean> {
  const teto = Math.max(0, Math.min(timeoutMs ?? Number.POSITIVE_INFINITY, config.debridCheckFloor));
  const inicio = Date.now();
  for (;;) {
    const entry = preexisting.get(account);
    // Set VAZIO é referência válida (conta conhecida e vazia): o que importa
    // é EXISTIR prova, não ela ser grande.
    if (entry?.hashes ?? entry?.previous) return true;
    const restante = teto - (Date.now() - inicio);
    if (restante <= 0) return false;
    if (entry?.promise) {
      // O refresh em voo É a referência que queremos: espera-o pelo que resta do teto.
      await raceWithDeadline(entry.promise, restante, () => null);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, restante)));
  }
}

/**
 * Destrava o marcador quando o hash bloqueado reaparece PRONTO no memo do
 * inventário da conta (`dinv`, leitura síncrona, zero rede). Métrica e log
 * ficam aqui para que checagem e enqueue registrem uma vez por hash.
 */
export function unblockIfInventoryReady(apiKey: string, account: string, hash: string): boolean {
  const h = String(hash || '').toLowerCase();
  if (!h || !reuploadBlocked(account, h)) return false;
  const memo = inventoryMemoPeek(adapterId, apiKey);
  if (!Array.isArray(memo)) return false;
  const pronto = memo.some((item) => String(item?.infoHash || '').toLowerCase() === h);
  if (!pronto) return false;
  forgetReuploadBlock(account, h);
  metrics.count('debrid.reupload.unblockedByInventory');
  log.info(`[alldebrid] unblockedByInventory ${h.slice(0, 8)}… pronto no inventário da conta: marca adrm removida`);
  return true;
}

/**
 * Partição ANTES do /magnet/upload: só o não bloqueado vai à rede. Equivale ao
 * filtro de `alldebrid-reupload.ts` (que saiu de `src/`): o `reuploadBlocked`
 * já devolve false com kill-switch ou conta vazia, então o laço preserva a
 * ordem e os duplicados do chamador e só separa.
 */
export function filterReuploadBlocked(account: string, hashes: string[]): { send: string[]; blocked: string[] } {
  const send: string[] = [];
  const blocked: string[] = [];
  for (const hash of hashes || []) {
    if (reuploadBlocked(account, hash)) {
      blocked.push(String(hash).toLowerCase());
      metrics.count('debrid.reupload.blocked');
    } else {
      send.push(hash);
    }
  }
  return { send, blocked };
}

/**
 * Espera o inventário com teto (`debridCheckFloor`), sem deixá-lo mandar no
 * prazo da resposta. Vencido, devolve `null`: os prontos ficam protegidos.
 */
export function waitInventory(promise: Promise<Set<string> | null> | undefined, timeoutMs?: number) {
  if (!promise) return Promise.resolve(null);
  const teto = Math.max(0, Math.min(timeoutMs ?? Number.POSITIVE_INFINITY, config.debridCheckFloor));
  if (!teto) return Promise.resolve(null);
  return raceWithDeadline(promise, teto, () => {
    metrics.count('debrid.inventory.timeout');
    return null;
  });
}

/** Pré-carrega o inventário do operador antes de qualquer upload. */
export function warmInventory(apiKey: string) {
  if (!apiKey) return Promise.resolve(null);
  const account = accountScope(apiKey);
  knownBefore(apiKey, account);
  return preexisting.get(account)?.promise || Promise.resolve(null);
}

/**
 * Fatos do inventário para o corpo do check NATIVO: snapshot vigente vale;
 * vencido ou frio devolve `loaded:false` e dispara o refresh em fundo.
 */
export function inventoryFacts(apiKey: string, account: string): { loaded: boolean; hashes: string[] } {
  if (!apiKey) return { loaded: false, hashes: [] };
  const snapshot = knownBefore(apiKey, account);
  return snapshot
    ? { loaded: true, hashes: [...snapshot] }
    : { loaded: false, hashes: [] };
}

/**
 * Antes de subir o magnet, aguarda (com teto) a referência de proveniência da
 * conta. Sem ela o fail-safe do `rememberSubmitted` não etiquetaria o primeiro
 * download de conta fria. Nunca lança.
 */
export async function enqueue(apiKey: string, infoHash: string) {
  const account = accountScope(apiKey);
  const hash = String(infoHash || '').toLowerCase();
  // 8.14 — o chupim não re-sobe o que a limpeza intencional apagou. Exceção:
  // bloqueado que o memo dinv prova PRONTO não precisa de upload nenhum.
  if (reuploadBlocked(account, hash)) {
    if (unblockIfInventoryReady(apiKey, account, hash)) return true;
    metrics.count('debrid.reupload.blocked');
    log.info(`[alldebrid] enqueue de ${hash.slice(0, 8)}… recusado: hash bloqueado para re-upload`);
    return false;
  }
  // Teto de 1,5s (debridCheckFloor): a espera mora em background.
  await waitProvenanceReference(account).catch(() => {});
  const data = await call(apiKey, '/magnet/upload', { 'magnets[]': infoHash });
  // MESMA proveniência estrita da checagem: snapshot contém o hash ⇒ magnet
  // do usuário reusado, não etiqueta; ausente ⇒ etiqueta; sem referência não etiqueta.
  if (data?.magnets?.length) rememberSubmitted(account, hash);
  return Boolean(data?.magnets?.length);
}

/**
 * Status detalhado de torrents na conta para o ciclo de recheck / detecção de
 * mortos. `progress` só existe em download ATIVO com os campos crus numéricos.
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
    // `typeof === 'number'` sem coerção: `Number(null)` fabricaria parada inexistente.
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
    // `via: 'hash'` DELIBERADO: a remoção terminal não depende do gate por id.
    out[hash] = {
      state,
      id: magnet.id,
      via: 'hash',
      ...(progress ? { progress } : {}),
    };
  }
  return out;
}

/** Remove torrent específico pelo id na AllDebrid. */
export async function removeTorrent(apiKey: string, id: string | number) {
  try {
    await call(apiKey, '/magnet/delete', { id });
    return true;
  } catch (err) {
    log.warn(`[alldebrid] falha ao remover torrent ${id}:`, err?.message || err);
    return false;
  }
}

/** Corpos de autofetch que o `bodies` de `alldebrid.ts` mescla. */
export const autofetchBodies = { enqueue, torrentStatus, removeTorrent };
