// Relógio PRÓPRIO da varredura NATIVA dos namespaces `mag`/`davail`: quem tira
// linha do namespace no dia a dia é a VARREDURA (TTL vencido e teto), porque a
// escrita nativa não passa pelo cache do Node — nenhum forget daqui as veria.
// A PODA física continua sendo papel do Node (o dono do relógio é este módulo);
// sem ele o `cache.db` cresce sem teto e a cota nunca evicta.
//
// A política da AMOSTRA que vivia aqui (restauração do agregado
// `mag_meta:v1:counts`, sentinela de divergência, reconto) morreu: o status do
// painel reconta o físico DIRETO pela ponte (`summary`/`liveCount` em
// magnetdb.ts) — não há foto a restaurar nem agregado a divergir.
import { QUOTAS } from './cache-quotas.js';
import { davailState, magnetState } from './debrid-state-native.js';

export function sweepNativeNamespaces(): void {
  const now = Date.now();
  magnetState().sweep(QUOTAS.mag, now);
  davailState().sweep(QUOTAS.davail, now);
}

// A mesma cadência de 10 min que o timer do prune do L1 tinha (com os
// namespaces órfãos migrados, o prune do Node não é mais o único relógio de
// manutenção do processo). `unref`: a varredura não é papel dela segurar o
// processo vivo.
setInterval(sweepNativeNamespaces, 10 * 60 * 1000).unref();
