// Persistência dos contadores duráveis do banco de magnets (agregado O(1) em
// `mag_meta:v1:counts`) e o hook `cache.onPrune` que os mantém sincronizados.
// Módulo separado do magnetdb.ts por um motivo só: aquele arquivo está no teto
// de 400 linhas. A API continua exposta por magnetdb.ts (save/load reexportados
// para addon e testes); nenhuma rota ou consumidor importa daqui diretamente.
//
// O dono das linhas `mag:v1` é o núcleo Rust: escrita e leitura vão pela ponte
// (`debrid-state-native.ts`), então nem a gravação nem a poda passam pelo cache
// do Node. O que sobra para cá é o AGREGADO — o único dado que este processo
// ainda é dono — e o decremento, que a varredura nativa devolve por lado.
//
// `ttlRemainingBasis` resolve uma ambiguidade do diagnóstico: a soma de TTL
// restante pode vir de dois lugares com precisão diferente. O rebuild pela
// ponte (`summary`) soma o restante REAL de cada linha, mas essa precisão morre
// na primeira mutação — renovação/remoção passam a subtrair o TTL nominal, não
// o restante exato de cada chave. O painel precisa saber qual dos dois está
// mostrando para não chamar de precisa uma média que envelhece.
import config from '../config.js';
import * as cache from './cache.js';
import { magMetaCountsKey } from './cache-keys.js';
import { QUOTAS } from './cache-quotas.js';
import { davailState, magnetState, type MagCount, type MagnetSide } from './debrid-state-native.js';
import { emptyAdapterTotals, type AdapterTotals } from './magnetdb-counts.js';

export type PersistentCountsPayload = { version: 1; updatedAt: number; adapters: Record<string, AdapterTotals> };

/**
 * Procedência da soma de TTL restante exposta no status:
 * - `l1-rebuild`: soma reconstruída pela ponte com o restante real de cada
 *   linha (`summary`). Precisa no instante do rebuild; NÃO sobrevive a mutação.
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

/**
 * SENTINELA DE DIVERGÊNCIA TOTAL — não é reconciliação integral. Compara só o
 * TOTAL restaurado com o total físico do namespace, que é o número que o
 * chamador já tem em mãos: custo zero.
 *
 * O que pega: o agregado que perdeu (ou inventou) registros, incluindo adapter
 * inteiro sumido — a deriva medida no cache.db local (77 para 190 chaves).
 *
 * O que NÃO pega, de propósito: distribuição errada com total certo (ex.: 100
 * alive + 90 bad onde o L1 tem 190 alive). Detectar isso exigiria varrer o L1
 * a todo boot ou persistir um fingerprint por lado/adapter — custo permanente
 * sem evidência de que essa deriva aconteça. A sentinela fica barata e o
 * alcance fica escrito; se um dia aparecer distribuição torta em produção, o
 * fingerprint é a próxima parada, não o scan obrigatório.
 */
const totalDiverges = (restored: Map<string, AdapterTotals>, l1Entries: number): boolean =>
  sumSides(restored) !== l1Entries;

/**
 * Reconstrói o agregado pela ponte nativa, para quando o persistido não abre
 * ou diverge do banco. É o único caminho em que a soma de TTL nasce PRECISA:
 * `summary` devolve o restante real de cada linha, não o nominal.
 */
function adoptRebuild() {
  const now = Date.now();
  // `summary` devolve o restante REAL de cada linha, não o nominal.
  const rows: MagCount[] = magnetState().summary(now);
  let ttlReal = true;
  for (const row of rows) {
    const totals = getOrCreateAdapter(row.adapter);
    totals[row.side] += row.count;
    if (Number.isFinite(row.ttlRemainingSum)) {
      totals.ttlRemainingSums[row.side] += row.ttlRemainingSum;
    } else {
      ttlReal = false;
    }
  }
  ttlBasis = ttlReal ? 'l1-rebuild' : 'aggregate-estimate';
  if (adapterCounts.size > 0) schedulePersistentSave();
}

export function loadPersistentCounts() {
  const l1Entries = magnetState().liveCount(Date.now());
  if (l1Entries === 0) { adapterCounts.clear(); return; }
  const raw = cache.peek(magMetaCountsKey()) as PersistentCountsPayload | null;
  adapterCounts.clear();
  // Versão/estrutura estranha conta como agregado ausente: com o namespace
  // cheio o dado verdadeiro está nas linhas, não num payload que este processo
  // não sabe ler — cair no rebuild é mais honesto que restaurar lixo.
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !raw.adapters || typeof raw.adapters !== 'object' || Array.isArray(raw.adapters)) {
    // Agregado ausente/ilegível com o namespace cheio: reconta pela ponte e
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
  // A comparação é exata de propósito: `liveCount()` é a contagem física do
  // namespace mag e a soma dos lados conta a mesma coisa, então tolerância
  // aqui só serviria para deixar passar deriva pequena. O preço do desacordo é
  // uma passada O(namespace mag) por boot (29,6 ms medidos em 50 mil chaves,
  // a cota cheia), nunca no caminho de busca. O alcance da sentinela — e o que
  // ela deliberadamente não vê — está em `totalDiverges`.
  const restored = restoreFromAggregate(raw);
  if (totalDiverges(restored, l1Entries)) {
    adoptRebuild();
    return;
  }
  ttlBasis = 'aggregate-estimate';
  for (const [id, totals] of restored) adapterCounts.set(id, totals);
}

/**
 * Sincroniza a amostra com o namespace antes de o status ler `adapterCounts`:
 * namespace vazio zera a amostra (o banco de verdade esvaziou); amostra vazia
 * com namespace cheio carrega o agregado persistido (ex.: primeiro status de
 * testes/runner sem passar pelo load do boot).
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

// Hook único de decremento: quem tira linha do `mag`/`davail` no dia a dia é a
// VARREDURA NATIVA (TTL vencido e teto do namespace), disparada no fim de cada
// prune do cache do Node. O antigo `onForget` não serve mais: a escrita nativa
// não passa pelo cache do Node, então nenhum forget daqui veria essas linhas —
// sem este hook os contadores só cresceriam.
const nominalTtl = (side: MagnetSide): number =>
  side === 'alive' ? config.magnetDb.aliveTtl : side === 'bad' ? config.magnetDb.badTtl : config.magnetDb.lieTtl;

cache.onPrune(() => {
  const now = Date.now();
  const removed = magnetState().sweep(QUOTAS.mag, now);
  davailState().sweep(QUOTAS.davail, now);
  if (removed.counts.length === 0) return;
  // Quem remove é a varredura nativa, que devolve a contagem EXATA por lado:
  // o decremento é por lado, com o TTL nominal e piso 0 — a soma restante já
  // é estimativa, porque não há restante real por linha depois da remoção.
  for (const c of removed.counts) {
    const totals = adapterCounts.get(c.adapter);
    if (!totals) continue;
    totals[c.side] = Math.max(0, totals[c.side] - c.count);
    totals.ttlRemainingSums[c.side] = Math.max(0, totals.ttlRemainingSums[c.side] - c.count * nominalTtl(c.side));
  }
  markMutation();
  schedulePersistentSave();
});

// Restauração no boot: rodava no carregamento do magnetdb.ts antes do split e
// continua rodando uma vez, quando o módulo de persistência é carregado.
loadPersistentCounts();
