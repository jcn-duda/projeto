// Evicção dirigida dos FALLBACKS da mesma obra — executor AllDebrid (Fase 6 do
// Chupim 2.0).
//
// Irmão de `alldebrid-evict.ts` (evicção por busca, Fase 8.16), com outro
// gatilho e outra seleção: aqui não há piso de ocupação nem veredito de idioma
// — quem escolhe os hashes é a política do provider (autofetch-evict.ts), que
// já provou obra, pool, posse, idade e proteções. Este módulo é a ÚLTIMA
// milha destrutiva, com as travas que só o serviço conhece:
//
//   - leitura AUTORITATIVA do `/magnet/status`: sem hash na conta, sem `id` ou
//     sem `filename`, o hash é PULADO (ausência nunca autoriza remoção);
//   - `brOriginMark(filename)`: nome com sinal BR (site BR, "filmes", acentos
//     PT) NUNCA sai — mesma blindagem destrutiva do sweepUndubbed;
//   - o delete passa pelo gate GLOBAL `deleteMagnets` (fila serializada por
//     conta + retry de 503). É PROIBIDO chamar `removeTorrent` aqui;
//   - só o que saiu de verdade (`removedIds`) recebe `adrm` (anti-reenchimento,
//     com o filename REAL) e tem a posse `adsub` purgada. Falha/503 não marca
//     nem purga — o magnet continua na conta e continua sendo nosso.
//
// O retorno carrega o motivo de cada pulo para o provider contar
// `autofetch.evict.skipped.<motivo>`.

import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import { brOriginMark } from '../utils/br-origin.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import { magnetList, type AllDebridMagnetRow } from './alldebrid-api.js';
import { deleteMagnets } from './alldebrid-cleanup.js';
import { markReuploadBlocked } from './alldebrid-reupload.js';
import { forgetSubmitted, submittedAt } from './alldebrid-inventory.js';

export interface EvictFallbackResult {
  removed: Array<{ hash: string; filename: string }>;
  skipped: Array<{ hash: string; reason: string }>;
}

type DeleteSeam = { waitFn?: (ms: number) => Promise<unknown>; delays?: number[] };

/**
 * Remove da conta os hashes pedidos, um a um, com prova autoritativa. Nunca
 * lança: falha de status vira `status-error` (nada é apagado) e falha de delete
 * vira `delete-failed` (a prova NÃO é purgada).
 */
export async function evictFallbacks(
  apiKey: string,
  hashes: string[],
  opts: DeleteSeam = {},
): Promise<EvictFallbackResult> {
  const account = accountScope(apiKey);
  const result: EvictFallbackResult = { removed: [], skipped: [] };
  const wanted = new Set<string>();
  for (const raw of hashes || []) {
    const h = String(raw || '').toLowerCase();
    if (h) wanted.add(h);
  }
  if (!wanted.size) return result;

  let list: AllDebridMagnetRow[] = [];
  try {
    // `magnetList` normaliza `uploadDate` de segundos para ms (o anti-re-add
    // compara com `submittedAt`, que é ms) e o hash em minúsculo.
    list = await magnetList(apiKey);
  } catch (err) {
    metrics.count('debrid.evictFallback.statusFailed');
    log.warn('[debrid] evict de fallback: leitura do status da conta falhou:', log.errorMessage(err));
    for (const h of wanted) result.skipped.push({ hash: h, reason: 'status-error' });
    return result;
  }

  const byHash = new Map<string, AllDebridMagnetRow>();
  for (const m of list) {
    const h = String(m.hash || '').toLowerCase();
    if (h && wanted.has(h)) byHash.set(h, m);
  }

  const alvo: Array<{ hash: string; id: string | number; filename: string }> = [];
  for (const h of wanted) {
    const m = byHash.get(h);
    if (!m) {
      result.skipped.push({ hash: h, reason: 'not-in-account' });
      continue;
    }
    // `magnetList` já descarta id null/undefined (essas viram `not-in-account`);
    // id vazio/0 ainda chega aqui e fecha — a âncora do delete tem que ser real.
    if (m.id == null || m.id === '') {
      result.skipped.push({ hash: h, reason: 'no-id' });
      continue;
    }
    const filename = String(m.filename || '').trim();
    if (!filename) {
      result.skipped.push({ hash: h, reason: 'no-filename' });
      continue;
    }
    // Blindagem destrutiva: nome com origem BR NÃO é fallback gringo. Errar
    // absolvendo é o lado certo (o pior caso é o lixo ser re-subido).
    if (brOriginMark(filename)) {
      result.skipped.push({ hash: h, reason: 'br-name' });
      continue;
    }
    // Anti-re-add (mesma regra/margem do alldebrid-reconcile): sem `uploadDate`
    // legível não há prova de que é o MESMO magnet que etiquetamos — ausência
    // nunca autoriza. Upload POSTERIOR à etiqueta `adsub` + margem é re-add do
    // usuário: o acervo mudou de dono, NUNCA remove.
    if (!(m.uploadDate > 0)) {
      result.skipped.push({ hash: h, reason: 'no-upload-date' });
      continue;
    }
    const posse = submittedAt(account, h);
    if (posse === null) {
      result.skipped.push({ hash: h, reason: 'no-ownership' });
      continue;
    }
    if (m.uploadDate > posse + config.debrid.reconcileAgeMarginMs) {
      result.skipped.push({ hash: h, reason: 'readded' });
      continue;
    }
    alvo.push({ hash: h, id: m.id, filename });
  }
  if (!alvo.length) return result;

  // Gate ÚNICO de delete da conta (serialização + retry de 503 + removedIds).
  const { removedIds } = await deleteMagnets(apiKey, alvo.map((t) => t.id), opts);
  const saiu = new Set((removedIds || []).map((id) => String(id)));
  for (const t of alvo) {
    if (!saiu.has(String(t.id))) {
      result.skipped.push({ hash: t.hash, reason: 'delete-failed' });
      continue;
    }
    // Anti-reenchimento com o filename REAL (nunca o título do post) e purga
    // da posse: o magnet saiu por limpeza NOSSA, não é mais acervo nosso.
    markReuploadBlocked(account, t.hash, t.filename, apiKey);
    forgetSubmitted(account, t.hash);
    result.removed.push({ hash: t.hash, filename: t.filename });
  }
  return result;
}
