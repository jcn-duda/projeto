// LEITURA do agregado durável do banco de magnets (`mag_meta:v1:counts`) e o
// relógio PRÓPRIO da varredura nativa de `mag`/`davail`.
// Módulo separado do magnetdb.ts por um motivo só: aquele arquivo está no teto
// de 400 linhas. A API continua exposta por magnetdb.ts (save/load reexportados
// para addon e testes); nenhuma rota ou consumidor importa daqui diretamente.
//
// O agregado tem UM escritor: o GATEWAY. Os marks do play, do tail e da
// checagem sobem `mag_meta:v1:counts` O(1) pela régua `bump_counts` do núcleo
// (`rust/crates/adom-index/src/magnet_meta.rs`), e o Node NÃO grava mais: a
// amostra dele não enxerga os bumps do gateway (a escrita de evidência já tinha
// saído para o oráculo) e regravá-la no sweep/forget apagava os bumps do dono
// até o boot recontar. O que sobra para cá é a POLÍTICA DE LEITURA: quando
// restaurar o agregado (O(1)) e quando recontar o físico (`summary`) pela
// sentinela de divergência de total — e o relógio da poda física dos namespaces
// que o Node varre (o painel reconcilia por leitura, não por decremento).
//
// `ttlRemainingBasis` resolve uma ambiguidade do diagnóstico: a soma de TTL
// restante exibida pode vir de dois lugares com precisão diferente. O reconto
// pela ponte (`summary`) soma o restante REAL de cada linha; a restauração do
// agregado envelhece uma soma carimbada no `updatedAt` do escritor. O painel
// precisa saber qual dos dois está mostrando para não chamar de precisa uma
// média que envelhece.
import { QUOTAS } from './cache-quotas.js';
import {
  davailState, magnetState, type MagCount, type MagMetaPayload,
} from './debrid-state-native.js';
import { emptyAdapterTotals, type AdapterTotals } from './magnetdb-counts.js';

/**
 * Forma do valor em `mag_meta:v1:counts` — a MESMA que o núcleo grava. O alias
 * fica porque o nome descreve o PAPEL (payload persistido), não o transporte.
 */
export type PersistentCountsPayload = MagMetaPayload;

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

function getOrCreateAdapter(adapterId: string): AdapterTotals {
  let totals = adapterCounts.get(adapterId);
  if (!totals) {
    totals = emptyAdapterTotals();
    adapterCounts.set(adapterId, totals);
  }
  return totals;
}

/**
 * Despejo do shutdown (`src/addon.ts` chama `services.magnetdb.savePersistentCounts?.()`):
 * NO-OP de régua. O agregado tem um escritor só — o gateway, pelos deltas O(1)
 * do `bump_counts` — e a amostra lida aqui não enxerga os bumps dele: regravá-la
 * os apagava até o boot recontar. A função continua existindo para o registro
 * de shutdown não precisar saber da mudança.
 */
export function savePersistentCounts() {}

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
  // NÃO grava: o reconto alimenta o PAINEL; o dono do agregado é o gateway.
  // O reconto DURÁVEL dele acontece no `bump_counts` com a base
  // ausente/vencida/ilegível — e a remoção física (`forget_bad*`, `clear`,
  // `sweep`) apaga a base justamente para forçá-lo. Gravar daqui reabriria a janela de sobrescrita que este corte fecha.
}

export function loadPersistentCounts() {
  ensureCountsLoaded(magnetState().liveCount(Date.now()));
}

/**
 * Sincroniza a foto do painel com o DONO antes de o status ler `adapterCounts`:
 * namespace vazio zera a foto; senão lê o agregado persistido (que o gateway
 * mantém vivo pelos bumps) e decide entre restaurá-lo (O(1)) ou recontar o
 * físico pela sentinela. Roda a CADA leitura do status — a foto do boot não
 * serve, porque os bumps do gateway acontecem depois dela.
 */
export function ensureCountsLoaded(l1Entries: number) {
  if (l1Entries === 0) {
    adapterCounts.clear();
    // Sem registro algum não existe média reconstruída a qualificar: a próxima
    // leitura nasce estimativa, e um `l1-rebuild` órfão mentiria no painel.
    ttlBasis = 'aggregate-estimate';
    return;
  }
  // Leitura pela ponte: o núcleo devolve `null` para ausente, vencido, versão
  // desconhecida ou estrutura torta — o fail-closed mora lá. O guarda de forma
  // continua porque o handle pode ser um dublê injetado por teste.
  const raw = magnetState().counts(Date.now()) as PersistentCountsPayload | null;
  adapterCounts.clear();
  // Versão/estrutura estranha conta como agregado ausente: com o namespace
  // cheio o dado verdadeiro está nas linhas, não num payload que este processo
  // não sabe ler — cair no rebuild é mais honesto que restaurar lixo.
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !raw.adapters || typeof raw.adapters !== 'object' || Array.isArray(raw.adapters)) {
    // Agregado ausente/ilegível com o namespace cheio: reconta pela ponte.
    // Devolver zero aqui seria mentira rotulada de `duravel`. A soma nasce
    // precisa (restante real); o gateway a regrava no próximo `bump_counts`
    // com a base ainda ausente/vencida — não este processo.
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
  // uma passada O(namespace mag) por LEITURA divergente (29,6 ms medidos em 50
  // mil chaves, a cota cheia), nunca no caminho de busca. A remoção física
  // invalida o agregado no núcleo, então a leitura cai no ramo de ausente acima
  // e o próximo bump reconta durável. O que ainda chega aqui é a marca vencida
  // que a poda não levou (ela sai do físico vivo, mas segue somada no agregado)
  // e a corrida com um bump: cada leitura do painel volta aqui até a próxima
  // poda invalidar a base. O alcance da sentinela
  // — e o que ela deliberadamente não vê — está em `totalDiverges`.
  const restored = restoreFromAggregate(raw);
  if (totalDiverges(restored, l1Entries)) {
    adoptRebuild();
    return;
  }
  ttlBasis = 'aggregate-estimate';
  for (const [id, totals] of restored) adapterCounts.set(id, totals);
}

// Varredura das linhas órfãs do L1 (`mag`/`davail`): quem tira linha do
// namespace no dia a dia é a VARREDURA NATIVA (TTL vencido e teto), porque a
// escrita nativa não passa pelo cache do Node — nenhum forget daqui veria essas
// linhas. A PODA continua sendo papel do Node (o relógio fica); o CONTADOR que
// a remoção devolvia por lado alimentava a amostra regravada e morreu com a
// escrita: o painel reconcilia por leitura (sentinela + reconto), e o dono do
// agregado é o gateway. Exportada para o teste disparar sem esperar o timer.
export function sweepNativeNamespaces(): void {
  const now = Date.now();
  magnetState().sweep(QUOTAS.mag, now);
  davailState().sweep(QUOTAS.davail, now);
}

// Relógio PRÓPRIO da varredura nativa: a mesma cadência de 10 min que o timer
// do prune do L1 tinha (com os namespaces órfãos migrados, o prune do Node não
// é mais o único relógio de manutenção do processo). `unref`: a varredura não
// é papel dela segurar o processo vivo.
setInterval(sweepNativeNamespaces, 10 * 60 * 1000).unref();
