import type { DebridAdapter } from '../../types/domain.js';
import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import * as catalog from '../utils/catalog.js';
import { recordFileEvidence } from './audio-audit.js';
import { BY_ID } from './registry.js';

// ---------------------------------------------------------------------------
// Catálogo durável + limpador BR da conta do OPERADOR (AllDebrid)
// ---------------------------------------------------------------------------
//
// Mesmo padrão do `sweepUndubbedEnv`: adapter vem de `config.debrid.service`
// via BY_ID, chave de `config.debrid.apiKey` com o gate de operador
// (`envOperatorAccount`). NUNCA lançam —
// devolvem `{ ok:false, reason }` e capturam erro com log.warn, para a rota
// operacional responder diagnóstico em vez de cair.

/** Operador configurado para o catálogo, ou null + reason de indisponibilidade. */
function catalogContext(): { adapter: DebridAdapter | null; guardos: { ok: false; reason: string; hint?: string } | null } {
  if (!config.debrid.service) return { adapter: null, guardos: { ok: false, reason: 'sem-debrid' } };
  const adapter = BY_ID.get(config.debrid.service) || null;
  // magnetList é quem prova que o adaptador suporta a varredura da conta.
  if (!adapter || typeof adapter.magnetList !== 'function') {
    return { adapter, guardos: { ok: false, reason: 'sem-adapter-catalogo' } };
  }
  // Dois motivos DE PROPÓSITO distintos: "sem conta" (chave ausente) é outro
  // estado do que "conta existe mas o uso está desligado no .env" — colapsar
  // os dois escondia o conserto (ligar o flag + recriar a stack) num painel
  // cujo .env claramente tem a conta configurada.
  if (!config.debrid.apiKey) {
    return { adapter, guardos: { ok: false, reason: 'sem-conta-operador' } };
  }
  if (!config.debrid.envOperatorAccount) {
    return {
      adapter,
      guardos: {
        ok: false,
        reason: 'chave-operador-desativada',
        hint: 'DEBRID_API_KEY existe, mas o uso da conta do operador está desligado; ligue DEBRID_OPERATOR_ENV_ACCOUNT (só as features do painel) ou DEBRID_ALLOW_ENV_KEY (também herda a chave em instalações sem dk) e recrie a stack',
      },
    };
  }
  return { adapter, guardos: null };
}

/** Varre a conta do operador e devolve o relatório do catálogo. */
async function catalogScanEnv() {
  const { adapter, guardos } = catalogContext();
  if (adapter == null || guardos) return guardos || { ok: false, reason: 'sem-adapter' };
  try {
    const magnets = await adapter.magnetList!(config.debrid.apiKey);
    const report = catalog.scan({
      adapterId: adapter.id,
      account: accountScope(config.debrid.apiKey),
      magnets,
      // O operatorCtx() do br-coverage é específico da Fase 3 (só enxerga a
      // conta RD do .env) e devolveria adapterId null para a AllDebrid — o ⚡
      // do catálogo sairia sempre "unknown". Aqui o alvo é a CONTA do
      // operador: davail e mag:alive são gravados exatamente com
      // adapter+accountScope, então o ctx correto é o próprio adapter ativo.
      ctx: { adapterId: adapter.id, apiKey: config.debrid.apiKey },
    });
    return { ok: true, report };
  } catch (err: unknown) {
    log.warn(`[catalog] varredura falhou:`, log.errorMessage(err));
    return { ok: false, reason: 'erro' };
  }
}

/** Relatório do catálogo (leitura do banco, sem rede). */
function catalogStatusEnv() {
  const { guardos } = catalogContext();
  if (guardos) return guardos;
  return { ok: true, report: catalog.report(accountScope(config.debrid.apiKey)) };
}

/** Plano de deduplicação (leitura pura; nenhuma deleção). */
function dedupPreviewEnv() {
  const { adapter, guardos } = catalogContext();
  if (adapter == null || guardos) return guardos || { ok: false, reason: 'sem-adapter' };
  return { ok: true, plan: catalog.planDedup(accountScope(config.debrid.apiKey), adapter.id) };
}

/** Aplica os kills do plano de dedup (com teto `max` se dado). */
async function dedupApplyEnv(max?: number) {
  const { adapter, guardos } = catalogContext();
  if (adapter == null || guardos) return guardos || { ok: false, reason: 'sem-adapter' };
  const account = accountScope(config.debrid.apiKey);
  const plan = catalog.planDedup(account, adapter.id);
  const deletions: Array<{ serviceId: string | number; hash: string; reason: string }> = [];
  for (const g of plan.t1) for (const k of g.kill) deletions.push({ serviceId: k.serviceId, hash: k.hash, reason: 'duplicado' });
  for (const g of plan.t2) for (const k of g.kill) deletions.push({ serviceId: k.serviceId, hash: k.hash, reason: 'duplicado por arquivo' });
  const byId = new Map<string, (typeof deletions)[number]>();
  for (const d of deletions) byId.set(String(d.serviceId), d);
  let list = [...byId.values()];
  if (max != null && Number.isFinite(max)) list = list.slice(0, Math.max(0, Math.trunc(max)));
  try {
    const res = await catalog.applyDeletions(account, adapter.id, list, (ids) => adapter.deleteMagnets!(config.debrid.apiKey, ids));
    metrics.count('dashboard.catalog.dedup', res.ok);
    return { ok: true, deleted: res.ok, falhas: res.falhas };
  } catch (err: unknown) {
    log.warn(`[catalog] dedup falhou:`, log.errorMessage(err));
    return { ok: false, reason: 'erro' };
  }
}

/** Auditoria em fundo: prova os arquivos das linhas sem evidência no índice. */
async function auditBackfillEnv({ max, concurrency }: { max?: number; concurrency?: number } = {}) {
  const { adapter, guardos } = catalogContext();
  if (adapter == null || guardos) return guardos || { ok: false, reason: 'sem-adapter' };
  const account = accountScope(config.debrid.apiKey);
  const teto = max ?? config.catalog.auditMaxPerRound;
  const workers = Math.min(3, Math.max(1, Math.trunc(concurrency ?? config.catalog.auditConcurrency)));
  const rows = catalog.rowsNeedingAudit(account, teto);
  let scanned = 0;
  let evidenced = 0;
  let failed = 0;
  let idx = 0;
  const work = async () => {
    for (;;) {
      const row = rows[idx++];
      if (!row) break;
      try {
        const files = await adapter.magnetFiles!(config.debrid.apiKey, row.serviceId);
        scanned += 1;
        if (files && files.length > 0) {
          recordFileEvidence(row.hash, files as any);
          catalog.noteAudit(account, row.serviceId, row.hash, files);
          evidenced += 1;
        } else {
          // Pronto mas sem arquivos listados NESTA leitura: nada a aprender,
          // então marca auditada para a fila não re-visitar o mesmo ítem a cada
          // rodada. Mas NÃO congela quem está condenado SÓ PELO TÍTULO: uma
          // condenação de título ainda pode ser ABSOLVIDA pelos arquivos reais
          // numa rodada futura (o post pode mentir o áudio, o .mkv não), e
          // marcar aqui perpetuaria a condenação via keepAudited — falso
          // positivo apaga acervo BR bom. A janela "Ready sem arquivos" é
          // transiente; um magnet verdadeiramente Ready enumera arquivos numa
          // destas. O helper marca só quando foreignProof=='' (unknown/dual/
          // lixo sem condenação), mantendo o dreno principal inalterado.
          catalog.markAuditedUnlessCondemned(account, row.serviceId);
        }
      } catch (err: unknown) {
        failed += 1;
        log.warn(`[catalog] auditoria do magnet ${row.serviceId} falhou:`, log.errorMessage(err));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, workers) }, () => work()));
  return { ok: true, scanned, evidenced, failed };
}

/**
 * Acervo que JÁ ERA da conta do operador, para a limpeza BR com prova. Mesma
 * regra do sweepUndubbed: sem snapshot (`null`/adapter sem a função) o
 * fail-safe FECHA — ausência de referência nunca autoriza remoção.
 */
async function operatorKnownHashes(adapter: DebridAdapter): Promise<Set<string> | null> {
  if (typeof adapter.preexistingHashes !== 'function') return null;
  try {
    return await adapter.preexistingHashes(config.debrid.apiKey);
  } catch (err: unknown) {
    log.warn('[catalog] inventário de preexistentes falhou:', log.errorMessage(err));
    return null;
  }
}

/** Linhas para o operador escolher na mão (leitura pura, maiores primeiro). */
function catalogListEnv({ bucket, limit }: { bucket?: string; limit?: number } = {}) {
  const { adapter, guardos } = catalogContext();
  if (adapter == null || guardos) return guardos || { ok: false, reason: 'sem-adapter' };
  const rows = catalog.listForReview(accountScope(config.debrid.apiKey), adapter.id, { bucket, limit });
  return { ok: true, rows };
}

/**
 * Deleção MANUAL dos ids que o operador marcou. Não passa por classificação
 * nem por trava de idade: a escolha explícita é a autorização. A rota exige
 * `confirm: true`, como as outras destrutivas.
 */
async function manualDeleteEnv({ serviceIds }: { serviceIds?: Array<string | number> } = {}) {
  const { adapter, guardos } = catalogContext();
  if (adapter == null || guardos) return guardos || { ok: false, reason: 'sem-adapter' };
  if (!Array.isArray(serviceIds) || serviceIds.length === 0) {
    return { ok: false, reason: 'sem-selecao' };
  }
  const account = accountScope(config.debrid.apiKey);
  const plan = catalog.planManualDeletion(account, adapter.id, serviceIds);
  if (plan.targets.length === 0) return { ok: true, total: 0, deleted: 0, falhas: 0, ...plan.skipped };
  try {
    const res = await catalog.applyDeletions(
      account,
      adapter.id,
      plan.targets.map((t) => ({ serviceId: t.serviceId, hash: t.hash, reason: t.reason })),
      (ids) => adapter.deleteMagnets!(config.debrid.apiKey, ids),
    );
    metrics.count('dashboard.catalog.manual', res.ok);
    return { ok: true, total: plan.targets.length, deleted: res.ok, falhas: res.falhas, ...plan.skipped };
  } catch (err: unknown) {
    log.warn('[catalog] deleção manual falhou:', log.errorMessage(err));
    return { ok: false, reason: 'erro' };
  }
}

/**
 * Devolve à fila as linhas cuja evidência de arquivo expirou (medido: 616 de
 * 790 na conta do operador). Não faz rede — só limpa o carimbo `audited_at`,
 * para a auditoria poder reler com o classificador atual.
 */
function auditRequeueEnv({ max }: { max?: number } = {}) {
  const { guardos } = catalogContext();
  if (guardos) return guardos;
  const account = accountScope(config.debrid.apiKey);
  const resultado = catalog.requeueAudit(account, config.debrid.service, { limit: max });
  log.info(`[catalog] auditoria reenfileirada: ${resultado.requeued} linha(s)`);
  return { ok: true, ...resultado };
}

/**
 * Plano da limpeza de estrangeiro provado (leitura pura).
 *
 * `includeKnown` liga a limpeza pelo OPERADOR sobre o acervo que JÁ ERA da
 * conta. No processo recém-subido, o `knownBefore` do alldebrid monta o
 * snapshot com TUDO que está na conta (o `submitted` em memória está vazio) —
 * a guarda que protege o acervo do usuário anulava a limpeza iniciada no
 * painel. Com `includeKnown` true o wrapper NÃO fica preso ao snapshot: tenta
 * o inventário se já estiver quente (para o painel marcar "(preexistente)"),
 * mas `null` não bloqueia mais. Com `includeKnown` falso/ausente mantém o
 * fail-closed de hoje (sem snapshot → `inventario-frio`).
 */
async function cleanupPreviewEnv({ includeKnown }: { includeKnown?: boolean } = {}) {
  const { adapter, guardos } = catalogContext();
  if (adapter == null || guardos) return guardos || { ok: false, reason: 'sem-adapter' };
  const conhecidos = await operatorKnownHashes(adapter);
  if (!includeKnown && conhecidos === null) return { ok: false, reason: 'inventario-frio' };
  const plan = catalog.planForeignCleanup(accountScope(config.debrid.apiKey), adapter.id, {
    minAgeMs: config.catalog.cleanupMinAgeMs,
    max: config.catalog.cleanupMaxPerRound,
    knownHashes: conhecidos,
    includeKnown: includeKnown === true,
  });
  return { ok: true, ...plan };
}

/** Aplica a limpeza de estrangeiro provado (com teto `max` se dado). */
async function cleanupApplyEnv(max?: number, { includeKnown }: { includeKnown?: boolean } = {}) {
  const { adapter, guardos } = catalogContext();
  if (adapter == null || guardos) return guardos || { ok: false, reason: 'sem-adapter' };
  const account = accountScope(config.debrid.apiKey);
  const conhecidos = await operatorKnownHashes(adapter);
  if (!includeKnown && conhecidos === null) return { ok: false, reason: 'inventario-frio' };
  const plan = catalog.planForeignCleanup(account, adapter.id, {
    minAgeMs: config.catalog.cleanupMinAgeMs,
    max: config.catalog.cleanupMaxPerRound,
    knownHashes: conhecidos,
    includeKnown: includeKnown === true,
  });
  const list = max != null && Number.isFinite(max) ? plan.targets.slice(0, Math.max(0, Math.trunc(max))) : plan.targets;
  const deletions = list.map((t) => ({ serviceId: t.serviceId, hash: t.hash, reason: t.reason }));
  try {
    const res = await catalog.applyDeletions(
      account,
      adapter.id,
      deletions,
      (ids) => adapter.deleteMagnets!(config.debrid.apiKey, ids),
    );
    metrics.count('dashboard.catalog.cleanup', res.ok);
    return { ok: true, total: list.length, deleted: res.ok, falhas: res.falhas };
  } catch (err: unknown) {
    log.warn(`[catalog] limpeza falhou:`, log.errorMessage(err));
    return { ok: false, reason: 'erro' };
  }
}

export {
  catalogScanEnv,
  catalogStatusEnv,
  dedupPreviewEnv,
  dedupApplyEnv,
  auditBackfillEnv,
  catalogListEnv,
  manualDeleteEnv,
  auditRequeueEnv,
  cleanupPreviewEnv,
  cleanupApplyEnv,
};
