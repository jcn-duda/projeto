import type express from 'express';
import type { AppServices } from './types.js';
import { autofetchEffectApplied, drainSuppressedAutofetch, type AutofetchResult } from '../utils/autofetch-native.js';

/**
 * Ações da fila de remoções represadas (autofetch-suppressed.ts) — a porta
 * SUPERVISIONADA do operador, sob confirmação explícita.
 *
 * Os registros são chaveados por `adapterId:accountScope`, e a conta que o
 * processo sabe abrir é a do OPERADOR (`harvesterDebrid.resolveQuota()`:
 * painel > `.env` com gate). A leitura age SÓ nela — o agregado do snapshot
 * cobre também contas de instalações de usuário. Nada de credencial, hash de
 * conta ou infoHash no payload.
 *
 * O dreno é SÓ da admin do gateway (`POST /autofetch/suppressed-drain`): o
 * worker nativo é o dono e a conta do operador não é pré-requisito (o número
 * por conta não existe lá, então `elegiveis`/`restantes` vão `null` em vez de
 * um zero inventado). A LEITURA (`-get`) segue só no Node: a admin não publica
 * a fila represada.
 */

type ActionDeps = {
  services: AppServices;
  req: express.Request;
  res: express.Response;
  action: string;
};

type SuppressedAction = (deps: ActionDeps) => Promise<express.Response> | express.Response;

// Sem conta de operador não há o que escanear: os registros são por conta, e
// inventar escopo exporia fila de instalação alheia. Mesma linguagem do erro
// do harvesterDebrid.set, apontando a aba que resolve.
function semContaOperador(res: express.Response, action: string): express.Response {
  return res.status(400).json({
    ok: false,
    action,
    reason: 'sem-conta-operador',
    error: 'nenhuma conta de debrid de operador para escanear a fila de remoções represadas',
    fix: 'configure o serviço e a chave na aba Conta de debrid do Colhedor (ou ligue DEBRID_OPERATOR_ENV_ACCOUNT com serviço+chave no .env)',
  });
}

/** Leitura da fila para a conta do operador — sem `confirm`, sem rede. */
export const autofetchSuppressedGet: SuppressedAction = ({ services, res, action }) => {
  const resolved = services.harvesterDebrid.resolveQuota();
  if (!resolved) return semContaOperador(res, action);
  const account = services.accountScope(resolved.apiKey);
  services.metrics.count('dashboard.autofetch.suppressed.get');
  return res.json({
    ok: true,
    action,
    adapter: resolved.adapter.id,
    // pending = profundidade total (aguarda decisão, inclusive em backoff);
    // elegiveis = os que a próxima passagem do drain tocaria. O agregado de
    // TODAS as contas mora no snapshot (`autofetch.suppressed` do status), que
    // é o número que o painel mostra; este endpoint é só da conta do operador.
    pending: services.autofetchSuppressed.countSuppressed(resolved.adapter.id, account),
    elegiveis: services.autofetchSuppressed.listSuppressed(resolved.adapter.id, account).length,
  });
};

// Motivos do `press_skipped` da admin: o passo NÃO rodou. Os demais `effect:
// 'none'` (`empty`, `nothing-eligible`) são passagem real que não achou o que
// apagar — sucesso com zero, não falha.
const DRAIN_SKIPPED = new Set(['worker-disabled', 'kv-unavailable', 'factory-unavailable', 'drain-failed']);

function drainRan(native: AutofetchResult | null): boolean {
  if (autofetchEffectApplied(native)) return true;
  return native?.ok === true && !DRAIN_SKIPPED.has(String(native.reason || ''));
}

/**
 * Dreno sob comando: DESTRUTIVA (confirm checado pelo despacho). Só o worker
 * nativo drena — sem efeito aplicado a ação reporta a falha em vez de cair num
 * dreno local: o Node apagando na conta era segundo dono da represa e, no
 * Real-Debrid, escrita fora do `shared_gate`.
 */
export const autofetchSuppressedDrain: SuppressedAction = async ({ services, res, action }) => {
  const native = await drainSuppressedAutofetch();
  if (!drainRan(native)) {
    return res.json({
      ok: false,
      action,
      reason: 'native-unavailable',
      error: 'o worker nativo do Chupim não aplicou o dreno (gateway fora ou AUTOFETCH_WORKER desligado)',
      gateway: native ?? null,
    });
  }
  const removidas = native?.drained ?? 0;
  services.metrics.count('dashboard.autofetch.suppressed.drain', removidas);
  services.log.info(`[dashboard] fila represada drenada pelo worker nativo: ${removidas} transferência(s) apagada(s)`);
  return res.json({ ok: true, action, elegiveis: null, removidas, restantes: null, source: 'gateway', gateway: native });
};
