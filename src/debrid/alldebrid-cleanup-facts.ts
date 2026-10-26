/**
 * Fatos da limpeza AllDebrid que só o processo Node conhece, enviados no corpo
 * do `POST /debrid/check` nativo (sidecar 8710).
 *
 * A limpeza segura do Rust (`adom-debrid::alldebrid_cleanup`) exige
 * `holdsComplete` + inventário para montar o plano; sem eles o plano nasce
 * suprimido (`holds_incomplete`/`inventory_missing`) e a conta volta a crescer
 * a cada busca. O hold do autofetch em voo e o snapshot `knownBefore` moram na
 * memória deste processo — o Rust não os enxerga. Este módulo é a ponte.
 *
 * Só é montado no caminho do adaptador Rust (`DEBRID_RUST_SERVICES=alldebrid`)
 * e com `DEBRID_AL_CLEANUP=on`; o caminho Node default nem chama a função, e o
 * modo de paridade **sem** limpeza não ganha a leitura de `/magnet/status` que
 * o inventário custa. Com a flag OFF o sidecar também ignora os campos
 * (read-only): quem decide apagar é sempre o Rust.
 *
 * `holdsComplete` é fail-closed (ver `heldHashesFor`): chave vazia, hash
 * ilegível ou falha na leitura durável ⇒ `false`, e o Rust não apaga nada
 * naquela rodada. A lista `heldHashes` é completa para o LOTE porque o hold
 * volátil deste processo é o único existente hoje (o `Holds` do Rust ainda não
 * tem chamador de produção) e é chaveado por conta+hash, sem coringa.
 *
 * O MESMO levantamento alimenta o feed do gateway in-process
 * (`POST /internal/debrid/holds`, ligado por `DEBRID_AL_HOLDS=on`), que leva
 * também `account` e `evaluated` — ver `alldebridHoldsFeedFacts`.
 */
import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import * as metrics from '../utils/metrics.js';
import { id } from './alldebrid-api.js';
import { heldHashesFor } from './protected.js';
import { inventoryFacts } from './alldebrid-inventory.js';

interface CleanupFacts {
  /** Snapshot `knownBefore` desta rodada saiu da memória do Node. */
  inventoryLoaded: boolean;
  /** Hashes que já eram da conta (sem a posse `adsub`/`submitted`). */
  knownBefore: string[];
  /** Hold volátil do autofetch + `adprot` durável, para os hashes do lote. */
  heldHashes: string[];
  /** Prova de que `heldHashes` cobre TODOS os holds vivos dos hashes do lote. */
  holdsComplete: boolean;
  dropReady: boolean;
  dropUncached: boolean;
}

/**
 * Fatos do feed in-process (`POST /internal/debrid/holds`), consumidos pelo
 * seam do `adom-search` com `DEBRID_AL_HOLDS=on`. Além do corpo do sidecar,
 * leva a IDENTIDADE da conta e a lista de hashes efetivamente avaliados: o Rust
 * confere as duas antes de aceitar `holdsComplete` (não confia no flag sozinho).
 */
export interface HoldsFeedFacts extends CleanupFacts {
  /** `accountScope(apiKey)` (`sha256` hex) — nunca a chave. */
  account: string;
  /** Hashes do lote avaliados por `isHeld || isDurablyProtected`. */
  evaluated: string[];
}

/**
 * Fatos para o corpo do check NATIVO; `null` quando não há o que mandar:
 * serviço que não os aceita (Premiumize/TorBox/RD/Debrid-Link) ou limpeza
 * nativa desligada (`DEBRID_AL_CLEANUP`, default OFF). É o ponto que o
 * `rust-remote` chama: a contagem de diagnóstico mora aqui para o adaptador
 * continuar sendo só transporte.
 */
export function alldebridCheckFacts(adapterId: string, apiKey: string, hashes: readonly string[]): CleanupFacts | null {
  if (adapterId !== id || !config.debridRust.alCleanup) return null;
  const facts = alldebridCleanupFacts(apiKey, hashes);
  metrics.count('rust.debrid.cleanup.facts');
  if (!facts.holdsComplete) metrics.count('rust.debrid.cleanup.holds_incomplete');
  return facts;
}

/**
 * Fatos do lote `hashes` (o MESMO conjunto que vai ao `/magnet/upload`).
 *
 * @param apiKey credencial da conta (nunca vai ao Rust por aqui; ele já a
 *   recebe no corpo do check).
 * @param hashes lote efetivamente consultado — só ele pode ser limpo.
 */
export function alldebridCleanupFacts(apiKey: string, hashes: readonly string[]): CleanupFacts {
  const facts = buildCleanupFacts(apiKey, hashes);
  // Campos explícitos: `account`/`evaluated` são do feed in-process e NÃO
  // entram no corpo do sidecar (contrato do `/debrid/check` inalterado).
  return {
    inventoryLoaded: facts.inventoryLoaded,
    knownBefore: facts.knownBefore,
    heldHashes: facts.heldHashes,
    holdsComplete: facts.holdsComplete,
    dropReady: facts.dropReady,
    dropUncached: facts.dropUncached,
  };
}

/**
 * Fatos completos do feed in-process. É a MESMA auditoria do corpo do sidecar
 * (`alldebridCleanupFacts`) + `account`/`evaluated`, para o gateway provar
 * cobertura e identidade antes de apagar.
 */
export function alldebridHoldsFeedFacts(apiKey: string, hashes: readonly string[]): HoldsFeedFacts {
  return buildCleanupFacts(apiKey, hashes);
}

function buildCleanupFacts(apiKey: string, hashes: readonly string[]): HoldsFeedFacts {
  const dropReady = config.debrid.dropReady;
  const dropUncached = config.debrid.dropUncached;
  // Chave vazia não identifica conta nem inventário: nenhum fato é provável.
  if (!apiKey) {
    return {
      account: '',
      inventoryLoaded: false,
      knownBefore: [],
      heldHashes: [],
      evaluated: [],
      holdsComplete: false,
      dropReady,
      dropUncached,
    };
  }
  const account = accountScope(apiKey);
  const inventory = inventoryFacts(apiKey, account);
  const holds = heldHashesFor(hashes, account, id);
  return {
    account,
    inventoryLoaded: inventory.loaded,
    knownBefore: inventory.hashes,
    heldHashes: holds.hashes,
    evaluated: holds.evaluated,
    holdsComplete: holds.complete,
    dropReady,
    dropUncached,
  };
}
