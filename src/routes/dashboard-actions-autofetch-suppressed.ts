import type express from 'express';
import type { AppServices } from './types.js';
import { maxFromBody } from './dashboard-actions-shared.js';

/**
 * Ações da fila de remoções represadas (autofetch-suppressed.ts) — a porta
 * SUPERVISIONADA do operador, que não exige ligar o knob global
 * `DEBRID_REMOVE_BY_ID`: o drain automático do recheck continua gateado
 * (caminho de cima respeita o freio de rollout), o painel drena com
 * `force: true` sob confirmação explícita.
 *
 * Os registros são chaveados por `adapterId:accountScope`, e a conta que o
 * processo sabe abrir é a do OPERADOR (`harvesterDebrid.resolveQuota()`:
 * painel > `.env` com gate). O drain age SÓ nela — o agregado do snapshot
 * cobre também contas de instalações de usuário, e por isso a resposta
 * devolve `elegiveis`/`restantes` para a diferença ficar visível, não
 * escondida. Nada de credencial, hash de conta ou infoHash no payload.
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

/** Dreno sob comando: DESTRUTIVA (confirm checado pelo despacho) e limitada. */
export const autofetchSuppressedDrain: SuppressedAction = async ({ services, req, res, action }) => {
  const resolved = services.harvesterDebrid.resolveQuota();
  if (!resolved) return semContaOperador(res, action);
  const account = services.accountScope(resolved.apiKey);
  const elegiveis = services.autofetchSuppressed.listSuppressed(resolved.adapter.id, account).length;
  // `force` abre a porta do painel sem o knob global; `max` do corpo vence o
  // teto por passagem (default suppressedDrainMax) — rajada controlada.
  const removidas = await services.autofetchSuppressed.drainSuppressed(resolved.adapter, resolved.apiKey, account, {
    force: true,
    max: maxFromBody(req),
  });
  const restantes = services.autofetchSuppressed.countSuppressed(resolved.adapter.id, account);
  services.metrics.count('dashboard.autofetch.suppressed.drain', removidas);
  services.log.info(
    `[dashboard] fila represada drenada (${resolved.adapter.id}): ${removidas} transferência(s) apagada(s), ${restantes} restante(s) na conta do operador`,
  );
  return res.json({ ok: true, action, elegiveis, removidas, restantes });
};
