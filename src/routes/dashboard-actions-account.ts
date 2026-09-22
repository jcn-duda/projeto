import type express from 'express';
import type { AppServices } from './types.js';

/**
 * Teste de conta de debrid (Fase 1 do debrid configurável), extraído do
 * despacho pela catraca de linhas — mesmo padrão dos irmãos
 * dashboard-actions-autofetch.ts e dashboard-actions-magnet.ts.
 *
 * NÃO destrutivo e SEM estado: valida {service, key} contra o registry,
 * consulta a saúde da chave informada e devolve payload seguro. De propósito
 * NÃO memoiza (o memo do painel serve só às contas já configuradas), NÃO
 * persiste nada (davail/magnetdb/ledger intocados) e NÃO troca config de
 * instalação alguma — é diagnóstico de credencial ANTES de salvar, não
 * aplicação dela. Não entra em DESTRUCTIVE_ACTIONS: nada na conta é criado,
 * modificado ou apagado.
 */

type ActionDeps = {
  services: AppServices;
  req: express.Request;
  res: express.Response;
  action: string;
};

// Teto da chave no corpo do teste de conta: credencial tem dezenas de
// caracteres; 512 cobre folgado e impede payload gigante contra a API.
const MAX_TEST_KEY_LENGTH = 512;

export const debridAccountTest = async ({ services, req, res, action }: ActionDeps): Promise<express.Response> => {
  const service = typeof req.body?.service === 'string' ? req.body.service.trim() : '';
  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  const adapter = service ? services.debrid.BY_ID.get(service) : undefined;
  if (!adapter) {
    return res.status(400).json({
      ok: false,
      action,
      reason: 'servico-desconhecido',
      error: 'serviço desconhecido; use um id do registry de debrid',
      fix: 'escolha um dos serviços suportados pelo addon',
    });
  }
  if (!key) {
    return res.status(400).json({
      ok: false,
      action,
      reason: 'chave-ausente',
      error: 'chave vazia; informe a chave da conta para testar',
      fix: 'cole a chave da conta do serviço e teste novamente',
    });
  }
  if (key.length > MAX_TEST_KEY_LENGTH) {
    return res.status(400).json({
      ok: false,
      action,
      reason: 'chave-invalida',
      error: `chave acima de ${MAX_TEST_KEY_LENGTH} caracteres`,
      fix: 'confira se a chave foi colada por inteiro, sem conteúdo extra',
    });
  }
  const outcome = await services.debrid.testAccount(adapter, key);
  services.metrics.count(outcome.ok ? 'dashboard.debrid.account_test.ok' : 'dashboard.debrid.account_test.fail');
  // Log só service/result: credencial, last4 e impressão digital nunca entram.
  services.log.info(
    `[dashboard] teste de conta de debrid (${service}): ${outcome.ok ? 'ok' : `falha (${outcome.reason})`}`,
  );
  return res.json({ ...outcome, action });
};
