// Cartão "Sites da Raspagem" (catálogo): um botão Ligar/Desligar por site da
// tabela BR, inclusive o site fora de `CRAWL_SITES`. Sem DOM e sem rede: o
// modelo e o componente são chamados direto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogOrigin, crawlCatalog, SitesCatalogCard, type CatalogEntry } from '../src/client/painel/raspagens-catalog.js';
import { crawlSiteCards, crawlSummary } from '../src/client/painel/raspagens-model.js';
import { expand, textOf } from './helpers/painel-vnode.js';

const payload = {
  enabled: false,
  site: 'vacatorrent',
  sitesConfigured: ['vacatorrent'],
  sites: [],
  catalog: [
    { id: 'vacatorrent', label: 'Vaca Torrent', adapter: true, note: null, inEnv: true, configured: true, enabled: true, enabledOverridden: false },
    { id: 'nerdfilmes', label: 'NerdFilmes', adapter: true, note: null, inEnv: false, configured: false, enabled: false, enabledOverridden: false },
    { id: 'bludv-cardigann', label: 'BLUDV', adapter: false, note: 'adaptador pendente', inEnv: false, configured: false, enabled: false, enabledOverridden: false },
    { bogus: true },
  ],
};

test('crawlCatalog normaliza e descarta linha sem id; backend antigo vira []', () => {
  const catalog = crawlCatalog(payload);
  assert.deepEqual(catalog.map((c) => c.id), ['vacatorrent', 'nerdfilmes', 'bludv-cardigann']);
  assert.deepEqual(crawlCatalog({}), []);
  assert.deepEqual(crawlCatalog(null), []);
});

test('catalogOrigin diz se quem manda é o .env ou o painel', () => {
  const [vaca, nerd, bludv] = crawlCatalog(payload);
  assert.equal(catalogOrigin(vaca), 'padrão do .env');
  assert.equal(catalogOrigin(nerd), 'fora do .env');
  assert.equal(catalogOrigin(bludv), 'adaptador pendente');
  assert.equal(catalogOrigin({ ...nerd, enabled: true, enabledOverridden: true }), 'ligado pelo painel');
  assert.equal(catalogOrigin({ ...vaca, enabled: false, enabledOverridden: true }), 'painel (sobrepõe o .env)');
});

test('um botão por site: Desligar no ligado, Ligar no desligado, sem adaptador desabilitado', () => {
  const toggled: CatalogEntry[] = [];
  const vnode = SitesCatalogCard({
    catalog: crawlCatalog(payload),
    cards: crawlSiteCards(payload),
    summary: crawlSummary(payload),
    pending: false,
    onToggle: (entry) => toggled.push(entry),
  });
  const text = textOf(vnode);
  assert.match(text, /Sites da Raspagem/);
  assert.match(text, /NerdFilmes/, 'site fora do .env aparece no painel');
  assert.match(text, /hoje desligada/, 'motor desligado é avisado junto do liga/desliga');
  const buttons = expand(vnode).filter((n) => n.type === 'button');
  assert.deepEqual(buttons.map((b) => textOf(b).trim()), ['Desligar', 'Ligar', 'Ligar']);
  assert.equal(buttons[0].props.disabled, false);
  assert.equal(buttons[1].props.disabled, false);
  assert.equal(buttons[2].props.disabled, true, 'sem adaptador não liga');
  buttons[1].props.onClick();
  assert.deepEqual(toggled.map((t) => [t.id, t.enabled]), [['nerdfilmes', false]]);
});

test('pending trava todos os botões', () => {
  const vnode = SitesCatalogCard({
    catalog: crawlCatalog(payload), cards: [], summary: crawlSummary(payload), pending: true, onToggle: () => {},
  });
  assert.ok(expand(vnode).filter((n) => n.type === 'button').every((b) => b.props.disabled === true));
});
