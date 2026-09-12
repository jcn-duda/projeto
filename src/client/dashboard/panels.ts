/* Adom Power-Movie — /dashboard: painéis da Geral (C3, ESM nativo).
 * renderGeneral, renderDebrid/Sources. O painel do MagnetDB vive em magnets.ts;
 * as abas em nav.ts; o L2/namespace em panels-l2.ts; índice/colhedor em
 * panels-index.ts. Nada toca o DOM no import. */

import { $, copyObject, first, isAmostraCedo, isObject, knownServices, origemOf, own } from './core.js';
import { card, displayValue, element, empty, metric, metricOrigem, renderCollection, renderMetrics, stateLabel } from './render.js';
import { hooks } from './hooks.js';

export function renderGeneral(data: any): void {
  const source = first(data, ['general', 'overview', 'system'], data);
  const metrics = $('generalMetrics');
  const excluded: Record<string, boolean> = { general: true, overview: true, system: true, debrid: true, autofetch: true, indexers: true, indexerStatus: true, resolvers: true, brResolvers: true, cache: true, search: true, _origem: true };
  const uptimeS = isObject(source) ? source.uptimeS : undefined;
  metrics.textContent = '';
  // services.jackett: o banner da Geral já cobre — não redesenhar aqui.
  if (isObject(source) && isObject(source._origem) && uptimeS != null && uptimeS !== '') {
    const keys = Object.keys(source);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (excluded[key]) continue;
      if (source[key] === null || typeof source[key] === 'object') continue;
      const kind = origemOf(source, key);
      if (kind) metricOrigem(metrics, key, displayValue(key, source[key]), kind, uptimeS);
      else metric(metrics, key, source[key]);
    }
    if (!metrics.children.length) empty(metrics, 'Nenhuma métrica disponível.');
  } else {
    renderMetrics(metrics, source, excluded);
  }
  // O total de deadline sozinho sugere que o indexer atrasou a resposta. As
  // causas e a latência de metadata deixam claro quando o orçamento já chegou
  // corroído antes de abrir qualquer provider.
  renderMetrics(metrics, isObject(source.search) ? source.search : {}, { _origem: true });
  // Fase 3.6 do redesign: por hook (general.ts) — panels é folha de desenho e
  // não cita o símbolo global do módulo que o estende.
  hooks.call('renderGeneralDiagnostics', data);
}

// Reconhece serviços pelo id normalizado. `realdebrid`/`debridlink` sem hífen
// já colapsam no replace; o retorno explícito documenta a intenção.
export function serviceId(item: any): string {
  const id = String(first(item, ['id', 'service', 'key', 'name'], '')).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (id === 'realdebrid') return 'realdebrid';
  if (id === 'debridlink') return 'debridlink';
  return id;
}

function serviceData(source: any, id: string): any {
  const list = asAnyList(first(source, ['services', 'adapters', 'accounts'], []), 'services');
  for (let i = 0; i < list.length; i += 1) if (serviceId(list[i]) === id) return list[i];
  return null;
}

// Extrato local de asList para o formato preferido: evita depender do helper
// genérico quando só a chave nomeada importa.
function asAnyList(value: any, preferredKey: string): any[] {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  if (Array.isArray(value[preferredKey])) return value[preferredKey];
  return [];
}

export function renderDebrid(data: any, autofetchData?: any): void {
  const source = isObject(data) ? data : {};
  const auto = isObject(autofetchData) ? autofetchData : first(source, ['autofetch', 'autoFetch', 'autofetchStatus'], {});
  const account = isObject(source.account) ? source.account : {};
  const active = serviceId({ id: source.active || account.service || '' });
  const accounts = isObject(source.accounts) ? source.accounts : {};
  const cards = $('debridCards');
  const metrics = $('debridMetrics');
  const services: any[] = [];
  metrics.textContent = '';
  renderMetrics(metrics, isObject(auto) ? auto : {}, { services: true, perService: true });
  cards.textContent = '';
  for (let i = 0; i < knownServices.length; i += 1) {
    let item = serviceData(source, knownServices[i].id) || { id: knownServices[i].id, label: knownServices[i].label, status: 'unknown' };
    if (active === knownServices[i].id) {
      item = copyObject(item);
      Object.keys(account).forEach((key) => { item[key] = account[key]; });
      item.status = account.ok === true ? (account.warn ? 'warn' : 'online') : 'error';
    }
    if (isObject(accounts[knownServices[i].id])) {
      item = copyObject(item);
      Object.keys(accounts[knownServices[i].id]).forEach((key) => { item[key] = accounts[knownServices[i].id][key]; });
      if (item.ok === false) item.status = item.reason === 'rate' ? 'warn' : 'error';
      // Conta ok em accounts é saudável (ex.: a do operador numa instância
      // pública segura, onde a instalação anônima não tem debrid ativo) — mesmo
      // critério do espelho da conta ativa; sem isto o card da conta saudável
      // ficava em "não medido".
      else if (item.ok === true) item.status = item.warn ? 'warn' : 'online';
    }
    if (!item.label) item.label = knownServices[i].label;
    item.autofetch = first(item, ['autofetch', 'autoFetch'], first(asAnyList(auto, 'services').filter((entry) => serviceId(entry) === knownServices[i].id), ['status', 'state'], null));
    services.push(item);
  }
  asAnyList(first(source, ['services', 'adapters', 'accounts'], []), 'services').forEach((extra) => {
    let found = false;
    for (let i = 0; i < services.length; i += 1) if (serviceId(services[i]) === serviceId(extra)) found = true;
    if (!found) services.push(extra);
  });
  for (let i = 0; i < services.length; i += 1) card(cards, services[i], { fallback: 'serviço' });
}

// Rótulo do breaker no card: state tri-estado (aberto/fechado/naomedido); sem
// state, mantém o binário legado tripped→aberto/fechado. Nunca inferir "fechado"
// de ausência — naomedido vira "não medido" (stateLabel unknown).
export function breakerStateLabel(breaker: any): string {
  const b = isObject(breaker) ? breaker : {};
  if (typeof b.state === 'string') {
    if (b.state === 'aberto') return 'aberto';
    if (b.state === 'fechado') return 'fechado';
    if (b.state === 'naomedido' || b.state === 'unknown') return stateLabel('unknown');
    return stateLabel(b.state);
  }
  return b.tripped ? 'aberto' : 'fechado';
}

// Resolver nunca medido é "nunca medido": o probe de /test-resolver.json vive
// SÓ na memória da instância. Respeita _origem e o AMOSTRA_CEDO_S.
function resolverNeverMeasured(uptimeS: any): string {
  return isAmostraCedo(uptimeS)
    ? 'nunca medido (processo recém-iniciado)'
    : 'nunca medido neste processo';
}

export function resolverCardItem(item: any, uptimeS: any): any {
  const out = copyObject(item);
  let measured = own(item, 'status') || (item.lastMs !== undefined && item.lastMs !== null);
  // _origem explícito de "naomedido" vence o resto: é o servidor declarando que
  // o campo não foi medido neste processo.
  if (origemOf(item, 'lastMs') === 'naomedido') measured = false;
  out.status = measured ? first(item, ['status'], 'unknown') : 'naomedido';
  // O texto "nunca medido" vence qualquer resíduo do item quando o servidor (ou
  // a ausência de status) declara que não houve medição.
  out.lastMs = measured && item.lastMs !== undefined && item.lastMs !== null
    ? item.lastMs
    : (measured ? '—' : resolverNeverMeasured(uptimeS));
  out.lastError = measured && item.lastError !== undefined && item.lastError !== null
    ? item.lastError
    : (measured ? '—' : resolverNeverMeasured(uptimeS));
  return out;
}

export function renderSources(data: any): void {
  const source = isObject(data) ? data : {};
  let indexers = first(source, ['indexers', 'indexerStatus', 'jackett'], []);
  let resolvers = first(source, ['resolvers', 'brResolvers', 'resolverStatus', 'br'], []);
  const uptimeS = first(isObject(source.general) ? source.general : {}, ['uptimeS'], null);
  indexers = asAnyList(indexers, 'indexers').map((item) => {
    const out = copyObject(item);
    const status = isObject(item.status) ? item.status : {};
    const breaker = isObject(item.breaker) ? item.breaker : {};
    out.status = status.state || 'unknown';
    out.latencyMs = status.ms;
    out.checkedAt = status.checkedAt;
    out.failStreak = status.failStreak;
    out.breaker = breakerStateLabel(breaker);
    out.cooldownRemainingMs = breaker.cooldownRemainingMs;
    return out;
  });
  renderCollection($('indexerCards'), indexers, 'indexers', { testable: true });
  const offline = indexers.filter((item: any) => item.breaker === 'aberto').map((item: any) => item.id);
  if (offline.length) {
    const hint = element('p', 'guidance error', 'Circuit breaker aberto: revise estes IDs em JACKETT_INDEXERS: ' + offline.join(', '));
    $('indexerCards').appendChild(hint);
  }
  // Resolvers BR são testáveis (kind resolver): mesmo card, botão e endpoint de
  // teste próprios, decididos dentro de card(). O mapa marca "nunca medido" para
  // o que ainda não passou pelo /test-resolver.json.
  resolvers = asAnyList(resolvers, 'resolvers').map((item: any) => resolverCardItem(item, uptimeS));
  renderCollection($('resolverCards'), resolvers, 'resolvers', { testable: true, kind: 'resolver' });
}
