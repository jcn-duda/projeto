// Etapa 5 — cliente do painel: modelo puro do banco vivo, render do card, a
// allowlist dos módulos novos e o indicador "servido de memória" dos indexers.
// Sem DOM e sem rede: as funções de componente são chamadas direto (o emit
// NodeNext de dist/src/client, como os demais testes do painel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  magnetBankSummary,
  bankIndexerRows,
  bankLastSeenLabel,
  bankSearchView,
  bankSearchModeLabel,
  bankSearchCountLabel,
  workLabel,
} from '../src/client/painel/bank-model.js';
import { ViewMagnetBank, MagnetBankView } from '../src/client/painel/view-magnet-bank.js';
import { indexerRows, indexerMemoryLabel } from '../src/client/painel/saude-model.js';
import { ViewSaude } from '../src/client/painel/view-saude.js';
import { CLIENT_ASSETS } from '../src/routes/public.js';
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

function chipButtons(vnode: any): any[] {
  return expand(vnode).filter((n) => n.type === 'button' && String(n.props?.class || '').includes('painel-chip'));
}

test('magnetBankSummary lê o contrato real e rotula a engine', () => {
  const s = magnetBankSummary({
    enabled: true,
    engine: 'sql',
    magnets: 10,
    sources: 12,
    works: 8,
    lastSeen: 123,
    queue: 2,
    queueMax: 500,
    byIndexer: [
      { indexer: 'nerdfilmes', hashes: 2, sources: 2, lastSeen: 99 },
      { indexer: 'bludv', hashes: 5, sources: 6, lastSeen: 123 },
      // lixo que não pode virar linha
      null,
      { indexer: '' },
    ],
  });

  assert.equal(s.enabled, true);
  assert.equal(s.engine, 'SQLite');
  assert.equal(s.magnets, 10);
  assert.equal(s.sources, 12);
  assert.equal(s.works, 8);
  assert.equal(s.queue, 2);
  assert.equal(s.queueMax, 500);
  assert.equal(s.byIndexer.length, 2, 'entradas inválidas são descartadas');
  assert.equal(s.byIndexer[0].indexer, 'bludv', 'mais recente primeiro');
  assert.equal(s.byIndexer[1].indexer, 'nerdfilmes');

  const vazio = magnetBankSummary(null);
  assert.equal(vazio.enabled, false);
  assert.equal(vazio.magnets, 0);
  assert.deepEqual(vazio.byIndexer, []);

  assert.equal(magnetBankSummary({ engine: 'memory' }).engine, 'MEMÓRIA');
  assert.equal(magnetBankSummary({ engine: 'disabled' }).engine, 'DESLIGADO');
  assert.equal(magnetBankSummary({}).engine, '—');
});

test('bankIndexerRows ordena por último visto e aceita estado parcial', () => {
  const rows = bankIndexerRows([
    { indexer: 'a', hashes: '3', lastSeen: 10 },
    { indexer: 'b', sources: 4, lastSeen: 30 },
    { indexer: 'c', lastSeen: 30 },
  ]);
  assert.deepEqual(rows.map((r) => r.indexer), ['b', 'c', 'a'], 'último visto desc, empate por id');
  assert.equal(rows[0].hashes, 0, 'campo ausente vira 0, não NaN');
  assert.equal(rows[0].sources, 4);
});

test('bankLastSeenLabel protege o zero e mede o restante', () => {
  assert.equal(bankLastSeenLabel(0), '—');
  assert.equal(bankLastSeenLabel(null), '—');
  const label = bankLastSeenLabel(Date.now() - 5000);
  assert.match(label, /^5s atrás$/);
});

test('bankSearchView normaliza itens, fontes e obras', () => {
  const item = {
    hash: 'a'.repeat(40),
    uri: 'magnet:?xt=urn:btih:x',
    title: 'Filme',
    size: 10,
    isBr: true,
    dubbed: false,
    quality: '1080p',
    seedersMax: 5,
    seedersLast: 3,
    lastSeen: 1000,
    lied: false,
    sources: [{ indexer: 'bludv', tracker: 'T', lastSeen: 1, seedersLast: 2 }],
    works: [{ imdb: 'tt222', season: 2, episode: 3, passedFilter: 1 }],
  };
  const view = bankSearchView({ mode: 'title', query: 'filme', matched: null, returned: 1, truncated: true, items: [item, null, {}] });
  assert.equal(view.mode, 'title');
  assert.equal(view.modeLabel, 'por título');
  assert.equal(view.matched, null, 'truncado não inventa total exato');
  assert.equal(view.returned, 1);
  assert.equal(view.truncated, true);
  assert.equal(bankSearchCountLabel(view), '1+', 'rótulo honesto quando truncado');
  const exato = bankSearchView({ matched: 3, returned: 3, truncated: false });
  assert.equal(exato.matched, 3);
  assert.equal(bankSearchCountLabel(exato), '3 de 3');
  assert.equal(view.items.length, 1, 'itens sem hash são descartados');
  assert.equal(view.items[0].isBr, true);
  assert.equal(view.items[0].sources[0].indexer, 'bludv');
  assert.equal(view.items[0].works[0].passedFilter, true);

  const desconhecido = bankSearchView({ mode: 'bizarro' });
  assert.equal(desconhecido.mode, 'unknown');
  assert.equal(bankSearchModeLabel('hash'), 'por hash');
  assert.equal(bankSearchModeLabel('recent'), 'recentes');

  assert.equal(workLabel({ imdb: 'tt222', season: 1, episode: 2, passedFilter: true }), 'tt222 · S01E02 · passou');
  assert.equal(workLabel({ imdb: 'tt111', season: -1, episode: -1, passedFilter: false }), 'tt111 · filtrada');
});

test('MagnetBankView renderiza totais, tabela por indexer e o formulário de busca', () => {
  const vnode = MagnetBankView({
    magnetBank: {
      enabled: true,
      engine: 'sql',
      magnets: 7,
      sources: 9,
      works: 4,
      lastSeen: Date.now() - 1000,
      queue: 1,
      queueMax: 500,
      byIndexer: [{ indexer: 'bludv', hashes: 5, sources: 6, lastSeen: Date.now() - 2000 }],
    },
    query: '',
    onQuery: () => {},
    onSearch: () => {},
    pending: false,
    feedback: null,
    result: null,
  });

  const text = textOf(vnode);
  assert.match(text, /Banco de Magnets Vivo/);
  assert.match(text, /SQLITE/, 'o badge mostra a engine em caixa alta');
  assert.match(text, /magnets \(torrents\)/);
  assert.match(text, /bludv/);
  assert.match(text, /Buscar no Banco/);

  const elements = expand(vnode);
  const input = elements.find((n) => n.type === 'input' && String(n.props?.placeholder || '').includes('título'));
  assert.ok(input, 'o formulário de busca tem o campo de hash/título');
  const rows = elements.filter((n) => n.type === 'tr');
  assert.ok(rows.some((r) => textOf(r).includes('bludv')), 'a linha do indexer aparece na tabela');
});

test('MagnetBankView renderiza resultado com URI, fontes e obras', () => {
  const vnode = MagnetBankView({
    magnetBank: { enabled: true, engine: 'sql', magnets: 1 },
    query: 'filme',
    onQuery: () => {},
    onSearch: () => {},
    pending: false,
    feedback: { text: '1 de 1 magnet(s) · por título', ok: true },
    result: {
      mode: 'title',
      query: 'filme',
      matched: 1,
      returned: 1,
      truncated: false,
      items: [{
        hash: 'a'.repeat(40),
        uri: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=Filme',
        title: 'Filme Dublado 1080p',
        size: 1024,
        isBr: true,
        dubbed: true,
        quality: '1080p',
        seedersMax: 9,
        seedersLast: 7,
        lastSeen: Date.now() - 5000,
        lied: false,
        sources: [{ indexer: 'bludv', tracker: 'TR', lastSeen: 1, seedersLast: 7 }],
        works: [{ imdb: 'tt111', season: -1, episode: -1, passedFilter: true }],
      }],
    },
  });

  const text = textOf(vnode);
  assert.match(text, /Filme Dublado 1080p/);
  assert.match(text, /1 de 1 magnet/);
  assert.match(text, /bludv\/TR/, 'a fonte aparece');
  assert.match(text, /tt111 · passou/, 'a obra aparece via workLabel');
  const copy = expand(vnode).find((n) => n.type === 'button' && textOf(n).includes('Copiar'));
  assert.ok(copy, 'há botão de copiar a URI');
  assert.equal(copy.props.disabled, false);
});

test('MagnetBankView sem banco mostra vazio e badge DESLIGADO', () => {
  const vnode = MagnetBankView({
    magnetBank: { enabled: false, engine: 'disabled' },
    query: '',
    onQuery: () => {},
    onSearch: () => {},
    pending: false,
    feedback: null,
    result: null,
  });
  const text = textOf(vnode);
  assert.match(text, /DESLIGADO/);
  assert.match(text, /Nenhuma fonte capturada ainda/);
});

test('ViewMagnetBank é a casca com estado que monta o corpo presentacional', () => {
  const vnode = h(ViewMagnetBank, { magnetBank: { enabled: true, engine: 'sql' } });
  assert.equal(vnode.type, ViewMagnetBank);
  assert.equal(vnode.props.magnetBank.engine, 'sql');
});

test('CLIENT_ASSETS publica os módulos do banco vivo', () => {
  assert.ok(CLIENT_ASSETS.includes('client/painel/bank-model.js'), 'model precisa de rota');
  assert.ok(CLIENT_ASSETS.includes('client/painel/view-magnet-bank.js'), 'view precisa de rota');
  // O card é montado pela aba Magnets (view-magnets), que já está na allowlist.
  assert.ok(CLIENT_ASSETS.includes('client/painel/view-magnets.js'));
});

test('indexerRows lê fallbackServed sem confundir com o estado online', () => {
  const [row] = indexerRows([
    { id: 'bludv', label: 'Bludv', status: { state: 'online', ms: 120 }, fallbackServed: 4 },
  ]);
  assert.equal(row.state, 'online', 'o estado de saúde continua sendo o do campo status');
  assert.equal(row.servedFromMemory, 4);

  const label = indexerMemoryLabel(row);
  assert.ok(label, 'há texto quando houve cobertura');
  assert.match(label!, /banco/);
  assert.match(label!, /boot/);
  assert.match(label!, /não é o status online/);

  const [semMemoria] = indexerRows([{ id: 'x', status: { state: 'online' } }]);
  assert.equal(semMemoria.servedFromMemory, 0);
  assert.equal(indexerMemoryLabel(semMemoria), null, 'zero não gera indicador');

  const vnode = ViewSaude({
    general: { ok: true, services: {} },
    indexers: [
      { id: 'bludv', label: 'Bludv', status: { state: 'online', ms: 120 }, fallbackServed: 4 },
      { id: 'tpb', label: 'TPB', status: { state: 'online', ms: 80 }, fallbackServed: 0 },
    ],
  });
  const chips = chipButtons(vnode);
  assert.equal(chips.length, 2);
  const bludv = chips.find((c) => textOf(c).includes('Bludv'))!;
  assert.match(textOf(bludv), /MEM\s+4/, 'a cobertura de memória aparece no chip');
  assert.match(String(bludv.props.title), /não é o status online/, 'tooltip separa histórico de saúde');
  const tpb = chips.find((c) => textOf(c).includes('TPB'))!;
  assert.doesNotMatch(textOf(tpb), /MEM/, 'sem cobertura não inventa badge');
});

test('wiring: app entrega o bloco magnetBank à aba Magnets', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (rel: string) => readFileSync(new URL('../../src/client/painel/' + rel, import.meta.url), 'utf8');
  assert.match(read('app.ts'), /magnetBank=\$\{p\.magnetBank\}/, 'o app repassa o bloco');
  assert.match(read('view-magnets.ts'), /ViewMagnetBank/, 'a aba Magnet monta o card novo');
  const { VITAL_BLOCKS } = await import('../src/client/painel/poll.js');
  assert.ok(VITAL_BLOCKS.includes('magnetBank'), 'o poll carrega o bloco do banco vivo');
});
