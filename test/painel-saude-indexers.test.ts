// Bloco de indexadores da aba Saúde: modelo puro (contadores/ordenação),
// variante de badge compartilhada, render dos chips e o teste de UM indexador
// pela mesma rota do diagnóstico. Sem DOM e sem rede (fetch dublado).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  indexerRows,
  indexerSummary,
  indexerCardBadge,
  indexerStateLabel,
  indexerStateVariant,
  debridInfo,
  saudeVerdict,
} from '../src/client/painel/saude-model.js';
import { statusVariant } from '../src/client/painel/kit.js';
import { ViewSaude } from '../src/client/painel/view-saude.js';
import { ViewDiagnosticoIndexer } from '../src/client/painel/view-diagnostico-indexer.js';
import { fetchTestIndexer } from '../src/client/painel/api.js';
import { VITAL_BLOCKS } from '../src/client/painel/poll.js';
import { h } from '../src/client/painel/vendor/preact.js';
import { stubFetch } from './helpers/stub.js';

/** Expande componentes de função (sem hooks) e devolve só os VNodes de
 * elemento — é como a asserção enxerga os chips renderizados. */
function expand(node: any): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (n == null || n === false || n === true) return;
    if (Array.isArray(n)) {
      for (const item of n) walk(item);
      return;
    }
    if (typeof n !== 'object') return;
    if (typeof n.type === 'function') {
      walk(n.type(n.props || {}));
      return;
    }
    out.push(n);
    walk(n.props?.children);
  };
  walk(node);
  return out;
}

function textOf(node: any): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return textOf(node.type(node.props || {}));
    return textOf(node.props?.children);
  }
  return '';
}

function chipButtons(vnode: any): any[] {
  return expand(vnode).filter((n) => n.type === 'button' && String(n.props?.class || '').includes('painel-chip'));
}

test('indexerRows ordena falha-primeiro e desconhecido por último', () => {
  const rows = indexerRows([
    { id: 'z-online', label: 'Online', status: { state: 'online', ms: 100 } },
    { id: 'y-unknown', label: 'Sem status' },
    { id: 'b-slow', label: 'Lento', status: { state: 'slow' } },
    { id: 'a-offline', label: 'Offline', status: { state: 'offline' } },
    { id: 'c-degraded', label: 'Degradado', status: { state: 'degraded' } },
    null,
    {},
    'texto',
  ]);

  assert.deepEqual(rows.map((r) => r.id), ['a-offline', 'b-slow', 'c-degraded', 'z-online', 'y-unknown']);
  assert.deepEqual(rows.map((r) => r.state), ['offline', 'slow', 'degraded', 'online', null]);

  const unknown = rows[4];
  assert.equal(unknown.stateLabel, 'DESCONHECIDO');
  assert.equal(unknown.variant, 'neutral');
  assert.equal(unknown.ms, null);
  assert.equal(unknown.breakerState, null);
});

test('normaliza status aninhado, ms, BR e breaker aberto', () => {
  const rows = indexerRows([
    {
      id: 'nerdfilmes',
      label: 'NerdFilmes',
      isBr: true,
      status: { state: 'offline', ms: null, checkedAt: '2026-09-16T00:00:00.000Z' },
      breaker: { tripped: true, state: 'aberto', cooldownRemainingMs: 60000 },
    },
  ]);
  const row = rows[0];
  assert.equal(row.isBr, true);
  assert.equal(row.state, 'offline');
  assert.equal(row.stateLabel, 'OFFLINE');
  assert.equal(row.variant, 'err');
  assert.equal(row.ms, null, 'sem medição não inventa 0');
  assert.equal(row.breakerOpen, true);
  assert.equal(row.breakerState, 'aberto');
  assert.equal(row.cooldownRemainingMs, 60000);
  assert.equal(row.checkedAt, '2026-09-16T00:00:00.000Z');
  // Aceita o estado FLAT (defensivo) e ignora estado fora da allowlist.
  assert.equal(indexerRows([{ id: 'x', state: 'online' }])[0].state, 'online');
  assert.equal(indexerRows([{ id: 'x', status: { state: 'bizarro' } }])[0].state, null);
});

test('indexerSummary conta estados e trata degraded como atenção', () => {
  const rows = indexerRows([
    { id: 'a', status: { state: 'online' } },
    { id: 'b', status: { state: 'slow' } },
    { id: 'c', status: { state: 'degraded' } },
    { id: 'd', status: { state: 'offline' } },
    { id: 'e', status: null },
    { id: 'f', isBr: true, status: { state: 'offline' } },
    { id: 'g', status: { state: 'offline' }, breaker: { tripped: true } },
  ]);
  const s = indexerSummary(rows);

  assert.equal(s.total, 7);
  assert.equal(s.online, 1);
  assert.equal(s.slow, 1);
  assert.equal(s.degraded, 1);
  assert.equal(s.offline, 3);
  assert.equal(s.unknown, 1);
  assert.equal(s.attention, 5, 'slow + degradado + offline');
  assert.equal(s.breakerOpen, 1);
  assert.equal(s.brOffline, 1, 'só BR offline conta no alerta de dublado');

  assert.equal(indexerStateLabel('degraded'), 'DEGRADADO', 'rótulo fiel, não vira offline');
  assert.equal(indexerStateVariant('degraded'), 'warn');
  assert.equal(indexerStateVariant(null), 'neutral');
  assert.deepEqual(indexerSummary([]), {
    total: 0, online: 0, slow: 0, degraded: 0, offline: 0, unknown: 0,
    attention: 0, breakerOpen: 0, brOffline: 0,
  });
});

test('indexerCardBadge prioriza offline e marca atenção quando degradado', () => {
  assert.deepEqual(indexerCardBadge(indexerSummary([])), { text: 'SEM CATÁLOGO', variant: 'neutral' });

  const online = indexerSummary(indexerRows([{ id: 'a', status: { state: 'online' } }]));
  assert.deepEqual(indexerCardBadge(online), { text: 'TODOS ONLINE', variant: 'ok' });

  const degraded = indexerSummary(indexerRows([{ id: 'a', status: { state: 'degraded' } }]));
  assert.deepEqual(indexerCardBadge(degraded), { text: '1 EM ATENÇÃO', variant: 'warn' });

  const mixed = indexerSummary(indexerRows([
    { id: 'a', status: { state: 'offline' } },
    { id: 'b', status: { state: 'slow' } },
  ]));
  assert.deepEqual(indexerCardBadge(mixed), { text: '1 OFFLINE', variant: 'err' });

  const slowOnly = indexerSummary(indexerRows([{ id: 'a', status: { state: 'slow' } }]));
  assert.deepEqual(indexerCardBadge(slowOnly), { text: '1 EM ATENÇÃO', variant: 'warn' });
});

test('indexerCardBadge nunca afirma saúde não medida (desconhecido não vira ONLINE)', () => {
  // Catálogo inteiro sem medição: o achado MÉDIO da revisão. Antes saía
  // "TODOS ONLINE"/ok, afirmando saúde que ninguém mediu.
  const allUnknown = indexerSummary(indexerRows([
    { id: 'a' },
    { id: 'b', status: null },
    { id: 'c', breaker: { tripped: false, state: 'naomedido' } },
  ]));
  assert.equal(allUnknown.online, 0);
  assert.equal(allUnknown.unknown, 3);
  assert.deepEqual(indexerCardBadge(allUnknown), { text: 'SEM MEDIÇÃO', variant: 'neutral' });

  // Misto com medição positiva: pode ficar ok, mas o texto não pode dizer
  // "TODOS" — o desconhecido não é promovido a online por omissão.
  const mixed = indexerSummary(indexerRows([
    { id: 'a', status: { state: 'online' } },
    { id: 'b', status: { state: 'online' } },
    { id: 'c' },
  ]));
  assert.equal(mixed.online, 2);
  assert.equal(mixed.unknown, 1);
  assert.deepEqual(indexerCardBadge(mixed), { text: '2 ONLINE', variant: 'ok' });

  // Falha continua mandando mesmo com desconhecidos presentes.
  const withOffline = indexerSummary(indexerRows([
    { id: 'a', status: { state: 'offline' } },
    { id: 'b' },
  ]));
  assert.deepEqual(indexerCardBadge(withOffline), { text: '1 OFFLINE', variant: 'err' });
});

test('statusVariant traduz diagnóstico e indexer sem inventar veredito', () => {
  assert.equal(statusVariant('online'), 'ok');
  assert.equal(statusVariant('slow'), 'warn');
  assert.equal(statusVariant('degraded'), 'warn');
  assert.equal(statusVariant('offline'), 'err');
  assert.equal(statusVariant(null), 'neutral');
  assert.equal(statusVariant(undefined), 'neutral');
  assert.equal(statusVariant('estado-inexistente'), 'neutral');

  // Contrato antigo do diagnóstico segue valendo (a função subiu para o kit).
  assert.equal(statusVariant('ok'), 'ok');
  assert.equal(statusVariant('warn'), 'warn');
  assert.equal(statusVariant('err'), 'err');
  assert.equal(statusVariant('neutral'), 'neutral');
});

test('ViewSaude renderiza um chip por indexador, com badge, BR e circuito', () => {
  const vnode = ViewSaude({
    general: { ok: true, services: {} },
    indexers: [
      { id: 'bludv', label: 'Bludv', isBr: true, status: { state: 'online', ms: 120 }, breaker: { tripped: false, state: 'fechado' } },
      { id: 'nerdfilmes', label: 'NerdFilmes', isBr: true, status: { state: 'offline', ms: null }, breaker: { tripped: true, state: 'aberto', cooldownRemainingMs: 60000 } },
      { id: 'tpb', label: 'TPB', isBr: false, status: null, breaker: { tripped: false, state: 'naomedido' } },
    ],
  });

  const buttons = chipButtons(vnode);
  assert.equal(buttons.length, 3, 'um chip por indexador');

  // Ordenação falha-primeiro também vale para o render.
  const texts = buttons.map((b) => textOf(b));
  assert.match(texts[0], /NerdFilmes/);
  assert.match(texts[0], /OFFLINE/);
  assert.match(texts[0], /BR/);
  assert.match(texts[0], /CIRCUITO/);
  assert.ok(String(buttons[0].props.class).includes('painel-chip-open'), 'circuito aberto destacado');

  assert.match(texts[1], /Bludv/);
  assert.match(texts[1], /ONLINE/);
  assert.match(texts[1], /120\s+ms/, 'o tempo medido aparece no chip');

  assert.match(texts[2], /DESCONHECIDO/);
  assert.doesNotMatch(texts[2], /OFFLINE/, 'status null nunca é pintado como offline');
  assert.ok(!String(buttons[2].props.class).includes('painel-chip-open'));
});

test('ViewSaude sem catálogo mostra o empty state, não chips vazios', () => {
  const vnode = ViewSaude({ general: { ok: true, services: {} } });
  assert.equal(chipButtons(vnode).length, 0);
  const text = textOf(vnode);
  assert.match(text, /Indexadores \(Jackett\)/);
  assert.match(text, /Catálogo de indexadores ainda não carregado/);
});

test('clique no chip entrega o id ao handler', () => {
  let picked: string | null = null;
  const vnode = ViewSaude({
    general: { ok: true, services: {} },
    indexers: [{ id: 'bludv', label: 'Bludv', status: { state: 'online' } }],
    onSelectIndexer: (id: string) => { picked = id; },
  });
  const button = chipButtons(vnode)[0];
  button.props.onClick();
  assert.equal(picked, 'bludv');
});

test('VITAL_BLOCKS carrega indexers para a aba Saúde', () => {
  assert.ok(VITAL_BLOCKS.includes('indexers'), 'sem o bloco o card fica sempre vazio');
});

test('fetchTestIndexer usa GET /test-indexer.json com o token no header', async () => {
  const stub = stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ indexer: 'bludv', ok: true, ms: 210, withMagnet: 2 }),
  }));
  (globalThis as any).window = { location: { pathname: '/painel' } };
  try {
    const res = await fetchTestIndexer('tok', 'bludv');
    if (!res.ok) {
      assert.fail(res.error);
      return;
    }
    assert.equal(res.data.indexer, 'bludv');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, '/test-indexer.json?id=bludv&type=movie');
    assert.equal((stub.calls[0].options as any).headers['X-Indexer-Test-Token'], 'tok');
    assert.equal((stub.calls[0].options as any).cache, 'no-store');
  } finally {
    stub.restore();
    delete (globalThis as any).window;
  }
});

test('fetchTestIndexer surfaceia erro do backend e a série explícita', async () => {
  const stub = stubFetch(() => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'indexador desconhecido' }) }));
  try {
    const res = await fetchTestIndexer('tok', 'nao-existe', { type: 'series' });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 400);
    assert.equal(res.error, 'indexador desconhecido');
    assert.equal(stub.calls[0].url, '/test-indexer.json?id=nao-existe&type=series');
  } finally {
    stub.restore();
  }

  const stub401 = stubFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));
  try {
    const res = await fetchTestIndexer('tok', 'bludv');
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 401);
    assert.match(res.error, /Token inválido/);
  } finally {
    stub401.restore();
  }
});

test('ViewDiagnosticoIndexer recebe o pedido do chip como prop', () => {
  const vnode = h(ViewDiagnosticoIndexer, { request: { id: 'bludv', seq: 3 } });
  assert.equal(vnode.type, ViewDiagnosticoIndexer);
  assert.equal(vnode.props.request.id, 'bludv');
  assert.equal(vnode.props.request.seq, 3);
});

test('wiring: app entrega indexers à Saúde e o pedido do chip ao Diagnóstico', () => {
  const read = (rel: string) => readFileSync(new URL('../../src/client/painel/' + rel, import.meta.url), 'utf8');

  const app = read('app.ts');
  assert.match(app, /indexers=\$\{p\.indexers\}/, 'a Saúde recebe o bloco indexers');
  assert.match(app, /onSelectIndexer=\$\{navigateToIndexer\}/, 'o clique navega');
  assert.match(app, /selectTab\('diagnostico'\)/, 'o destino é a aba Diagnóstico');
  assert.match(app, /indexerRequest=\$\{indexerRequest\}/, 'o pedido chega ao Diagnóstico');

  const saude = read('view-saude.ts');
  assert.match(saude, /from '\.\/saude-model\.js'/, 'a view consome o modelo puro');

  const diag = read('view-diagnostico.ts');
  assert.doesNotMatch(diag, /function DiagnosticoIndexers\b/, 'a seção antiga não ficou inline');
  assert.match(diag, /ViewDiagnosticoIndexer/, 'a seção vive no módulo próprio');

  const indexer = read('view-diagnostico-indexer.ts');
  assert.match(indexer, /fetchTestIndexer/, 'o teste de UM indexador usa a rota dedicada');
  assert.match(indexer, /test-all-indexers/, 'o teste em lote continua disponível');
});

// `sem-debrid` é CONFIGURAÇÃO, não falha: com DEBRID_ALLOW_ENV_KEY=false o
// operador não empresta a própria chave como default, então o painel aberto na
// raiz legitimamente não tem debrid. Antes isso deixava o veredito em "ATENÇÃO
// REQUERIDA" para sempre — um alerta que nunca apaga não é lido por ninguém.
describe('saude: debrid sem chave na requisição não é falha', () => {
  const contaOk = { ok: true, service: 'alldebrid' };
  const semDebrid = {
    active: null,
    account: { ok: false, reason: 'sem-debrid', service: null },
    accounts: { alldebrid: { ok: true, magnets: 831 } },
  };

  test('conta viva continua CONECTADO e o veredito fica verde', () => {
    const info = debridInfo({ active: 'alldebrid', account: { ok: true } }, contaOk);
    assert.equal(info.state, 'conectado');
    assert.equal(info.label, 'CONECTADO');
    assert.equal(info.variant, 'ok');
    assert.equal(saudeVerdict({ ok: true }, { account: { ok: true } }, contaOk).ok, true);
  });

  test('sem-debrid com conta do operador medida ok fica VERDE, com o serviço dela', () => {
    // Produção (DEBRID_ALLOW_ENV_KEY=false + DEBRID_OPERATOR_ENV_ACCOUNT=true):
    // a requisição do painel não traz chave, mas o servidor mediu a conta.
    const info = debridInfo(semDebrid, null);
    assert.equal(info.state, 'operador');
    assert.equal(info.label, 'CONTA DO OPERADOR OK');
    assert.equal(info.variant, 'ok');
    assert.equal(info.service, '—', 'sem service/label na entrada, não inventa nome');
    assert.equal(info.operatorAccount, true);
    const comNome = debridInfo({ ...semDebrid, accounts: { alldebrid: { ok: true, service: 'alldebrid' } } }, null);
    assert.equal(comNome.service, 'alldebrid');
    // Conta do operador que falhou não pinta verde: volta ao neutro.
    const contaCaiu = debridInfo({ ...semDebrid, accounts: { alldebrid: { ok: false, reason: 'auth' } } }, null);
    assert.equal(contaCaiu.state, 'por-instalacao');
    assert.equal(contaCaiu.variant, 'neutral');

    const verdict = saudeVerdict({ ok: true }, semDebrid, null);
    assert.equal(verdict.ok, true, 'escolha de configuração não é alerta');
    assert.equal(verdict.text, 'SISTEMA OPERACIONAL');
  });

  test('falha de verdade continua vermelha e derruba o veredito', () => {
    // Chave recusada/serviço fora: reason é OUTRO, não `sem-debrid`.
    const caiu = { active: 'alldebrid', account: { ok: false, reason: 'chave-invalida' } };
    const info = debridInfo(caiu, null);
    assert.equal(info.state, 'desconectado');
    assert.equal(info.variant, 'err');
    assert.equal(saudeVerdict({ ok: true }, caiu, null).ok, false);
  });

  test('general fora derruba o veredito mesmo com debrid ok', () => {
    assert.equal(saudeVerdict({ ok: false }, { account: { ok: true } }, contaOk).ok, false);
  });

  test('sem accounts, sem-debrid não inventa conta de operador', () => {
    const info = debridInfo({ account: { ok: false, reason: 'sem-debrid' } }, null);
    assert.equal(info.state, 'por-instalacao');
    assert.equal(info.operatorAccount, false);
    assert.equal(info.service, '—', 'serviço ausente não vira nome inventado');
  });
});
