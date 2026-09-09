// Persistência dos contadores duráveis do banco de magnets (agregado O(1) em
// `mag_meta:v1:counts`) e o hook `cache.onForget` que os mantém sincronizados.
// Módulo separado do magnetdb.ts por um motivo só: aquele arquivo está no teto
// de 400 linhas. A API continua exposta por magnetdb.ts (save/load reexportados
// para addon e testes); nenhuma rota ou consumidor importa daqui diretamente.
//
// `ttlRemainingBasis` resolve uma ambiguidade do diagnóstico: a soma de TTL
// restante pode vir de dois lugares com precisão diferente. O rebuild do L1 lê
// o restante REAL de cada chave (peekRemaining), mas essa precisão morre na
// primeira mutação — renovação/remoção passam a subtrair o TTL nominal, não o
// restante exato de cada chave. O painel precisa saber qual dos dois está
// mostrando para não chamar de precisa uma média que envelhece.
import config from '../config.js';
import * as cache from './cache.js';
import { prefix, magMetaCountsKey } from './cache-keys.js';
import { emptyAdapterTotals, rebuildFromL1, type AdapterTotals, type MagSide } from './magnetdb-counts.js';

export type PersistentCountsPayload = { version: 1; updatedAt: number; adapters: Record<string, AdapterTotals> };

/**
 * Procedência da soma de TTL restante exposta no status:
 * - `l1-rebuild`: soma reconstruída do L1 com o restante real de cada chave
 *   (peekRemaining). Precisa no instante do rebuild; NÃO sobrevive a mutação.
 * - `aggregate-estimate`: estimativa incremental/restaurada — escrita soma o
 *   TTL nominal, esquecimento/restauração subtraem TTL nominal ou tempo
 *   decorrido. Conservadora, mas nunca afirmativa de precisão.
 */
export type TtlRemainingBasis = 'l1-rebuild' | 'aggregate-estimate';

export const adapterCounts = new Map<string, AdapterTotals>();

let ttlBasis: TtlRemainingBasis = 'aggregate-estimate';

export function ttlRemainingBasis(): TtlRemainingBasis {
  return ttlBasis;
}

/** Toda mutação degrada o rebuild para estimativa — o restante real já era. */
export function markMutation() {
  ttlBasis = 'aggregate-estimate';
}

export function getOrCreateAdapter(adapterId: string): AdapterTotals {
  let totals = adapterCounts.get(adapterId);
  if (!totals) {
    totals = emptyAdapterTotals();
    adapterCounts.set(adapterId, totals);
  }
  return totals;
}

let persistTimer: ReturnType<typeof setImmediate> | null = null;

export function savePersistentCounts() {
  if (persistTimer) { clearImmediate(persistTimer); persistTimer = null; }
  if (!config.magnetDb.enabled) return;
  const adapters: Record<string, AdapterTotals> = Object.create(null);
  for (const [id, totals] of adapterCounts) {
    if (totals.alive > 0 || totals.bad > 0 || totals.lie > 0) {
      adapters[id] = { alive: totals.alive, bad: totals.bad, lie: totals.lie, ttlRemainingSums: { ...totals.ttlRemainingSums } };
    }
  }
  const payload: PersistentCountsPayload = { version: 1, updatedAt: Date.now(), adapters };
  cache.set(magMetaCountsKey(), payload, Math.max(config.magnetDb.aliveTtl, 7 * 86400));
}

export function schedulePersistentSave() {
  if (persistTimer) return;
  persistTimer = setImmediate(() => { persistTimer = null; savePersistentCounts(); });
  persistTimer.unref?.();
}

/** Envelhece o agregado lido para um mapa de contadores, sem tocar o estado. */
function restoreFromAggregate(raw: PersistentCountsPayload): Map<string, AdapterTotals> {
  const out = new Map<string, AdapterTotals>();
  const now = Date.now();
  const elapsedSec = Math.max(0, Math.floor((now - (raw.updatedAt || now)) / 1000));
  for (const [id, totals] of Object.entries(raw.adapters)) {
    if (!totals) continue;
    const alive = Math.max(0, Number(totals.alive) || 0);
    const bad = Math.max(0, Number(totals.bad) || 0);
    const lie = Math.max(0, Number(totals.lie) || 0);
    const rawTtl = totals.ttlRemainingSums || { alive: 0, bad: 0, lie: 0 };
    if (alive > 0 || bad > 0 || lie > 0) {
      out.set(id, {
        alive, bad, lie,
        ttlRemainingSums: {
          alive: Math.max(0, (Number(rawTtl.alive) || 0) - elapsedSec * alive),
          bad: Math.max(0, (Number(rawTtl.bad) || 0) - elapsedSec * bad),
          lie: Math.max(0, (Number(rawTtl.lie) || 0) - elapsedSec * lie),
        },
      });
    }
  }
  return out;
}

const sumSides = (counts: Map<string, AdapterTotals>): number => {
  let total = 0;
  for (const t of counts.values()) total += t.alive + t.bad + t.lie;
  return total;
};

function adoptRebuild() {
  for (const [id, totals] of rebuildFromL1()) adapterCounts.set(id, totals);
  ttlBasis = 'l1-rebuild';
  if (adapterCounts.size > 0) schedulePersistentSave();
}

export function loadPersistentCounts() {
  const ns = cache.snapshot().namespaces as Record<string, { entries?: number }>;
  const l1Entries = ns?.mag?.entries || 0;
  if (l1Entries === 0) { adapterCounts.clear(); return; }
  const raw = cache.peek(magMetaCountsKey()) as PersistentCountsPayload | null;
  adapterCounts.clear();
  // Versão/estrutura estranha conta como agregado ausente: com o L1 cheio o
  // dado verdadeiro está nas chaves, não num payload que este processo não
  // sabe ler — cair no rebuild é mais honesto que restaurar lixo.
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !raw.adapters || typeof raw.adapters !== 'object' || Array.isArray(raw.adapters)) {
    // Agregado ausente/ilegível com o L1 cheio: reconta do próprio L1 e
    // regrava. Devolver zero aqui seria mentira rotulada de `duravel`. A soma
    // nasce precisa (restante real) e vira estimativa na primeira mutação.
    adoptRebuild();
    return;
  }
  // Agregado LEGÍVEL mas divergente do L1 é o caso que o rebuild-por-ilegível
  // não cobria: uma deriva antiga entra como verdade, é somada às mutações e
  // regravada, então sobrevive a todo rebuild do container e nunca se cura.
  // Medido em produção local: agregado dizia 77 alive com 190 chaves vivas no
  // namespace, e o adapter alldebrid sumia inteiro do painel — tudo rotulado
  // `duravel`, contradizendo o `l1Entries` mostrado ao lado na mesma tela.
  //
  // A comparação é exata de propósito: `entries` é a contagem física do
  // namespace mag e a soma dos lados conta a mesma coisa, então tolerância
  // aqui só serviria para deixar passar deriva pequena. O preço do desacordo é
  // uma passada O(namespace mag) por boot (29,6 ms medidos em 50 mil chaves,
  // a cota cheia), nunca no caminho de busca.
  const restored = restoreFromAggregate(raw);
  if (sumSides(restored) !== l1Entries) {
    adoptRebuild();
    return;
  }
  ttlBasis = 'aggregate-estimate';
  for (const [id, totals] of restored) adapterCounts.set(id, totals);
}

/**
 * Sincroniza a amostra com o L1 antes de o status ler `adapterCounts`:
 * L1 vazio zera a amostra (o banco de verdade esvaziou); amostra vazia com L1
 * cheio carrega o agregado persistido (ex.: primeiro status de testes/runner
 * sem passar pelo load do boot).
 */
export function ensureCountsLoaded(l1Entries: number) {
  if (l1Entries === 0) {
    adapterCounts.clear();
    // Sem registro algum não existe média reconstruída a qualificar: a próxima
    // gravação nasce estimativa, e um `l1-rebuild` órfão mentiria no painel.
    ttlBasis = 'aggregate-estimate';
  } else if (adapterCounts.size === 0) {
    loadPersistentCounts();
  }
}

// Hook único de decremento: o cache (TTL, despejo por cota, forget explícito)
// é quem tira registro do `mag` no dia a dia — sem isto os contadores só
// crescem. Mutações degradam a base para `aggregate-estimate`: depois do
// esquecimento, a soma já não reflete o restante real medido no rebuild.
cache.onForget((key: string) => {
  if (!key.startsWith(prefix('mag'))) return;
  const parts = key.split(':');
  const side = parts[2] as MagSide;
  const adapterId = parts[3];
  if (!side || !adapterId) return;
  const totals = adapterCounts.get(adapterId);
  if (!totals) return;
  if (side === 'alive') {
    totals.alive = Math.max(0, totals.alive - 1);
    totals.ttlRemainingSums.alive = Math.max(0, totals.ttlRemainingSums.alive - config.magnetDb.aliveTtl);
  } else if (side === 'bad') {
    totals.bad = Math.max(0, totals.bad - 1);
    totals.ttlRemainingSums.bad = Math.max(0, totals.ttlRemainingSums.bad - config.magnetDb.badTtl);
  } else if (side === 'lie') {
    totals.lie = Math.max(0, totals.lie - 1);
    totals.ttlRemainingSums.lie = Math.max(0, totals.ttlRemainingSums.lie - config.magnetDb.lieTtl);
  }
  markMutation();
  schedulePersistentSave();
});

// Restauração no boot: rodava no carregamento do magnetdb.ts antes do split e
// continua rodando uma vez, quando o módulo de persistência é carregado.
loadPersistentCounts();
