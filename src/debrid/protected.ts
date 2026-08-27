/**
 * Hashes que a limpeza automática NÃO pode apagar da conta do debrid.
 *
 * Existe por causa de uma colisão: o `dropUncached` remove da conta tudo que não
 * está em cache (senão cada busca deixa um download fantasma lá), e o download
 * automático da fonte BR dublada faz exatamente o oposto — coloca de propósito
 * um torrent que ainda não está pronto. Sem estas proteções, a busca seguinte
 * veria "não está em cache" e apagaria o download no meio.
 *
 * Duas camadas, com vidas diferentes e objetivos diferentes:
 *
 * - **`held` (volátil, em memória):** só o hash escolhido para baixar agora, por
 *   tempo limitado (TTL do autofetch, 6h). Expirado ou processo reiniciado, ele
 *   volta a ser candidato à limpeza normal. É o freio de curto alcance para a
 *   corrida da própria busca — existe para o `dropReady`/`dropUncached` não
 *   matarem um download que a conta acabou de aceitar.
 * - **`adprot` (durável, no cache persistente):** registro por
 *   adapter+accountScope+hash (`{ acceptedAt, readyAt }`) com TTL de 10 anos —
 *   é o que faz o acervo BR do usuário sobreviver a restart. Enquanto o hash
 *   continuar pronto na conta ele não sofre a limpeza; só o estado terminal
 *   (dead/stalled/expired) e o `DubLieError` o destravam.
 */
import config from '../config.js';
import { prefix } from '../utils/cache-keys.js';
import * as cache from '../utils/cache.js';
import * as metrics from '../utils/metrics.js';

const held = new Map();

// Único adapter que recebe proteção durável (o ponto 1 do contrato: só o pool
// BR dublado no AllDebrid). `any`/`seeds` e os demais serviços não passam.
const HELD_ADAPTER = 'alldebrid';
const adprotPrefix = prefix('adprot');

interface DurableProtection {
  acceptedAt: number;
  readyAt: number | null;
}

function sweep() {
  const now = Date.now();
  for (const [hash, expiresAt] of held) if (expiresAt <= now) held.delete(hash);
}

function key(hash: string, account = 'none') {
  return `${account}:${String(hash || '').toLowerCase()}`;
}

/** Protege o hash por `ttlSeconds`. Chamar de novo renova o prazo. */
function hold(hash: string, ttlSeconds: number, account = 'none') {
  if (!hash) return;
  sweep();
  held.set(key(hash, account), Date.now() + Math.max(1, Number(ttlSeconds) || 0) * 1000);
}

/** Libera o hash: volta a valer a limpeza normal. */
function release(hash: string, account = 'none') {
  held.delete(key(hash, account));
}

function isHeld(hash: string, account = 'none') {
  const heldKey = key(hash, account);
  const expiresAt = held.get(heldKey);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    held.delete(heldKey);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Proteção durável (`adprot:v1`) — registros persistidos no cache L1/L2. A
// leitura usa `cache.peek`, SEM promover LRU nem contar hit/miss: uma sonda de
// limpeza não pode reordenar o cache nem inflar os contadores do painel.
// ---------------------------------------------------------------------------

function dKey(adapterId: string, account: string, hash: string) {
  return `${adprotPrefix}${adapterId}:${account}:${String(hash || '').toLowerCase()}`;
}

function enabled(adapterId: string): boolean {
  return adapterId === HELD_ADAPTER && config.debrid.autoFetchProtectBr;
}

/**
 * Marca a proteção durável quando o autofetch aceita o hash (após o enqueue).
 * Só chega aqui quem já passou pelas guardas de adapter/pool/flag na chamada
 * (`any`/`seeds` nunca passam). Idempotente: registro de um aceite anterior não
 * perde o `acceptedAt` — re-submeter o mesmo hash não reinicia a janela do
 * `pruneMissing`.
 */
function protectBr(adapterId: string, account: string, hash: string) {
  const h = String(hash || '').toLowerCase();
  if (!enabled(adapterId) || !h) return;
  const k = dKey(adapterId, account, h);
  if (cache.peek(k)) return;
  cache.set(k, { acceptedAt: Date.now(), readyAt: null }, config.debrid.autoFetchProtectBrTtl);
  metrics.count('adprot.set');
}

/**
 * Registra que o hash ficou PRONTO na conta (`readyAt`), renovando o TTL. Só faz
 * efeito se houver registro durável — sem aceite não há o que confirmar. É o que
 * "assenta" a proteção: no acervo, o registro fica estável até um estado
 * terminal ou um `DubLieError` o remover. Chamada genérica (qualquer adapter);
 * é no-op fora do AllDebrid ou com o kill-switch desligado.
 */
function noteReady(adapterId: string, account: string, hash: string) {
  if (!enabled(adapterId)) return;
  const h = String(hash || '').toLowerCase();
  if (!h) return;
  const k = dKey(adapterId, account, h);
  const rec = cache.peek(k) as DurableProtection | null;
  if (!rec || typeof rec !== 'object') return;
  const ttl = config.debrid.autoFetchProtectBrTtl;
  const remaining = cache.peekRemaining(k);
  const wasReady = Number(rec.readyAt) > 0;
  // Ready aparece em toda checagem futura. Regravar só na transição ou quando
  // metade do TTL venceu evita uma escrita SQLite por busca sem deixar o acervo
  // expirar silenciosamente enquanto continua sendo usado.
  if (wasReady && remaining != null && remaining > ttl / 2) return;
  cache.set(
    k,
    { acceptedAt: Number(rec.acceptedAt) || Date.now(), readyAt: wasReady ? rec.readyAt : Date.now() },
    ttl,
  );
  metrics.count(wasReady ? 'adprot.renewed' : 'adprot.ready');
}

/**
 * Reconcilia o registro durável com o estado REAL do magnet na conta, na única
 * leitura que toda busca já faz. Duas quebras de premissa destravam a retenção:
 *
 * - `pending` mais velho que o horizonte do settle (`autoFetchTtl`): o próprio
 *   autofetch teria removido o torrent nesse prazo (settle expirado) — o
 *   registro sobreviveu só porque o processo reiniciou antes do lote em
 *   memória chegar lá. Destravar devolve o contrato pré-restart.
 * - `ready` que voltou a não-pronto: o acervo tocável (a única coisa que a
 *   retenção promete proteger) deixou de existir — a AllDebrid expira arquivos
 *   de magnets inativos. Segurar o registro negaria vaga sem entregar ⚡.
 *
 * Roda na conta de QUALQUER busca (a de uma instalação de usuário inclusive):
 * a varredura agendada (`sweepDead`) só existe para a conta do operador, então
 * este é o único reaper que a conta de um usuário vê.
 */
function reconcile(adapterId: string, account: string, hash: string) {
  if (!enabled(adapterId)) return;
  const h = String(hash || '').toLowerCase();
  if (!h) return;
  const k = dKey(adapterId, account, h);
  const rec = cache.peek(k) as DurableProtection | null;
  if (!rec || typeof rec !== 'object') return;
  if (Number(rec.readyAt) > 0) {
    cache.forget(k);
    metrics.count('adprot.regressed');
    return;
  }
  // Horizonte do settle pelo config estático: o live pode ser mais largo, mas o
  // registro não pode sobreviver MAIS que o contrato que o criou.
  const pendingMs = Date.now() - (Number(rec.acceptedAt) || 0);
  if (pendingMs >= config.debrid.autoFetchTtl * 1000) {
    cache.forget(k);
    metrics.count('adprot.pendingExpired');
  }
}

/** Remove o registro durável (estado terminal, dublado mentiroso, reset). Idempotente. */
function unprotect(adapterId: string, account: string, hash: string) {
  const h = String(hash || '').toLowerCase();
  if (!h) return;
  const k = dKey(adapterId, account, h);
  if (!cache.peek(k)) return;
  cache.forget(k);
  metrics.count('adprot.cleared');
}

/** Verdade se o hash tem registro durável vigente. Leitura limpa (peek). */
function isDurablyProtected(adapterId: string, account: string, hash: string): boolean {
  if (!enabled(adapterId)) return false;
  const h = String(hash || '').toLowerCase();
  if (!h) return false;
  return cache.peek(dKey(adapterId, account, h)) != null;
}

/**
 * Um hash está a salvo da limpeza se a proteção vier de um dos dois jeitos: o
 * hold VOLÁTIL (autofetch em voo) OU o registro DURÁVEL. É o que os pontos de
 * limpeza consultam, deixando claro que a versão persistida vale junto com o
 * freio transitório. Ordem dos parâmetros: (hash, account, adapterId).
 */
function isCleanupProtected(hash: string, account: string, adapterId: string): boolean {
  return isHeld(hash, account) || isDurablyProtected(adapterId, account, hash);
}

/**
 * Poda do acervo durável: remove registros de hashes que JÁ NÃO estão na conta
 * (por qualquer via). Só sai o que as três guardas aceitam:
 *   - NÃO consta em `presentHashes` (a conta não o tem mais);
 *   - não está em hold VOLÁTIL — um download aceito agora pode ainda não
 *     aparecer no `/magnet/status` do sweep, e podar cedo reabriria um BR
 *     recém-enfileirado à limpeza;
 *   - é mais velho que `graceMs` (contado do `acceptedAt`) — ou não tem data.
 * Idempotente e sem erro: varre só o namespace, lê com peek, apaga com forget.
 */
function pruneMissing(adapterId: string, account: string, presentHashes: Iterable<string>, graceMs: number) {
  if (!enabled(adapterId) || !account) return 0;
  const present = new Set<string>();
  for (const h of presentHashes || []) {
    if (h != null) present.add(String(h).toLowerCase());
  }
  const p = `${adprotPrefix}${adapterId}:${account}:`;
  let removed = 0;
  for (const k of cache.keysMatching(p)) {
    const hash = k.slice(p.length).toLowerCase();
    if (!hash || present.has(hash)) continue;
    if (isHeld(hash, account)) continue;
    const rec = cache.peek(k);
    if (!rec || typeof rec !== 'object') {
      // Registro já expirado/corrompido: não é acervo vivo, sobe direto.
      cache.forget(k);
      continue;
    }
    const acceptedMs = Number((rec as DurableProtection).acceptedAt);
    const ageMs = Date.now() - acceptedMs;
    if (graceMs > 0 && acceptedMs && ageMs <= graceMs) continue;
    cache.forget(k);
    metrics.count('adprot.pruned');
    removed += 1;
  }
  return removed;
}

export { hold, release, isHeld, protectBr, noteReady, unprotect, reconcile, isDurablyProtected, isCleanupProtected, pruneMissing };
