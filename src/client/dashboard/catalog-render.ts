/* Adom Power-Movie — /dashboard: render do catálogo (C3, ESM). Extraído de
 * catalog.ts para respeitar o teto de 400 linhas: relatório, duplicados, linhas
 * e a seleção manual. Nada toca o DOM no import. */

import { $, valueText } from './core.js';
import { clear, element, empty, formatBytes, titleText } from './render.js';

export const CATALOG_BUCKETS = ['dub', 'dual', 'pt', 'lixo'];

export function setCatalogFeedback(text: string, kind?: string): void {
  const node = $('catalog_feedback');
  node.className = 'feedback' + (kind ? ' ' + kind : '');
  node.textContent = text || '';
}

export function bucketLabel(bucket: string): string {
  if (bucket === 'dub') return 'Dublado';
  if (bucket === 'dual') return 'Dual';
  if (bucket === 'pt') return 'Português';
  if (bucket === 'lixo') return 'Lixo / indefinido';
  return titleText(bucket);
}

export function bucketError(data: any): string {
  let motivo = valueText((data && (data.reason || data.error || data.message)) || 'indisponível');
  // O hint do backend traz o conserto (ex.: chave do operador desativada no
  // .env). valueText/createTextNode escapam — nada de innerHTML aqui.
  if (data && data.hint) motivo += ' — ' + valueText(data.hint);
  return motivo;
}

function buildBucketTable(report: any): any {
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const body = document.createElement('tbody');
  const hr = document.createElement('tr');
  const headCells = ['Balde', 'Magnets', 'Bytes'];
  for (let i = 0; i < headCells.length; i += 1) {
    const th = document.createElement('th');
    th.textContent = headCells[i];
    if (i > 0) th.className = 'num';
    hr.appendChild(th);
  }
  head.appendChild(hr);
  table.className = 'catalog-table';
  table.appendChild(head);
  const buckets = report.byBucket || {};
  for (let i = 0; i < CATALOG_BUCKETS.length; i += 1) {
    const bucket = CATALOG_BUCKETS[i];
    const meta = buckets[bucket] || { count: 0, bytes: 0 };
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.className = 'label';
    tdName.textContent = bucketLabel(bucket);
    const tdCount = document.createElement('td');
    tdCount.className = 'num';
    tdCount.textContent = String(meta.count);
    const tdBytes = document.createElement('td');
    tdBytes.className = 'num';
    tdBytes.textContent = formatBytes(meta.bytes);
    tr.appendChild(tdName); tr.appendChild(tdCount); tr.appendChild(tdBytes);
    body.appendChild(tr);
  }
  table.appendChild(body);
  return table;
}

/** "Rótulo <b>valor</b>" do resumo. Sem innerHTML: o valor vem da rede. */
function catalogStat(label: string, value: any): any {
  const wrap = document.createElement('span');
  wrap.appendChild(document.createTextNode(label + ' '));
  const forte = document.createElement('b');
  forte.textContent = valueText(value);
  wrap.appendChild(forte);
  return wrap;
}

function cachedPills(report: any): any {
  const keys = ['hit', 'miss', 'blocked', 'unknown'];
  // `byCached` some quando a resposta não é um relatório (audit-backfill,
  // dedup-apply e cleanup-apply devolvem contadores próprios). Sem o default o
  // acesso `undefined["hit"]` estourava DENTRO do .then() e o .catch() do
  // catalogAction reportava "Ação não concluída" para uma ação que rodou.
  const cached = report.byCached || {};
  const wrap = document.createElement('div');
  for (let i = 0; i < keys.length; i += 1) {
    wrap.appendChild(element('span', 'catalog-pill', '⚡ ' + keys[i] + ': ' + valueText(cached[keys[i]])));
  }
  return wrap;
}

export function renderCatalogReport(data: any): void {
  const out = $('catalog_report');
  clear(out);
  if (!data || !data.ok) { empty(out, bucketError(data)); return; }
  const report = data.report || {};
  const resumo = element('div', 'catalog-summary', '');
  resumo.appendChild(catalogStat('Magnets', report.magnets));
  resumo.appendChild(catalogStat('Prontos', report.ready));
  resumo.appendChild(catalogStat('Obras conhecidas', report.works && report.works.known));
  resumo.appendChild(catalogStat('Desconhecidas', report.works && report.works.unknown));
  out.appendChild(resumo);
  out.appendChild(cachedPills(report));
  out.appendChild(buildBucketTable(report));
  out.appendChild(element('p', 'catalog-totals', 'Totais: ' + valueText(report.totals && report.totals.count) + ' magnets · ' + formatBytes(report.totals && report.totals.bytes)));
}

function countKills(plan: any): number {
  let total = 0;
  for (let i = 0; i < plan.t1.length; i += 1) total += plan.t1[i].kill.length;
  for (let i = 0; i < plan.t2.length; i += 1) total += plan.t2[i].kill.length;
  return total;
}

function dedupKills(plan: any): any[] {
  const out: any[] = [];
  for (let i = 0; i < plan.t1.length; i += 1) {
    for (let j = 0; j < plan.t1[i].kill.length; j += 1) out.push(plan.t1[i].kill[j]);
  }
  for (let i = 0; i < plan.t2.length; i += 1) {
    for (let j = 0; j < plan.t2[i].kill.length; j += 1) out.push(plan.t2[i].kill[j]);
  }
  return out;
}

export function renderCatalogDedup(data: any): void {
  const out = $('catalog_dedup_preview');
  clear(out);
  if (!data || !data.ok) { empty(out, bucketError(data)); return; }
  if (data.plan) {
    out.appendChild(element('div', 'catalog-summary', 'Grupos T1 (mesmo hash): ' + valueText(data.plan.t1.length) + ' · Grupos T2 (mesmo arquivo): ' + valueText(data.plan.t2.length) + ' · Alvos: ' + valueText(countKills(data.plan))));
    renderCatalogRows(dedupKills(data.plan));
  } else if (data.targets) {
    out.appendChild(element('div', 'catalog-summary', 'Alvos da limpeza: ' + valueText(data.targets.length)));
    const skipped = data.skipped || {};
    out.appendChild(element('p', 'catalog-skips', 'Pulados — protegidos: ' + valueText(skipped.protected) + ' · ativos: ' + valueText(skipped.active) + ' · jovens: ' + valueText(skipped.young) + ' · não condenados: ' + valueText(skipped.notCondemned) + ' · preexistentes: ' + valueText(skipped.known)));
    renderCatalogRows(data.targets);
  } else {
    out.appendChild(element('div', '', 'Ação concluída.'));
  }
}

function renderCatalogRows(rows: any[]): void {
  const out = $('catalog_targets');
  clear(out);
  if (!rows.length) { empty(out, 'Sem alvos.'); return; }
  const top = rows.slice(0, 10);
  for (let i = 0; i < top.length; i += 1) {
    const target = top[i] || {};
    const row = document.createElement('div');
    row.className = 'catalog-target-row';
    row.appendChild(element('span', 'hash', String(target.hash || '?').slice(0, 8)));
    row.appendChild(element('span', 'size', formatBytes(target.size)));
    row.appendChild(element('span', 'catalog-tag ' + (target.reason === 'manual' ? 'none' : 'foreign'), target.ready ? 'pronto' : '—'));
    const nome = element('span', 'name', titleText(target.filename || ''));
    if (target.known) nome.appendChild(element('span', 'catalog-flag', '(preexistente)'));
    nome.title = String(target.filename || '');
    row.appendChild(nome);
    out.appendChild(row);
  }
}

/**
 * Lista para escolha manual: uma linha por magnet, com checkbox. O `data-id`
 * carrega o service_id, que é o que a ação manual-delete envia — o filename é
 * só rótulo e nunca identifica a linha.
 */
export function renderCatalogManual(data: any): void {
  const out = $('catalog_manual');
  clear(out);
  // Já sem checkboxes no DOM: zera o resumo antes de qualquer saída curta.
  refreshCatalogSelection();
  if (!data || !data.ok) { empty(out, bucketError(data)); return; }
  const rows = data.rows || [];
  if (!rows.length) { empty(out, 'Nenhuma linha neste balde.'); return; }
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] || {};
    const line = document.createElement('label');
    line.className = 'catalog-target-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'catalog-pick';
    box.setAttribute('data-id', String(r.serviceId));
    box.setAttribute('data-size', String(r.size || 0));
    // Download em curso o servidor pula de qualquer jeito; desabilitar aqui
    // evita o operador achar que selecionou algo que vai sair.
    if (r.active) { box.disabled = true; }
    line.appendChild(box);
    line.appendChild(element('span', 'size', formatBytes(r.size)));
    line.appendChild(catalogTag(r));
    const nome = element('span', 'name', titleText(r.filename || ''));
    if (r.active) nome.appendChild(element('span', 'catalog-flag', '(baixando)'));
    if (r.protected) nome.appendChild(element('span', 'catalog-flag', '(protegido)'));
    nome.title = String(r.filename || '');
    line.appendChild(nome);
    out.appendChild(line);
  }
  // Lista nova zera o resumo: os checkboxes antigos saíram do DOM.
  refreshCatalogSelection();
}

/**
 * Badge do veredito. Vermelho só quando há prova de estrangeiro, verde só quando
 * há prova PT — a mesma assimetria do foreignVerdict no servidor. "sem prova" é
 * cinza de propósito: é ignorância, não permissão.
 */
function catalogTag(r: any): any {
  if (r.foreignProof) return element('span', 'catalog-tag foreign', 'estrangeiro');
  if (r.ptProof) return element('span', 'catalog-tag pt', 'PT');
  return element('span', 'catalog-tag none', valueText(r.bucket));
}

export function catalogBoxes(): any {
  return document.querySelectorAll('#catalog_manual .catalog-pick');
}

export function catalogPicked(): string[] {
  const nodes = catalogBoxes();
  const ids: string[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].checked) ids.push(nodes[i].getAttribute('data-id'));
  }
  return ids;
}

/**
 * Resumo da seleção. Mostra o TAMANHO junto porque a ação seguinte é
 * irreversível: "12 selecionados" não diz se são 2 GB ou 2 TB.
 */
export function refreshCatalogSelection(): void {
  const nodes = catalogBoxes();
  const alvo = $('catalog_selection');
  let marcados = 0;
  let bytes = 0;
  let elegiveis = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].disabled) continue;
    elegiveis += 1;
    if (nodes[i].checked) {
      marcados += 1;
      bytes += Number(nodes[i].getAttribute('data-size')) || 0;
    }
  }
  if (alvo) {
    alvo.textContent = marcados
      ? marcados + ' de ' + elegiveis + ' selecionados · ' + formatBytes(bytes)
      : 'nada selecionado';
  }
  const botao = $('catalogSelectAllBtn');
  if (botao) botao.textContent = (elegiveis > 0 && marcados === elegiveis) ? 'Limpar seleção' : 'Selecionar todos';
}

/** Marca tudo que dá para apagar; se já está tudo marcado, limpa. */
export function toggleCatalogSelectAll(): void {
  const nodes = catalogBoxes();
  let elegiveis = 0;
  let marcados = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].disabled) continue;
    elegiveis += 1;
    if (nodes[i].checked) marcados += 1;
  }
  // Download em curso fica de fora: o checkbox está desabilitado e o servidor o
  // pularia de qualquer forma.
  const ligar = marcados < elegiveis;
  for (let i = 0; i < nodes.length; i += 1) {
    if (!nodes[i].disabled) nodes[i].checked = ligar;
  }
  refreshCatalogSelection();
}
