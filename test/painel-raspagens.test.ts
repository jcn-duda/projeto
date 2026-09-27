// Aba Raspagens (Fase 4 do plano "Raspagem total"): modelo puro tolerante,
// render do card por site, ligação das ações do `/dashboard-action.json`, a
// aba em TAB_IDS e a allowlist fechada dos módulos novos. Sem DOM, sem rede e
// sem subir o motor — os componentes são chamados/expandidos como nos demais
// testes do painel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  crawlSummary,
  crawlSiteCards,
  motorBadge,
  nextDiscoveryLabel,
  phaseLabel,
  siteStateLabel,
  workLabel,
  runDurationMs,
  etaLabel,
} from '../src/client/painel/raspagens-model.js';
import { SiteCard, ViewRaspagens } from '../src/client/painel/view-raspagens.js';
import { TAB_IDS, tabFromHash } from '../src/client/painel/app.js';
import { CLIENT_ASSETS } from '../src/routes/public.js';
import { VITAL_BLOCKS } from '../src/client/painel/poll.js';
import { h } from '../src/client/painel/vendor/preact.js';

/** Expande componentes de função (sem hooks) e devolve os VNodes de elemento. */
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

/** Texto visível incluindo title/badge/label dos componentes do kit. */
function textOf(node: any): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return textOf(node.type(node.props || {}));
    const props = node.props || {};
    return [
      typeof props.title === 'string' ? props.title : '',
      typeof props.badge?.text === 'string' ? props.badge.text : '',
      typeof props.label === 'string' ? props.label : '',
      textOf(props.children),
    ].join(' ');
  }
  return '';
}

function sampleCrawl() {
  return {
    enabled: true,
    dryRun: false,
    paused: false,
    autoPause: null,
    site: 'vacatorrent',
    siteReady: true,
    sitesConfigured: ['vacatorrent', 'nerdfilmes'],
    engine: 'sql',
    cursor: '2026-09-01',
    cursors: { movie: '2026-09-01', tv_show: '2026-09-05' },
    nextDiscoveryAt: Date.now() + 30 * 60_000,
    pagesThisHour: 12,
    maxPerHour: 500,
    delayMs: 700,
    idleWindowMs: 60000,
    errorStreak: 0,
    canaryStreak: 0,
    runOpen: false,
    sites: [
      {
        id: 'vacatorrent',
        label: 'Vaca Torrent',
        phase: 'incremental',
        total: 100,
        byStatus: { pending: 10, inflight: 1, done: 80, 'no-torrent': 5, 'no-work': 2, error: 2 },
        progressPercent: 80,
        magnetsFound: 240,
        newReleases: 7,
        pendingRemaining: 13,
        ratePerHour: 400,
        etaHours: 0.03,
        latestRun: { id: 3, phase: 'incremental', cursor: '2026-09-01', startedAt: 1000, finishedAt: 5000, counters: { pages: 80, newReleases: 7 } },
        recentWorks: [{ url: 'https://x/a', imdb: 'tt1111111', releases: 3, checkedAt: Date.now() - 5000 }],
        noWork: [{ url: 'https://x/b', checkedAt: Date.now() - 7000 }],
        errors: [{ url: 'https://x/c', error: 'HTTP 500', tries: 2, checkedAt: Date.now() - 9000 }],
        errorGroups: [{ reason: 'HTTP 500', count: 2 }],
      },
      {
        id: 'nerdfilmes',
        label: 'NerdFilmes',
        phase: null,
        total: 0,
        byStatus: {},
        progressPercent: 0,
        magnetsFound: 0,
        newReleases: 0,
        pendingRemaining: 0,
        ratePerHour: 400,
        etaHours: 0,
        latestRun: null,
        recentWorks: [],
        noWork: [],
        errors: [],
        errorGroups: [],
      },
    ],
  };
}

test('crawlSummary é tolerante: payload ausente não inventa estado', () => {
  const empty = crawlSummary(null);
  assert.equal(empty.enabled, false);
  assert.equal(empty.dryRun, false);
  assert.equal(empty.paused, false);
  assert.equal(empty.autoPause, null);
  assert.equal(empty.site, null);
  assert.deepEqual(empty.sitesConfigured, []);
  assert.equal(empty.engine, null);
  assert.equal(empty.nextDiscoveryAt, null, 'campo ausente é null, não 0 afirmativo');
  assert.equal(empty.pagesThisHour, 0);
  assert.equal(empty.runOpen, false);
  assert.deepEqual(empty.cursors, { movie: null, tv_show: null }, 'payload ausente não inventa cursor');

  const s = crawlSummary(sampleCrawl());
  assert.equal(s.enabled, true);
  assert.equal(s.site, 'vacatorrent');
  assert.deepEqual(s.sitesConfigured, ['vacatorrent', 'nerdfilmes']);
  assert.equal(s.pagesThisHour, 12);
  assert.deepEqual(s.cursors, { movie: '2026-09-01', tv_show: '2026-09-05' }, 'ambos os cursores por kind chegam ao painel');
  assert.deepEqual(
    crawlSummary({ cursor: '2026-08-01' }).cursors,
    { movie: '2026-08-01', tv_show: null },
    'backend sem o mapa cai no cursor solto (era só de filme)',
  );
  assert.ok(s.nextDiscoveryAt != null && Math.abs(s.nextDiscoveryAt - Date.now() - 30 * 60_000) < 5000);

  // autoPause malformado não vira objeto afirmativo.
  assert.equal(crawlSummary({ autoPause: 'x' }).autoPause, null);
  assert.equal(crawlSummary({ autoPause: { reason: 'layout', detail: 'l1' } }).autoPause?.reason, 'layout');
});

test('motorBadge prioriza pausa automática > manual > desligado > simulação', () => {
  assert.deepEqual(motorBadge(crawlSummary({ enabled: true })), { text: 'ATIVO', variant: 'ok' });
  assert.deepEqual(motorBadge(crawlSummary({ enabled: true, dryRun: true })), { text: 'SIMULAÇÃO', variant: 'warn' });
  assert.deepEqual(motorBadge(crawlSummary({ enabled: false })), { text: 'DESLIGADO', variant: 'neutral' });
  assert.deepEqual(motorBadge(crawlSummary({ enabled: true, paused: true })), { text: 'PAUSADO', variant: 'warn' });
  const auto = motorBadge(crawlSummary({ enabled: true, paused: true, autoPause: { reason: 'error-streak' } }));
  assert.deepEqual(auto, { text: 'PAUSA AUTOMÁTICA', variant: 'err' });
});

test('crawlSiteCards normaliza contadores, deriva % torrent e marca o site ativo', () => {
  const cards = crawlSiteCards(sampleCrawl());
  assert.equal(cards.length, 2);

  const [vaca, nerd] = cards;
  assert.equal(vaca.id, 'vacatorrent');
  assert.equal(vaca.label, 'Vaca Torrent');
  assert.equal(vaca.active, true);
  assert.equal(vaca.phase, 'incremental');
  assert.equal(vaca.total, 100);
  assert.equal(vaca.done, 80);
  assert.equal(vaca.pending, 10);
  assert.equal(vaca.noTorrent, 5);
  assert.equal(vaca.noWork, 2);
  assert.equal(vaca.error, 2);
  assert.equal(vaca.progressPercent, 80);
  // 80 done ÷ (80 done + 5 no-torrent + 2 no-work + 2 error) = 89,89% → 90.
  assert.equal(vaca.torrentPercent, 90);
  assert.equal(vaca.magnetsFound, 240);
  assert.equal(vaca.newReleases, 7);
  assert.equal(vaca.ratePerHour, 400);
  assert.equal(vaca.etaHours, 0.03);
  assert.equal(vaca.latestRun?.phase, 'incremental');
  assert.equal(vaca.errorGroups[0].count, 2);

  assert.equal(nerd.active, false, 'só o site do motor é ativo');
  assert.equal(nerd.phase, null);
  assert.equal(nerd.torrentPercent, 0, 'sem processadas não divide por zero');
  assert.equal(nerd.etaHours, null, 'eta 0 não vira ETA afirmativo');
  assert.equal(nerd.latestRun, null);

  // Entradas inválidas somem; payload ausente devolve [].
  assert.deepEqual(crawlSiteCards({ sites: [null, {}, { id: '' }, 'x'] }), []);
  assert.deepEqual(crawlSiteCards(null), []);
});

test('partial (Fase 7 v2): byStatus.partial vira campo, partialWork traz x/y, processed não muda', () => {
  const crawl = sampleCrawl() as Record<string, any>;
  crawl.sites[0].byStatus.partial = 3;
  crawl.sites[0].partialWork = [
    { url: 'https://x/one-piece', done: 14, total: 24, checkedAt: Date.now() - 1000 },
    { url: '', done: 0, total: 0, checkedAt: 0 },
  ];
  const [card] = crawlSiteCards(crawl);
  assert.equal(card.partial, 3);
  assert.equal(card.torrentPercent, 90, 'página parcial NÃO entra nas processadas');
  assert.deepEqual(card.partialWork, [{ url: 'https://x/one-piece', done: 14, total: 24, checkedAt: card.partialWork[0].checkedAt }]);
  // pendingRemaining do backend não inclui partial neste fixture, mas o
  // fallback sim: pending + error + inflight + partial.
  const fallback = crawlSiteCards({ site: 'a', sites: [{ id: 'a', label: 'A', total: 10, byStatus: { pending: 2, error: 1, inflight: 1, partial: 4 } }] })[0];
  assert.equal(fallback.pendingRemaining, 8, 'fallback soma partial como restante');
});

test('phaseLabel, siteStateLabel, workLabel, runDurationMs e etaLabel', () => {
  assert.equal(phaseLabel('initial'), 'Carga inicial');
  assert.equal(phaseLabel('incremental'), 'Incremental');
  assert.equal(phaseLabel(null), '—');

  const summary = crawlSummary({ enabled: true, site: 'a' });
  const card = crawlSiteCards({ site: 'a', sites: [{ id: 'a', label: 'A', total: 1, byStatus: { done: 1 } }] })[0];
  assert.equal(siteStateLabel(card, summary), 'ativo');
  assert.equal(siteStateLabel({ ...card, active: false }, summary), 'ocioso');
  assert.equal(siteStateLabel({ ...card, active: false, total: 0 }, summary), 'sem estado');
  assert.equal(siteStateLabel(card, crawlSummary({ enabled: true, paused: true, site: 'a' })), 'pausado');
  assert.equal(
    siteStateLabel(card, crawlSummary({ enabled: true, dryRun: true, site: 'a' })),
    'simulando',
  );

  assert.equal(workLabel({ url: 'u', imdb: 'tt1', releases: 3, checkedAt: 0 }), 'tt1 · 3 release(s)');
  assert.equal(workLabel({ url: 'u', imdb: null, releases: 0, checkedAt: 0 }), 'u · 0 release(s)');

  assert.equal(runDurationMs({ id: 1, phase: 'initial', cursor: null, startedAt: 1000, finishedAt: 4000, counters: {} }), 3000);
  assert.equal(runDurationMs({ id: 1, phase: 'initial', cursor: null, startedAt: 1000, finishedAt: null, counters: {} }), null);
  assert.equal(runDurationMs(null), null);

  assert.equal(etaLabel(null), '—');
  assert.equal(etaLabel(0), '—');
  assert.equal(etaLabel(0.5), '30min');
  assert.equal(etaLabel(2.5), '2h 30min');
  assert.equal(etaLabel(3), '3h');
});

test('nextDiscoveryLabel mapeia a próxima descoberta sem inventar hora (Fase 6)', () => {
  const agora = Date.now();
  assert.equal(nextDiscoveryLabel(null), '—', 'campo ausente é —');
  assert.equal(nextDiscoveryLabel(undefined as any), '—');
  assert.equal(nextDiscoveryLabel(0, agora), 'devida', '0 é "devida", não —');
  assert.equal(nextDiscoveryLabel(agora - 1000, agora), 'devida', 'passado é devida');
  assert.equal(nextDiscoveryLabel(agora + 30_000, agora), 'em 1min');
  assert.equal(nextDiscoveryLabel(agora + 45 * 60_000, agora), 'em 45min');
  assert.equal(nextDiscoveryLabel(agora + 2 * 3600_000, agora), 'em 2h');
  assert.equal(nextDiscoveryLabel(agora + 2 * 3600_000 + 30 * 60_000, agora), 'em 2h 30min');
});

test('SiteCard renderiza estado, progresso, listas e botões por site', () => {
  const summary = crawlSummary(sampleCrawl());
  const [card] = crawlSiteCards(sampleCrawl());
  const vnode = SiteCard({ card, summary, pending: false, onReprocess: () => {}, onReset: () => {} });
  const text = textOf(vnode);

  assert.match(text, /Vaca Torrent/);
  assert.match(text, /Incremental/);
  assert.match(text, /magnets vistos/);
  assert.match(text, /% torrent/);
  assert.match(text, /ETA/);
  assert.match(text, /Última rodada/);
  assert.match(text, /Últimas Obras/);
  assert.match(text, /Sem Obra Identificada/);
  assert.match(text, /Erros Agrupados/);
  assert.match(text, /HTTP 500/, 'o grupo de erro aparece');
  assert.match(text, /tt1111111 · 3 release\(s\)/, 'a obra recente aparece');
  assert.match(text, /https:\/\/x\/b/, 'a página sem obra aparece');

  const elements = expand(vnode);
  const reprocess = elements.find((n) => n.type === 'button' && textOf(n).includes('Reprocessar Erros'));
  const reset = elements.find((n) => n.type === 'button' && textOf(n).includes('Zerar Site'));
  assert.ok(reprocess, 'há botão de reprocessar erros');
  assert.ok(reset, 'há botão de zerar site');
  assert.equal(reset.props.disabled, false);
  assert.match(String(reset.props.class), /painel-btn-danger/);
});

test('SiteCard desabilita Reprocessar Erros quando não há erro', () => {
  const summary = crawlSummary({ enabled: true, site: 'a' });
  const [card] = crawlSiteCards({ site: 'a', sites: [{ id: 'a', label: 'A', total: 1, byStatus: { done: 1 } }] });
  const elements = expand(SiteCard({ card, summary, pending: false, onReprocess: () => {}, onReset: () => {} }));
  const reprocess = elements.find((n) => n.type === 'button' && textOf(n).includes('Reprocessar Erros'));
  assert.ok(reprocess);
  assert.equal(reprocess.props.disabled, true);
});

test('ViewRaspagens é a casca com o bloco crawl nas props', () => {
  const vnode = h(ViewRaspagens, { crawl: sampleCrawl() });
  assert.equal(vnode.type, ViewRaspagens);
  assert.equal(vnode.props.crawl.site, 'vacatorrent');
});

test('wiring: ações, confirmação destrutiva e LiveConfigCard no cliente da raspagem', () => {
  const read = (rel: string) => readFileSync(new URL('../../src/client/painel/' + rel, import.meta.url), 'utf8');
  const view = read('view-raspagens.ts');

  for (const action of ['crawl-pause', 'crawl-simulate', 'crawl-reprocess-errors', 'crawl-reset']) {
    assert.match(view, new RegExp(`'${action}'`), `a ação ${action} precisa estar ligada na view`);
  }
  assert.match(view, /max:\s*20/, 'Simular 20 usa max=20');
  assert.match(view, /site:\s*card\.id/, 'reprocessar/zerar mandam o id do site');
  assert.match(view, /confirmLabel:\s*'Zerar site'[\s\S]{0,80}?danger:\s*true/, 'zerar site é destrutivo e pede confirmação');

  assert.match(view, /getAction="crawl-config-get"/);
  assert.match(view, /setAction="crawl-config-set"/);
  assert.match(view, /resetAction="crawl-config-reset"/);
  assert.match(view, /\$\{LiveConfigCard\}/, 'a config ao vivo vem do card reutilizado');

  assert.match(view, /role="status"/, 'o feedback precisa ser anunciado (role=status)');
  assert.match(view, /aria-live="polite"/, 'o anúncio do feedback é não-urgente (aria-live=polite)');
});

test('view renderiza a próxima descoberta quando ela existe (Fase 6)', () => {
  const read = (rel: string) => readFileSync(new URL('../../src/client/painel/' + rel, import.meta.url), 'utf8');
  const view = read('view-raspagens.ts');
  assert.match(view, /nextDiscoveryLabel/, 'o rótulo vem do modelo, não é montado na view');
  assert.match(view, /summary\.nextDiscoveryAt != null/, 'ausente no payload não renderiza hora');
});

test('view exibe AMBOS os cursores (filme e série) — F2/B1', () => {
  const read = (rel: string) => readFileSync(new URL('../../src/client/painel/' + rel, import.meta.url), 'utf8');
  const view = read('view-raspagens.ts');
  assert.match(view, /Cursor filmes/, 'cursor de filme rotulado');
  assert.match(view, /Cursor séries/, 'cursor de série rotulado — sem ele a carga inicial de série parece "sem cursor"');
  assert.match(view, /summary\.cursors\.tv_show/, 'a série lê do mapa por kind, não do cursor solto');
});

test('TAB_IDS inclui raspagens e o hash abre a aba', () => {
  assert.ok((TAB_IDS as readonly string[]).includes('raspagens'));
  assert.equal(TAB_IDS.indexOf('raspagens'), 4, 'entra logo após o Colhedor');

  const previousWindow = (globalThis as any).window;
  try {
    (globalThis as any).window = { location: { hash: '#raspagens' } };
    assert.equal(tabFromHash('saude'), 'raspagens');
    (globalThis as any).window = { location: { hash: '#nope' } };
    assert.equal(tabFromHash('saude'), 'saude');
  } finally {
    if (previousWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previousWindow;
  }
});

test('allowlist e poll: módulos novos publicados e bloco crawl carregado', () => {
  assert.ok(CLIENT_ASSETS.includes('client/painel/raspagens-model.js'), 'model precisa de rota');
  assert.ok(CLIENT_ASSETS.includes('client/painel/view-raspagens.js'), 'view precisa de rota');
  assert.ok(VITAL_BLOCKS.includes('crawl'), 'o bloco crawl precisa vir no poll para a aba montar');
});
