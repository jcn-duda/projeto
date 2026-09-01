// Gate de ocupação da conta do Chupim, extraído de autofetch.ts para caber o
// snapshot de diagnóstico sem estourar a catraca. A decisão e o memo moram
// aqui; o autofetch.ts reexporta (`autofetch.accountGateBlocked`) para os
// testes e o runner continuarem enxergando o mesmo contrato.
import crypto from 'node:crypto';
import autofetchLive from '../utils/autofetch-live.js';
import debrid from '../debrid/index.js';
import { accountScope } from '../utils/request-key.js';
import type { DebridAdapter } from '../../types/domain.js';

/**
 * Gate de ocupação da conta (backpressure): conta cheia não recebe mais
 * download do autofetch. Encher a conta é o que derruba a checagem de cache
 * (um upload, na AllDebrid) e faz o ⚡ sumir da lista inteira — o gate para
 * de escrever ANTES do teto, no mesmo limiar em que o /debrid-status.json
 * começa a avisar.
 *
 * Contrato: NUNCA faz rede no caminho síncrono. A contagem vem de duas
 * leituras locais — o inventário memoizado (dinv, quando existe) ou o memo
 * em memória abaixo — e o refresh roda em background. Memo frio ou vencido
 * é FAIL-OPEN: melhor um download a mais que bloquear sem evidência.
 */
type GateMemo = { count: number; max: number; blocked: boolean; at: number; source: string };
const accountGateMemo = new Map<string, GateMemo>();
// Último bloqueio pelo piso do inventário: diagnóstico apenas, nunca decide a
// chamada seguinte (o dinv pode cair abaixo do limiar entre duas buscas).
const accountGateObserved = new Map<string, GateMemo>();
// Trava anti-duplicação: memo vencido acordado por N buscas dispara UM refresh.
const accountGateInFlight = new Set<string>();

function accountGateBlocked(adapter: DebridAdapter, apiKey: string): boolean {
  const live = autofetchLive.effective();
  const pauseAt = live.autoFetchPauseAt;
  if (pauseAt <= 0) return false;
  if (!adapter || !apiKey) return false;
  const key = `${adapter.id}:${accountScope(apiKey)}`;

  // Bônus barato para o gate LEGADO: o inventário memoizado é leitura
  // local (cache.get, sem rede) e a contagem já é o tamanho do array. Mas o
  // dinv guarda só magnets PRONTOS, e a ocupação que derruba a conta é o
  // TOTAL: prontos ⊆ todos, então o peek é piso — só bloqueia, nunca libera.
  // Adapter com occupancy (TorBox) NÃO pode usar esse piso: 900 prontos não
  // dizem quantos slots ativos estão ocupados — foi a causa H3 medida.
  if (typeof adapter.occupancy !== 'function') {
    const peek = debrid.inventoryPeek(adapter, apiKey);
    if (Array.isArray(peek) && peek.length >= pauseAt) {
      accountGateObserved.set(key, {
        count: peek.length, max: pauseAt, blocked: true,
        at: Date.now(), source: 'inventoryPeek',
      });
      return true;
    }
    accountGateObserved.delete(key);
  }

  // Adaptador sem accountStatus (ou sem contagem total, como o Premiumize,
  // que só publica o fair-use) nunca bloqueia: sem medição não há evidência.
  if (typeof adapter.accountStatus !== 'function') return false;

  const memo = accountGateMemo.get(key);
  if (memo && Date.now() - memo.at < live.autoFetchPauseRefreshMs) {
    return memo.blocked;
  }

  // Memo vencido/ausente: FAIL-OPEN agora, refresh em background para a
  // próxima chamada decidir com a contagem real.
  if (!accountGateInFlight.has(key)) {
    accountGateInFlight.add(key);
    Promise.resolve(adapter.accountStatus(apiKey))
      .then((status) => {
        if (typeof adapter.occupancy === 'function') {
          const measured = adapter.occupancy(status);
          const count = Number(measured?.used);
          const max = Number(measured?.max);
          if (Number.isFinite(count) && Number.isFinite(max) && max > 0) {
            accountGateObserved.delete(key);
            accountGateMemo.set(key, {
              count, max, blocked: count >= max,
              at: Date.now(), source: 'accountStatus',
            });
          }
          return;
        }
        const count = Number(status?.magnets);
        // Sem contagem numérica (campo ausente) nada é gravado: o serviço
        // continua fail-open para sempre, igual ao adaptador sem suporte.
        if (Number.isFinite(count)) {
          accountGateObserved.delete(key);
          accountGateMemo.set(key, {
            count, max: pauseAt, blocked: count >= pauseAt,
            at: Date.now(), source: 'accountStatus',
          });
        }
      })
      .catch(() => {})
      .finally(() => accountGateInFlight.delete(key));
  }
  return false;
}

/** Limpa o memo e a trava em voo do gate de ocupação (testes/diagnóstico). */
function resetAccountGate() {
  accountGateMemo.clear();
  accountGateObserved.clear();
  accountGateInFlight.clear();
}

/**
 * Estado do gate para o painel: qual conta está medida, com que contagem e
 * desde quando — sem isso não se distingue "o gate bloqueou" de "o gate
 * estava frio" (e frio é fail-open). Só leitura local do memo/trava; a rede
 * continua proibida no caminho síncrono.
 */
function accountGateSnapshot() {
  const live = autofetchLive.effective();
  const pauseAt = live.autoFetchPauseAt;
  const accounts: Array<{ id: string; count: number; max: number; at: number; source: string; blocked: boolean }> = [];
  const visible = new Map([...accountGateMemo, ...accountGateObserved]);
  for (const [key, memo] of visible) {
    accounts.push({
      // Mesmo padrão de budget.accounts: o digest inteiro nunca sai, só 12 hex
      // do hash da chave (adapter:account) — suficiente para correlacionar.
      id: crypto.createHash('sha256').update(key).digest('hex').slice(0, 12),
      count: memo.count,
      max: memo.max,
      at: memo.at,
      source: memo.source || 'accountStatus',
      blocked: pauseAt > 0 && memo.blocked,
    });
  }
  return {
    pauseAt,
    blocked: pauseAt > 0 && accounts.some((account) => account.blocked),
    accounts,
    inFlight: accountGateInFlight.size,
  };
}

export { accountGateBlocked, resetAccountGate, accountGateSnapshot };
