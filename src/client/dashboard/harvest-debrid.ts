/* Adom Power-Movie — aba Colhedor / Harvester: Conta de debrid do Colhedor (C3,
 * ESM). Extraído de harvest.ts para respeitar o teto de 400 linhas. Nada toca o
 * DOM no import. */

import { $, authHeaders, basePrefix, isObject, knownServices, valueText } from './core.js';
import { element, formatDate } from './render.js';
import { DashState } from './state.js';
import { hooks } from './hooks.js';
import { debridTestMotivo, debridTestServiceLabel } from './debrid-test.js';

// O snapshot do backend NUNCA ecoa a chave crua; set com key vazio restaura o
// .env; sem RESOLVE_SECRET a gravação é recusada (resolve_secret_required). O
// teste da chave reutiliza o debrid-account-test existente. Capacidades derivadas
// do adaptador (deriveCapabilities): quota-warn onde há accountStatus; aquecimento
// RD é EXCLUSIVO do Real-Debrid. O mapa vem do backend para não duplicar a tabela.
const HD_REASON_LABELS: Record<string, string> = {
  'resolve_secret_required': 'RESOLVE_SECRET ausente no .env',
  'chave-operador-desativada': 'conta de operador desativada no .env',
  'servico-desconhecido': 'serviço desconhecido',
  'chave-invalida': 'chave inválida',
};
const HD_CAPS_BY_SERVICE: Record<string, any> = {};
let harvestDebridSelectSynced = false;

export function fillHarvestDebridServices(): void {
  const select = $('harvestDebridService');
  if (!select) return;
  select.textContent = '';
  for (let i = 0; i < knownServices.length; i += 1) {
    const option = document.createElement('option');
    option.value = knownServices[i].id;
    option.textContent = knownServices[i].label;
    select.appendChild(option);
  }
}

function harvestDebridCapabilityChip(ok: boolean, label: string): any {
  return element('span', 'catalog-tag ' + (ok ? 'pt' : 'none'), label + ': ' + (ok ? 'sim' : 'não'));
}

// Prévia das capacidades do serviço ESCOLHIDO, antes de salvar. Deriva do mapa do
// backend; serviço sem registro (ou mapa ainda não carregado) cai no seguro "não"
// — nunca inventa capacidade.
export function updateHarvestDebridCaps(): void {
  const box = $('harvestDebridCaps');
  if (!box) return;
  const caps = HD_CAPS_BY_SERVICE[String($('harvestDebridService').value || '')] || null;
  box.textContent = '';
  if (!caps) { box.appendChild(element('span', 'catalog-tag none', 'capacidades: aguardando status')); return; }
  box.appendChild(harvestDebridCapabilityChip(caps.quotaWarn === true, 'quota-warn'));
  box.appendChild(harvestDebridCapabilityChip(caps.brWarm === true, 'aquecimento RD'));
}

function harvestDebridStat(label: string, value: any): any {
  const wrap = element('span', '', label + ' ');
  wrap.appendChild(element('b', '', valueText(value)));
  return wrap;
}

function harvestDebridSourceLabel(source: string | null | undefined): string {
  return source === 'panel' ? 'painel (override)' : source === 'env' ? '.env' : 'nenhuma conta';
}

function setHarvestDebridFeedback(text: string, kind?: string): void {
  const el = $('harvestDebridFeedback');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'feedback' + (kind ? ' ' + kind : '');
}

function readHarvestDebridKey(): string {
  const input = $('harvestDebridKey');
  return input ? String(input.value || '').replace(/^\s+|\s+$/g, '') : '';
}

// A chave sai do input em TODO desfecho: retê-la no DOM depois de testar ou
// salvar não tem valor (mesma regra do teste de conta da Geral).
function clearHarvestDebridKey(): void {
  const input = $('harvestDebridKey');
  if (input) input.value = '';
}

// requestJson do core só propaga error.message; o 400 do set carrega reason/fix.
// Wrapper local preserva o corpo inteiro, sem tocar o core.
function harvestDebridRequest(action: string, body: any): Promise<{ ok: boolean; status: number; data: any }> {
  return fetch(basePrefix() + '/dashboard-action.json', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  }).then((response) => response.json().then((data: any) => ({ ok: response.ok && !!data && data.ok !== false, status: response.status, data })));
}

export function renderHarvestDebridAccount(account: any, resolved: any): void {
  const box = $('harvestDebridStatus');
  if (!box) return;
  const a = isObject(account) ? account : {};
  const caps = isObject(a.capabilities) ? a.capabilities : {};
  // Alimenta o mapa de capacidades do backend (evita a tabela duplicada no
  // front); preserva entradas já conhecidas se o snapshot vier sem o mapa.
  const byService = isObject(a.capabilitiesByService) ? a.capabilitiesByService : null;
  if (byService) {
    for (const capKey of Object.keys(byService)) HD_CAPS_BY_SERVICE[capKey] = byService[capKey];
  }
  box.textContent = '';
  box.appendChild(harvestDebridStat('Origem', harvestDebridSourceLabel(a.source)));
  box.appendChild(harvestDebridStat('Serviço', a.service ? debridTestServiceLabel(a.service) : '—'));
  box.appendChild(harvestDebridStat('Chave', a.keySet ? '•••• ' + valueText(a.last4) : 'não definida'));
  if (a.fingerprint) box.appendChild(harvestDebridStat('Impressão digital', a.fingerprint));
  box.appendChild(harvestDebridStat('Gravada', a.source === 'panel' && a.updatedAt ? formatDate(a.updatedAt) : '—'));
  box.appendChild(harvestDebridStat('quota-warn', caps.quotaWarn === true ? 'sim' : 'não'));
  box.appendChild(harvestDebridStat('aquecimento RD', caps.brWarm === true ? 'sim' : 'não'));
  box.appendChild(harvestDebridStat('Quota-warn usa', resolved ? debridTestServiceLabel(resolved) : a.source === 'env' ? debridTestServiceLabel(a.envService || a.service) : '—'));
  // Selo órfão (RESOLVE_SECRET rotacionado/alterado): a conta do painel está
  // gravada mas a chave não abre, e as features de fundo estão desligadas de
  // propósito. Aviso explícito, não só "chave não definida".
  const warn = $('harvestDebridSealWarn');
  if (warn) {
    if (a.source === 'panel' && a.sealBroken) {
      warn.className = 'pause-banner visible';
      $('harvestDebridSealWarnText').textContent = 'A conta do Colhedor está gravada, mas a chave não abre (RESOLVE_SECRET foi alterado). Quota-warn e aquecimento RD estão DESLIGADOS. Restaure o .env ou salve a chave novamente.';
    } else {
      warn.className = 'pause-banner';
    }
  }
  // O select abre no serviço da conta atual UMA vez; depois é escolha do
  // operador — o polling não pode brigar com a seleção em andamento.
  const select = $('harvestDebridService');
  if (select && !harvestDebridSelectSynced && a.service) { select.value = a.service; harvestDebridSelectSynced = true; updateHarvestDebridCaps(); }
}

function harvestDebridGate(): boolean {
  if (!DashState.token) { setHarvestDebridFeedback('Informe o token de diagnóstico antes de usar a conta do Colhedor.', 'error'); if ($('token')) $('token').focus(); return false; }
  if (!$('harvestDebridService').value) { setHarvestDebridFeedback('Escolha o serviço da conta.', 'warn'); return false; }
  return true;
}

export function testHarvestDebridKey(button?: any): void {
  const service = String($('harvestDebridService').value || '');
  const key = readHarvestDebridKey();
  if (!key) { setHarvestDebridFeedback('Cole a chave de API para testar.', 'warn'); return; }
  if (!harvestDebridGate()) return;
  if (button) button.disabled = true;
  setHarvestDebridFeedback('Testando chave no ' + debridTestServiceLabel(service) + '…', 'warn');
  harvestDebridRequest('debrid-account-test', { action: 'debrid-account-test', service, key }).then((out) => {
    clearHarvestDebridKey();
    const data = out.data || {};
    const output = $('harvestDebridOutput');
    if (output) { output.className = 'test-output ' + (data.ok ? 'ok' : 'error'); output.textContent = debridTestServiceLabel(service) + ' · ' + (data.ok ? 'OK · chave aceita pelo serviço' : 'Falhou · ' + debridTestMotivo(data)); }
    setHarvestDebridFeedback(data.ok ? 'Chave aceita pelo serviço.' : 'Teste sem sucesso: ' + debridTestMotivo(data), data.ok ? 'ok' : 'error');
  }).catch((err: any) => { clearHarvestDebridKey(); setHarvestDebridFeedback('Teste não concluído: ' + valueText(err && err.message ? err.message : err), 'error'); }).then(() => { if (button) button.disabled = false; });
}

function harvestDebridSet(key: string, button?: any): void {
  const service = String($('harvestDebridService').value || '');
  if (!harvestDebridGate()) return;
  if (button) button.disabled = true;
  setHarvestDebridFeedback(key ? 'Salvando a conta do Colhedor…' : 'Restaurando a conta do .env…', 'warn');
  // key vazio é o caminho de RESTAURAR o .env no contrato do backend.
  harvestDebridRequest('harvester-debrid-set', { action: 'harvester-debrid-set', service, key }).then((out) => {
    clearHarvestDebridKey();
    const data = out.data || {};
    if (!out.ok) { setHarvestDebridFeedback('Conta não salva — ' + (HD_REASON_LABELS[data.reason] || valueText(data.reason)) + '. Como corrigir: ' + valueText(data.fix), 'error'); return; }
    renderHarvestDebridAccount(data.config, null);
    setHarvestDebridFeedback(key ? 'Conta de fundo do Colhedor salva: a chave foi cifrada e não volta à tela.' : 'Conta restaurada do .env; override do painel removido.', 'ok');
    hooks.call('loadStatus');
  }).catch((err: any) => { clearHarvestDebridKey(); setHarvestDebridFeedback('Ação não concluída: ' + valueText(err && err.message ? err.message : err), 'error'); }).then(() => { if (button) button.disabled = false; });
}

export function saveHarvestDebrid(button?: any): void {
  const key = readHarvestDebridKey();
  if (!key) { setHarvestDebridFeedback('Cole a chave de API, ou use Restaurar .env para voltar à conta do .env.', 'warn'); return; }
  harvestDebridSet(key, button);
}

export function resetHarvestDebrid(button?: any): void {
  if (!window.confirm('Restaurar a conta de debrid do Colhedor ao .env? O override salvo no painel será removido.')) return;
  harvestDebridSet('', button);
}
