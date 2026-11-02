// Dono do relógio da varredura NATIVA dos namespaces `mag` (magnetdb por
// conta) e `davail` (⚡ por hash/conta): quem tira linha do namespace no dia a
// dia é a VARREDURA (TTL vencido e teto), porque a escrita nativa não passa
// pelo cache do Node — nenhum forget daqui as veria. A PODA física continua
// sendo papel do Node (o dono do relógio é este módulo); sem ele o `cache.db`
// cresce sem teto e a cota nunca evicta. O Rust NÃO faz sweep próprio.
//
// Módulo próprio de propósito: extraído de `magnetdb-persist.ts` (apagado no
// fechamento do mag) para o relógio não morrer junto com uma fachada — a
// poda de DOIS namespaces é infraestrutura do processo, não detalhe do
// magnetdb. O status do painel reconta o físico a cada leitura
// (`summary`/`liveCount` em magnetdb.ts) e não depende deste relógio.
import { QUOTAS } from './cache-quotas.js';
import {
  davailState,
  magnetState,
  type DavailSweep,
  type SweepRemoval,
} from './debrid-state-native.js';

// `davailState()`/`magnetState()` lançam se o napi não expõe a classe
// (debrid-state-native.ts) e exceção em callback de `setInterval` é uncaught —
// derrubaria o processo. Falha de ponte devolve zeros (não poda neste ciclo; o
// próximo tenta de novo); o teste de semeadura segue provando a ponte viva.
const NADA_MAG: SweepRemoval = { expired: 0, evicted: 0, counts: [] };
const NADA_DAVAIL: DavailSweep = { expired: 0, evicted: 0 };

export function sweepNativeNamespaces(): { mag: SweepRemoval; davail: DavailSweep } {
  const now = Date.now();
  let mag = NADA_MAG;
  let davail = NADA_DAVAIL;
  try {
    mag = magnetState().sweep(QUOTAS.mag, now);
  } catch (err) {
    console.error('[sweep] mag sem ponte nativa:', err);
  }
  try {
    davail = davailState().sweep(QUOTAS.davail, now);
  } catch (err) {
    console.error('[sweep] davail sem ponte nativa:', err);
  }
  return { mag, davail };
}

// A mesma cadência de 10 min que o timer do prune do L1 tinha (com os
// namespaces órfãos migrados, o prune do Node não é mais o único relógio de
// manutenção do processo). `unref`: a varredura não é papel dela segurar o
// processo vivo.
setInterval(sweepNativeNamespaces, 10 * 60 * 1000).unref();
