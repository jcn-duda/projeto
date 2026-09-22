import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewSaude } from '../src/client/painel/view-saude.js';
import { ViewConta } from '../src/client/painel/view-conta.js';
import { ViewGate } from '../src/client/painel/view-gate.js';
import { Card, StatNumber, ProgressBar } from '../src/client/painel/kit.js';
import { ViewColhedor } from '../src/client/painel/view-colhedor.js';
import { ViewSonda } from '../src/client/painel/view-sonda.js';
import { ViewChupim, autoFetchTeto } from '../src/client/painel/view-chupim.js';
import { ViewCache, cacheSummary } from '../src/client/painel/view-cache.js';
import { ViewLimpeza, dedupPreviewSummary, catalogSummary, nextCatalogState } from '../src/client/painel/view-limpeza.js';
import { ViewMagnets, magnetdbSummary, sideStyle, formatTtlRemaining } from '../src/client/painel/view-magnets.js';

/** Texto visível de um VNode já expandido (a função do componente foi chamada
 * direto). Percorre children e também title/badge/label dos componentes do kit —
 * é assim que uma asserção de conteúdo deixa de ser "typeof object". */
function vnodeText(node: any): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(vnodeText).join(' ');
  if (typeof node === 'object') {
    const props = node.props || {};
    return [
      typeof props.title === 'string' ? props.title : '',
      typeof props.badge?.text === 'string' ? props.badge.text : '',
      typeof props.label === 'string' ? props.label : '',
      vnodeText(props.children),
    ].join(' ');
  }
  return '';
}

test('ViewSaude retorna VNode válido com veredito e serviços', () => {
  const vnode = ViewSaude({
    general: {
      ok: true,
      uptimeS: 120,
      services: { jackett: true, debrid: true, resolvers: 6 },
    },
    conta: { ok: true, service: 'alldebrid' },
    searchFirst: { responses: 10, brVisible: 8, brFound: 9, brCached: 8 },
  });

  assert.ok(vnode, 'ViewSaude deve retornar um VNode');
  assert.equal(typeof vnode, 'object');
  assert.ok(vnode.props, 'VNode deve conter props');
});

test('ViewConta não afirma "download preso" a partir da idade global do acervo', () => {
  const text = vnodeText(ViewConta({
    conta: {
      total: 933,
      cap: 1000,
      usagePercent: 93,
      ready: 895,
      downloading: 35,
      dead: 3,
      oldestAt: Date.now() - 57 * 3600 * 1000,
      warnAt: 800,
    },
  }));

  assert.match(text, /Magnet mais antigo há/, 'a idade medida continua visível');
  assert.match(text, /não serve|Não indica/i, 'a idade vem com ressalva explícita');
  assert.doesNotMatch(text, /DOWNLOAD PRESO/, 'sem badge de preso derivado da idade global');
  assert.doesNotMatch(text, /pelo menos 1 download ativo/i, 'sem a inferência falsa removida');
});

test('dedupPreviewSummary lê o contrato real plan.t1/t2 (sem o inexistente scanned)', () => {
  const summary = dedupPreviewSummary({
    ok: true,
    plan: {
      t1: [{ keep: { serviceId: 1 }, kill: [{ serviceId: 2, hash: 'a' }, { serviceId: 3, hash: 'a' }] }],
      t2: [{ keep: { serviceId: 4 }, kill: [{ serviceId: 5, hash: 'b' }] }],
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.t1Groups, 1);
  assert.equal(summary.t2Groups, 1);
  assert.equal(summary.candidates.length, 3);
  assert.equal(summary.candidates[0].group, 'T1 (mesmo hash)');
  assert.equal(summary.candidates[2].group, 'T2 (mesmo arquivo)');
  assert.equal('scanned' in summary, false, 'não inventa o campo que a versão anterior lia');
});

test('dedupPreviewSummary expõe falha do servidor (ok:false, sem plan)', () => {
  const summary = dedupPreviewSummary({ ok: false, reason: 'sem-adapter' });
  assert.equal(summary.ok, false);
  assert.equal(summary.reason, 'sem-adapter');
  assert.deepEqual(summary.candidates, []);
  assert.equal(summary.t1Groups, 0);
});

test('ViewGate renderiza gate com override (999 vs 2000)', () => {
  const vnode = ViewGate({
    gate: {
      autoFetchPauseAt: 999,
      envAutoFetchPauseAt: 2000,
      isAutoFetchPauseAtOverridden: true,
      paused: false,
      diffs: [{ key: 'autoFetchPauseAt', effective: 999, envDefault: 2000 }],
    },
  });

  assert.ok(vnode, 'ViewGate deve retornar um VNode');
  assert.equal(typeof vnode, 'object');
});

test('Componentes do kit (Card, StatNumber, ProgressBar) retornam VNodes', () => {
  const card = Card({ title: 'Teste', badge: { text: 'OK', variant: 'ok' } });
  assert.ok(card && typeof card === 'object');

  const stat = StatNumber({ value: 10, target: 100, label: 'dez' });
  assert.ok(stat && typeof stat === 'object');

  const bar = ProgressBar({ percent: 75, variant: 'ok' });
  assert.ok(bar && typeof bar === 'object');
});

import { h } from '../src/client/painel/vendor/preact.js';

test('ViewColhedor retorna VNode válido com h()', () => {
  const vnode = h(ViewColhedor, {
    harvest: {
      enabled: true,
      paused: false,
      queueDepth: 5,
      queueMax: 100,
      queriesThisHour: 4,
      maxPerHour: 20,
      harvested: 12,
      lastRunAt: new Date().toISOString(),
      queuePreview: [
        { imdbId: 'tt1234567', type: 'movie', reason: 'br-gap', brProbe: true },
      ],
      lastWorks: [
        { at: Date.now(), imdbId: 'tt7654321', type: 'movie', recorded: 3 },
      ],
    },
    metrics: { counters: {} },
  });

  assert.ok(vnode && typeof vnode === 'object');
  assert.equal(vnode.type, ViewColhedor);
  assert.ok(vnode.props);
});

test('ViewSonda renderiza estatísticas da sonda e cobertura F3', () => {
  const vnode = ViewSonda({
    harvest: {
      queuePreview: [
        { imdbId: 'tt1111111', type: 'series', season: 1, episode: 1, brProbe: true },
      ],
    },
    f3: {
      popularCoverage: 0.85,
      brWarmRate: 0.9,
      discoveryRate: 0.95,
    },
    metrics: {
      counters: {
        'autofetch.brProbe.scheduled.evidence': 10,
        'autofetch.brProbe.scheduled.upgrade': 2,
        'autofetch.brProbe.found': 8,
        'autofetch.brProbe.empty': 2,
        'autofetch.brProbe.failed': 1,
        'autofetch.brProbe.capped': 1,
      },
    },
  });

  assert.ok(vnode && typeof vnode === 'object');
  assert.ok(vnode.props);
});

test('ViewChupim retorna VNode válido com h()', () => {
  const vnode = h(ViewChupim, {
    autofetch: {
      paused: false,
      recheckLots: 3,
      settleLots: 1,
      deadBlacklistCount: 2,
      suppressed: 0,
      budget: { used: 4, limit: 15 },
      // Shape real: o snapshot do autofetch carrega `config` do autofetchLive.
      config: { effective: { autoFetchMax: 3 }, envDefaults: {}, overriddenKeys: [], paused: false, pausedSince: null, schema: {} },
      obras: [
        { digest: 'abc123def456', pools: { br: 1, any: 0, seeds: 0 }, brReady: true, ageMs: 60000 },
      ],
      lastSkips: [
        { reason: 'budget', label: '15/15', at: Date.now() },
      ],
    },
    metrics: { counters: {} },
  });

  assert.ok(vnode && typeof vnode === 'object');
  assert.equal(vnode.type, ViewChupim);
  assert.ok(vnode.props);
});

test('autoFetchTeto lê af.config.effective.autoFetchMax (não af.effective)', () => {
  assert.equal(autoFetchTeto({ config: { effective: { autoFetchMax: 5 } } }), 5);
  assert.equal(autoFetchTeto({ effective: { autoFetchMax: 5 } }), null, 'af.effective não é o contrato');
  assert.equal(autoFetchTeto({ config: { effective: { autoFetchMax: 'x' } } }), null);
  assert.equal(autoFetchTeto({}), null);
});

test('magnetdbSummary lê o status real (l1Entries/l1Max/sizeAlive/bad/lie)', () => {
  const s = magnetdbSummary({
    enabled: true,
    sizeAlive: 345,
    sizeBad: 5,
    sizeLie: 2,
    l1Entries: 350,
    l1Max: 50000,
    evictedQuota: 3,
    // campos que NÃO existem no contrato — não podem ser lidos
    entries: 999, active: 999, bad: 999, persistent: true,
  });

  assert.equal(s.enabled, true);
  assert.equal(s.l1Entries, 350);
  assert.equal(s.l1Max, 50000);
  assert.equal(s.sizeAlive, 345);
  assert.equal(s.sizeBad, 5);
  assert.equal(s.sizeLie, 2);
  assert.equal(s.evictedQuota, 3);
  assert.equal('active' in s, false);
  assert.equal('entries' in s, false);
});

test('sideStyle e formatTtlRemaining consomem o item real do magnet-inspect', () => {
  assert.equal(sideStyle('alive').label, 'vivo');
  assert.equal(sideStyle('bad').badge, 'painel-badge-err');
  assert.equal(sideStyle('lie').badge, 'painel-badge-warn');
  assert.equal(sideStyle('desconhecido').badge, 'painel-badge-neutral');

  // O TTL vem em SEGUNDOS; montar timestamp futuro invertia o sinal e dava 0.
  assert.equal(formatTtlRemaining(120), '2m');
  assert.notEqual(formatTtlRemaining(120), '0s');
  assert.equal(formatTtlRemaining(null), '—');
  assert.equal(formatTtlRemaining(undefined), '—');
});

test('cacheSummary lê maxEntries e l2.fileSizeBytes reais', () => {
  const s = cacheSummary({
    entries: 120,
    maxEntries: 1000,
    persistent: true,
    hits: 450,
    misses: 50,
    swrServed: 7,
    // Chaves antigas: não existem no payload.
    max: 999,
    l2: { enabled: true, fileSizeBytes: 1048576, walSizeBytes: 4096, pendingWrites: 2, entries: 999, sizeBytes: 999 },
  });

  assert.equal(s.l1Entries, 120);
  assert.equal(s.l1Max, 1000);
  assert.equal(s.l2Bytes, 1048576);
  assert.equal(s.l2WalBytes, 4096);
  assert.equal(s.l2Pending, 2);
  assert.equal(s.l2Enabled, true);
  assert.equal(s.hits, 450);
  assert.equal(s.misses, 50);
  assert.equal(s.swrServed, 7);
  assert.ok(Math.abs(s.hitRate - 0.9) < 1e-9);
  assert.equal('max' in s, false);
});

test('catalogSummary lê catalog.report e trata ok:false como falha', () => {
  const ok = catalogSummary({
    ok: true,
    report: {
      magnets: 95,
      ready: 90,
      works: { known: 80, unknown: 15 },
      totals: { count: 95, bytes: 123 },
      byBucket: { dub: { count: 60, bytes: 100 }, dual: { count: 20, bytes: 20 } },
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.magnets, 95);
  assert.equal(ok.ready, 90);
  assert.equal(ok.knownWorks, 80);
  assert.equal(ok.unknownWorks, 15);
  assert.equal(ok.totalCount, 95);
  assert.equal(ok.byBucket.dub.count, 60);

  const fail = catalogSummary({ ok: false, reason: 'chave-operador-desativada', hint: 'ative DEBRID_OPERATOR_ENV_ACCOUNT' });
  assert.equal(fail.ok, false);
  assert.match(String(fail.reason), /chave-operador-desativada/);
  assert.match(String(fail.reason), /DEBRID_OPERATOR_ENV_ACCOUNT/);
  assert.equal(fail.magnets, 0);

  // Payload antigo (campos no topo, sem `report`) não é mais lido como válido.
  const legacy = catalogSummary({ works: 80, magnets: 95, duplicates: 15 });
  assert.equal(legacy.magnets, 0);
  assert.equal(legacy.ok, true, 'sem ok:false é tratado como resposta válida vazia');
});

test('nextCatalogState não deixa o catálogo preso em "Carregando" após falha', () => {
  // Carga inicial silenciosa com 503/401/429/rede: sem relatório bom, o estado
  // vira erro seguro — não `null` (que renderiza "Carregando…" para sempre).
  for (const error of ['Serviço de diagnóstico desativado', 'Token inválido ou não autorizado', 'Limite de concorrência atingido (429)', 'Falha de conexão com o servidor']) {
    const next = nextCatalogState(null, { ok: false, error });
    assert.equal(next.ok, false);
    assert.equal(next.reason, error);
    assert.equal(next.retry, true, 'habilita o retry pelo botão existente');
    // E o mapeamento alimenta o render: a causa aparece, sem "Carregando".
    const summary = catalogSummary(next);
    assert.equal(summary.ok, false);
    assert.equal(summary.reason, error);
  }

  // Relatório bom já carregado + falha transitória (429 de refresh): preserva.
  const bom = { ok: true, report: { magnets: 5 } };
  assert.equal(nextCatalogState(bom, { ok: false, error: '429' }), bom);

  // HTTP 200 com ok:false do servidor é RESPOSTA (conta indisponível): usa como veio.
  const serverFail = nextCatalogState(null, { ok: true, data: { ok: false, reason: 'sem-adapter' } });
  assert.deepEqual(serverFail, { ok: false, reason: 'sem-adapter' });
  assert.equal('retry' in serverFail, false, 'erro de configuração não sugere retry cego');

  // Resposta HTTP ok e vazia não pode virar null.
  assert.equal(nextCatalogState(null, { ok: true }).ok, false);
});

// ---------------------------------------------------------------------------
// Extensao: aba Diagnostico, navegacao por hash e card de config ao vivo.
// (Acrescimo puro; as assercoes existentes acima nao foram tocadas.)
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { ViewDiagnostico } from '../src/client/painel/view-diagnostico.js';
import { TAB_IDS, tabFromHash } from '../src/client/painel/app.js';

test('ViewDiagnostico retorna VNode valido com os servicos de debrid', () => {
  const vnode = ViewDiagnostico({ debrid: { services: [{ id: 'alldebrid', label: 'AllDebrid' }] } });
  assert.ok(vnode && typeof vnode === 'object');
  assert.ok(vnode.props);
});

test('TAB_IDS cobre as onze abas e tabFromHash so aceita id valido', () => {
  assert.deepEqual(
    [...TAB_IDS],
    ['saude', 'conta', 'gate', 'colhedor', 'sonda', 'chupim', 'jev', 'cache', 'limpeza', 'magnets', 'diagnostico'],
  );
  assert.ok((TAB_IDS as readonly string[]).includes('diagnostico'));

  const previousWindow = (globalThis as any).window;
  try {
    (globalThis as any).window = { location: { hash: '#diagnostico' } };
    assert.equal(tabFromHash('saude'), 'diagnostico', 'hash valido abre a aba');
    (globalThis as any).window = { location: { hash: '#../../etc' } };
    assert.equal(tabFromHash('saude'), 'saude', 'hash fora da lista e ignorado');
    (globalThis as any).window = { location: {} };
    assert.equal(tabFromHash('chupim'), 'chupim', 'sem hash fica no fallback');
  } finally {
    if (previousWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previousWindow;
  }
});

test('card de config ao vivo e reutilizado por Chupim e Colhedor (dirigido pelo schema)', () => {
  const read = (rel: string) => readFileSync(new URL('../../src/client/painel/' + rel, import.meta.url), 'utf8');
  assert.match(read('view-chupim.ts'), /\$\{LiveConfigCard\}/, 'Chupim usa o card');
  assert.match(read('view-colhedor.ts'), /\$\{LiveConfigCard\}/, 'Colhedor usa o card');
  const config = read('view-config.ts');
  assert.match(config, /configRowsFromSnapshot/, 'as linhas nascem do schema do backend');
  assert.match(config, /confirm:\s*\{[\s\S]{0,400}?danger:\s*true/, 'restaurar padroes e destrutivo e pede confirmacao');
  assert.doesNotMatch(config, /\baf_/, 'sem lista hardcoded de campos');
});