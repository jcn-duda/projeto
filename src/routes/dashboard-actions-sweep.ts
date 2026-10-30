// Ação `sweep-dead` do /dashboard-action.json: ponte com as varreduras NATIVAS
// da AllDebrid + o ramo legado dos outros serviços.
//
// Extraído de `dashboard-actions.ts` pela catraca de 400 linhas. A decisão de
// dono é do §5.2 do plano `aldebrid-sweeps-admin-route`:
//
//   AllDebrid do OPERADOR  → `runNativeSweep('sweepDead')` (o gateway varre; o
//                            Node não tem adaptador de varredura da AllDebrid)
//   AllDebrid BYO          → erro explícito, SEM cair no adaptador TS (a rota
//                            nativa usa a conta do processo, não a `dk` da URL)
//   outros serviços        → ponte nativa `/debrid/sweep-dead` na 8710 (Premiumize
//                            e companhia; o Rust responde 501 se o serviço não
//                            tem varredura, e aí o painel mostra "indisponível")
//
// O `confirm` da ação destrutiva já rodou no despacho (DESTRUCTIVE_ACTIONS), e o
// corpo nativo manda `confirm:true` de novo porque a rota manual do gateway só
// aceita aplicar com essa flag.
import type express from 'express';
import type { AppServices } from './types.js';
import { refreshSweepsStatus, runNativeSweep } from '../utils/sweeps-native.js';
import { sweepDeadNative } from '../debrid/rust-sweep.js';

type SweepDeps = {
  services: AppServices;
  res: express.Response;
  action: string;
};

const OPERATOR_ONLY =
  'varredura nativa atende só a conta do operador: a chave desta instalação (BYO) não é varrida pelo gateway; use a conta do operador no .env';

/**
 * Varredura de serviços não-AllDebrid, pela ponte nativa (`/debrid/sweep-dead`).
 *
 * A chave é a da instalação corrente (`opts().debridApiKey`, a `dk` da URL ou a
 * herdada) e o serviço é o adaptador corrente. Sem chave, ou se a ponte não
 * responde (501 = serviço sem varredura nativa, ou falha), o painel responde
 * "indisponível"; nada aqui cai no caminho da AllDebrid.
 */
async function legacySweep(services: AppServices): Promise<unknown> {
  const apiKey = String(services.runtime.opts().debridApiKey || '');
  if (!apiKey) return null;
  const adapter = services.debrid.current();
  if (!adapter) return null;
  try {
    return await sweepDeadNative(adapter.id, apiKey, services.config.debrid.sweepDeadMinAgeMs);
  } catch (err) {
    services.log.warn(`[${adapter.id}] varredura de mortos falhou: ${services.log.errorMessage(err)}`);
    return null;
  }
}

export async function sweepDead({ services, res, action }: SweepDeps): Promise<express.Response> {
  services.metrics.count('dashboard.sweep-dead');
  const active = services.debrid.current()?.id ?? null;
  const operatorService = String(services.config.debrid.service || '');
  const allDebrid = active === 'alldebrid' || (active === null && operatorService === 'alldebrid');

  if (allDebrid) {
    // Conta do operador = chave do `.env` + gate de operador. Sem isso a chave
    // em jogo é a do usuário (`dk` da URL), que o gateway não conhece.
    const operatorAllDebrid = operatorService === 'alldebrid'
      && Boolean(services.config.debrid.apiKey)
      && Boolean(services.config.debrid.envOperatorAccount);
    if (!operatorAllDebrid) {
      services.metrics.count('dashboard.sweep-dead.byo-blocked');
      services.log.info('[dashboard] varredura nativa recusada: a conta em jogo não é a do operador');
      return res.json({ ok: false, action, result: null, error: OPERATOR_ONLY });
    }
    services.metrics.count('dashboard.sweep-dead.native');
    const result = await runNativeSweep('sweepDead');
    // Em sucesso o cartão de status não espera o próximo poll do gateway.
    if (result.ok) void refreshSweepsStatus();
    services.log.info(
      `[dashboard] varredura nativa: ${result.ok ? 'pedido executado' : `recusada (${result.reason || 'sem motivo'})`}` +
      `${result.timedOut ? ' — segue no gateway depois do prazo da ponte' : ''}`,
    );
    return res.json({ ok: result.ok, action, result, error: result.ok ? undefined : result.error });
  }

  // ramo legado: serviços não-AllDebrid (o corte TS não os cobre).
  const result = await legacySweep(services);
  return res.json({
    ok: result != null,
    action,
    result,
    error: result == null ? 'varredura indisponível: o debrid ativo não implementa varredura, ou ela está desligada' : undefined,
  });
}
