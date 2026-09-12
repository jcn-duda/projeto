/* Adom Power-Movie — /dashboard: evidência de saúde do status (C3, ESM).
 * Extraído de status.ts para respeitar o teto de 400 linhas: coleta as issues
 * do /dashboard-status.json e pinta o banner persistente. Nada toca o DOM no
 * import. */

import { $, first, isObject, valueText } from './core.js';
import { asList, element } from './render.js';

// Pill/banner: evidência da resposta (auth/quota/timeout/catálogo) vira estado
// visível — não esconder ok:false num details (incidente 2026-08-30).
const STATE_RANK: Record<string, number> = { unknown: 0, online: 1, warn: 2, error: 3 };

export function worstState(a: string, b: string): string {
  return (STATE_RANK[a] || 0) >= (STATE_RANK[b] || 0) ? a : b;
}

export function worstIssueState(issues: any[]): string {
  let state = 'online';
  for (let i = 0; i < issues.length; i += 1) state = worstState(state, issues[i].state);
  return state;
}

// auth/quota provam conta INUTILIZÁVEL (erro); rate/timeout/unknown são
// transitórios ou sem prova — atenção, não derrubam o pill a vermelho.
function severityFromReason(reason: any): string {
  const text = String(reason || '');
  return text === 'auth' || text === 'quota' ? 'error' : 'warn';
}

export function reasonText(reason: any): string {
  const labels: Record<string, string> = {
    'auth': 'chave de API recusada pelo serviço', 'quota': 'conta no teto de magnets',
    'rate': 'rate limit do serviço', 'timeout': 'tempo esgotado consultando o serviço',
    'sem-debrid': 'nenhum serviço de debrid configurado', 'sem-conta-operador': 'conta do operador sem chave no .env',
    'chave-operador-desativada': 'uso da conta do operador desligado no .env',
    'sem-adapter-catalogo': 'serviço de debrid não suporta o catálogo',
    'inventario-frio': 'inventário da conta ainda não carregado', 'erro': 'falha ao consultar o serviço',
  };
  return labels[reason] || 'motivo não classificado: ' + valueText(reason);
}

// Texto claro com o motivo e o conserto: `fix` vem da conta de debrid, `hint` do
// gate do catálogo. Dados de rede vão só por textContent/appendChild.
function accountIssue(prefix: string, item: any): any {
  let text = prefix + ': ' + reasonText(item.reason);
  if (item.error) text += ' (' + valueText(item.error) + ')';
  if (item.fix) text += ' · Como corrigir: ' + valueText(item.fix);
  else if (item.hint) text += ' · Como corrigir: ' + valueText(item.hint);
  return { state: severityFromReason(item.reason), text };
}

export function collectStatusIssues(root: any): any[] {
  const issues: any[] = [];
  const services = first(root.general || {}, ['services'], {});
  const debrid = isObject(root.debrid) ? root.debrid : {};
  const account = first(debrid, ['account', 'debridStatus'], {});
  const accounts = first(debrid, ['accounts'], {});
  const catalog = root.catalog;
  let viuDebrid = false;
  if (isObject(account)) {
    if (account.ok === false) {
      // `sem-debrid` é ausência de conta, não evidência detalhada: NÃO marca
      // viuDebrid, senão o aviso genérico de services.debrid=false é engolido.
      if (account.reason !== 'sem-debrid') {
        viuDebrid = true;
        issues.push(accountIssue((account.label || account.service || 'Debrid') + ' (conta ativa)', account));
      }
    } else if (account.warn) {
      viuDebrid = true;
      issues.push({ state: 'warn', text: (account.label || account.service || 'Debrid') + ' (conta ativa): aviso operacional' + (account.reason ? ' — ' + reasonText(account.reason) : '') });
    }
  }
  const keys = Object.keys(isObject(accounts) ? accounts : {});
  for (let i = 0; i < keys.length; i += 1) {
    const item = accounts[keys[i]];
    if (isObject(item)) {
      if (account.service && item.service === account.service) continue;
      // Qualquer conta no espelho é evidência de debrid no operador (mesmo
      // saudável): suprime o aviso genérico sem esconder erro real (o erro/warn
      // da própria conta entra logo abaixo).
      viuDebrid = true;
      if (item.ok === false) {
        issues.push(accountIssue(item.label || item.service || keys[i], item));
      } else if (item.warn) {
        issues.push({ state: 'warn', text: (item.label || item.service || keys[i]) + ': aviso operacional' + (item.reason ? ' — ' + reasonText(item.reason) : '') });
      }
    }
  }
  if (isObject(catalog) && catalog.ok === false) {
    issues.push({ state: 'warn', text: 'Catálogo da conta indisponível: ' + reasonText(catalog.reason) + (catalog.hint ? ' · Como corrigir: ' + valueText(catalog.hint) : '') });
  }
  if (services.addon === false) issues.push({ state: 'error', text: 'O processo do addon reportou-se fora do ar (general.services.addon = false).' });
  if (services.jackett === false) {
    issues.push({ state: 'warn', text: 'Jackett sem catálogo de indexadores; as buscas ficam sem fontes.' });
  } else if (services.jackett === 'naomedido') {
    issues.push({ state: 'warn', text: 'Jackett não medido: catálogo ainda sem prova de rede.' });
  }
  if (services.debrid === false && !viuDebrid) issues.push({ state: 'warn', text: 'Debrid reportado indisponível no geral, sem motivo detalhado; verifique chave e conta.' });
  const indexers = asList(root.indexers, 'indexers');
  let aberto = false;
  for (let i = 0; i < indexers.length; i += 1) {
    const b = indexers[i] && indexers[i].breaker;
    const st = indexers[i] && indexers[i].status;
    if ((st && st.state === 'offline') || indexers[i].online === false) {
      issues.push({ state: 'warn', text: 'Indexador offline: ' + (indexers[i].label || indexers[i].name || indexers[i].id || 'desconhecido') + (st && st.error ? ' (' + st.error + ')' : '') });
    }
    if (b && (b.state === 'aberto' || (!b.state && b.tripped))) aberto = true;
  }
  if (aberto) issues.push({ state: 'warn', text: 'Circuito aberto (breaker) em ao menos um indexador.' });
  const resolvers = asList(root.resolvers, 'resolvers');
  for (let i = 0; i < resolvers.length; i += 1) {
    const r = resolvers[i];
    if (r && (r.ok === false || r.broken || r.status === 'error' || r.online === false || (r.checkedAt && r.results === 0 && r.error))) {
      issues.push({ state: 'warn', text: 'Resolver BR com erro: ' + (r.name || r.label || r.id || 'resolver') + (r.error ? ' (' + r.error + ')' : '') });
    }
  }
  return issues;
}

// Banner persistente: aparece com o pior estado da evidência e SOME SOZINHO
// quando a resposta volta saudável — nunca fica preso de uma rodada anterior.
export function renderStatusBanner(issues: any[]): void {
  const banner = $('statusBanner');
  const text = $('statusBannerText');
  if (!banner || !text) return;
  const worst = worstIssueState(issues);
  text.textContent = '';
  if (worst === 'online') {
    banner.className = 'status-banner';
    return;
  }
  banner.className = 'status-banner visible ' + worst;
  for (let i = 0; i < issues.length; i += 1) {
    text.appendChild(element('p', 'banner-line ' + issues[i].state, issues[i].text));
  }
}
