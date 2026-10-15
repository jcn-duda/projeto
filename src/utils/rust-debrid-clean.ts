/**
 * Decisão "este hash pode sair da conta?" (`RUST_DEBRID_CLEAN`).
 *
 * O Node executa. Em shadow o Rust só compara. Em on, a recusa do Node
 * sempre vence: o Rust não autoriza um apagamento a mais. Inventário
 * ausente, hold e knownBefore continuam fechando o fail-safe.
 */
import config from '../config.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';

export type DeleteFacts = {
  inventoryLoaded: boolean;
  knownBefore: boolean;
  protected: boolean;
};

type CleanCore = {
  debridMayDelete?(inventoryLoaded: boolean, knownBefore: boolean, protectedHash: boolean): boolean;
};

type GetCore = () => CleanCore | null;
let getCore: GetCore | null = null;
let loggedDiffs = 0;
let loggedMissing = false;

function tsMayDelete(facts: DeleteFacts): boolean {
  return facts.inventoryLoaded && !facts.knownBefore && !facts.protected;
}

function shadowMayDelete(facts: DeleteFacts, ts: boolean): boolean {
  const mode = config.rustDebrid.clean;
  if (mode === 'off' || !getCore) return ts;
  const fn = getCore()?.debridMayDelete;
  if (typeof fn !== 'function') {
    if (!loggedMissing) {
      loggedMissing = true;
      log.info('[rust] núcleo sem debridMayDelete (binário antigo); sombra de limpeza desligada');
    }
    return ts;
  }
  metrics.count('rust.debrid.clean.calls');
  let rust: boolean;
  try {
    rust = fn(facts.inventoryLoaded, facts.knownBefore, facts.protected) === true;
  } catch (err) {
    metrics.count('rust.debrid.clean.error');
    log.debug('[rust] limpeza lançou:', log.errorMessage(err));
    return ts;
  }
  if (rust !== ts) {
    metrics.count('rust.debrid.clean.diff');
    if (loggedDiffs < config.rustCore.maxLoggedDiffs) {
      loggedDiffs += 1;
      log.warn(
        `[rust] limpeza divergiu: inventario=${facts.inventoryLoaded} knownBefore=${facts.knownBefore} `
        + `protegido=${facts.protected} ts=${ts} rust=${rust}`,
      );
    }
  }
  if (mode === 'shadow') return ts;
  // Recusa do Node vence. Rust não cria um apagamento.
  if (!ts) return false;
  return rust;
}

function mayDeleteHash(facts: DeleteFacts): boolean {
  return shadowMayDelete(facts, tsMayDelete(facts));
}

function installDebridCleanHook(get: GetCore) {
  getCore = get;
}

function resetDebridCleanHook() {
  getCore = null;
  loggedDiffs = 0;
  loggedMissing = false;
}

export { mayDeleteHash, installDebridCleanHook, resetDebridCleanHook };
export type { CleanCore };
