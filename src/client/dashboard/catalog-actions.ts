/* Adom Power-Movie — /dashboard: ações do catálogo (C3, ESM). Extraído de
 * catalog.ts para respeitar o teto de 400 linhas: POSTs, resultados e os
 * disparadores dos botões. O refresh pós-ação sai pelo hook loadStatus. Nada
 * toca o DOM no import. */

import { $, requestJson, valueText } from './core.js';
import { empty } from './render.js';
import { hooks } from './hooks.js';
import { bucketError, catalogPicked, renderCatalogDedup, renderCatalogManual, renderCatalogReport, setCatalogFeedback } from './catalog-render.js';

function catalogMax(): number | undefined {
  const raw = $('catalog_max').value;
  const number = Number(raw);
  if (!raw || !isFinite(number) || number <= 0) return undefined;
  return Math.floor(number);
}

function catalogIncludeKnown(): boolean {
  const el = document.getElementById('catalog_include_known') as any;
  return !!el && !!el.checked;
}

function catalogAction(action: string, extra: any, callback?: (data: any) => void): void {
  const payload: any = { action, confirm: true, includeKnown: catalogIncludeKnown() };
  if (extra && extra.max !== undefined) payload.max = extra.max;
  if (extra && extra.bucket !== undefined) payload.bucket = extra.bucket;
  if (extra && extra.serviceIds !== undefined) payload.serviceIds = extra.serviceIds;
  setCatalogFeedback('Executando ' + action + '…', 'warn');
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((data: any) => {
      // `ok:false` é indisponibilidade (ex.: conta do operador desligada no
      // .env), devolvida como 200: feedback de ERRO com o motivo — o verde
      // "concluída" escondia a falha do operador.
      if (data && !data.ok) {
        setCatalogFeedback('Ação ' + action + ' indisponível: ' + bucketError(data), 'error');
      } else {
        setCatalogFeedback('Ação ' + action + ' concluída.', 'ok');
      }
      // O render fica ISOLADO do resultado da ação: uma falha ao desenhar não
      // pode ser reportada como "ação não concluída" quando o servidor já
      // executou (a auditoria chega a gravar evidência antes de a tela quebrar).
      if (callback) {
        try {
          callback(data);
        } catch (renderError: any) {
          setCatalogFeedback('Ação ' + action + ' concluída, mas a tela falhou: ' + valueText(renderError && renderError.message ? renderError.message : renderError), 'warn');
        }
      }
      hooks.call('loadStatus');
    })
    .catch((error: any) => { setCatalogFeedback('Ação não concluída: ' + valueText(error && error.message ? error.message : error), 'error'); });
}

/**
 * Resultado das ações que MUTAM (auditoria e os dois apply): elas devolvem
 * contadores próprios, nunca um relatório. Mostra o que a ação fez e recarrega o
 * relatório do servidor, que é quem sabe o estado novo do catálogo.
 */
function renderCatalogOutcome(data: any): void {
  if (!data || !data.ok) { empty($('catalog_report'), bucketError(data)); return; }
  const partes: string[] = [];
  if (data.missing !== undefined) partes.push('ignorados: ' + valueText(data.missing));
  if (data.active !== undefined) partes.push('baixando (pulados): ' + valueText(data.active));
  if (data.requeued !== undefined) partes.push('reenfileirados: ' + valueText(data.requeued));
  if (data.keptWithEvidence !== undefined) partes.push('com evidência viva: ' + valueText(data.keptWithEvidence));
  if (data.scanned !== undefined) partes.push('auditados: ' + valueText(data.scanned));
  if (data.evidenced !== undefined) partes.push('com evidência: ' + valueText(data.evidenced));
  if (data.total !== undefined) partes.push('alvos: ' + valueText(data.total));
  if (data.deleted !== undefined) partes.push('apagados: ' + valueText(data.deleted));
  if (data.failed !== undefined) partes.push('falhas: ' + valueText(data.failed));
  if (data.falhas !== undefined) partes.push('falhas: ' + valueText(data.falhas));
  setCatalogFeedback(partes.length ? partes.join(' · ') : 'Ação concluída.', 'ok');
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'catalog-report', confirm: true, includeKnown: catalogIncludeKnown() }),
  })
    .then((relatorio: any) => { renderCatalogReport(relatorio); })
    .catch(() => { /* o resumo acima já informou; relatório recarrega no próximo clique */ });
}

export function runCatalogScan(): void { catalogAction('catalog-scan', {}, renderCatalogReport); }
export function runCatalogReport(): void { catalogAction('catalog-report', {}, renderCatalogReport); }
export function runCatalogAudit(): void { catalogAction('audit-backfill', { max: catalogMax() }, renderCatalogOutcome); }
export function runCatalogRequeue(): void { catalogAction('audit-requeue', { max: catalogMax() }, renderCatalogOutcome); }
export function runCatalogList(): void {
  const sel = document.getElementById('catalog_bucket') as any;
  catalogAction('catalog-list', { bucket: sel ? sel.value : '', max: catalogMax() }, renderCatalogManual);
}
export function runCatalogManualDelete(): void {
  const ids = catalogPicked();
  if (!ids.length) { setCatalogFeedback('Selecione ao menos um magnet.', 'warn'); return; }
  if (!window.confirm('Apagar ' + ids.length + ' magnet(s) da conta? A ação é irreversível.')) return;
  catalogAction('manual-delete', { serviceIds: ids }, (data: any) => {
    renderCatalogOutcome(data);
    runCatalogList();
  });
}
export function runCatalogDedupPreview(): void { catalogAction('dedup-preview', {}, renderCatalogDedup); }
export function runCatalogDedupApply(): void {
  if (!window.confirm('Confirmar a deduplicação (apagar os duplicados do catálogo)?')) return;
  catalogAction('dedup-apply', { max: catalogMax() }, renderCatalogOutcome);
}
export function runCatalogCleanupPreview(): void { catalogAction('cleanup-preview', {}, renderCatalogDedup); }
export function runCatalogCleanupApply(): void {
  if (!window.confirm('Confirmar a limpeza BR (apagar o estrangeiro provado do catálogo)?')) return;
  catalogAction('cleanup-apply', { max: catalogMax() }, renderCatalogOutcome);
}
