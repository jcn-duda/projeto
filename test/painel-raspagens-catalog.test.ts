// Cartão "Sites da Raspagem" (catálogo): um botão Ligar/Desligar por site da
// tabela BR, inclusive o site fora de `CRAWL_SITES`. Sem DOM e sem rede: o
// modelo e o componente são chamados direto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogOrigin, crawlCatalog, healthText, SitesCatalogCard, toggleStyle, type CatalogEntry,
} from '../src/client/painel/raspagens-catalog.js';
import { crawlSiteCards, crawlSummary } from '../src/client/painel/raspagens-model.js';
import { expand, textOf } from './helpers/painel-vnode.js';

const payload = {
  enabled: false,
  site: 'vacatorrent',
  sitesConfigured: ['vacatorrent'],
  sites: [],
  catalog: [
    { id: 'vacatorrent', label: 'Vaca Torrent', adapter: true, note: null, inEnv: true, configured: true, enabled: true, enabledOverridden: false, health: 'online', healthDetail: 'raspagem respondeu há 2 min' },
    { id: 'nerdfilmes', label: 'NerdFilmes', adapter: true, note: null, inEnv: false, configured: false, enabled: false, enabledOverridden: false, health: 'offline', healthDetail: 'busca no Jackett falhou' },
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
  assert.equal(catalogOrigin({ ...nerd, enabled: true, enabledOverridden: true }), 'painel');
  assert.equal(catalogOrigin({ ...vaca, enabled: false, enabledOverridden: true }), 'painel (sobrepõe o .env)');
});

test('saúde ausente no payload é "sem medição", nunca "no ar"', () => {
  const [, , bludv] = crawlCatalog(payload);
  assert.equal(bludv.health, 'unknown');
  assert.equal(healthText(bludv), 'sem medição');
  const [vaca, nerd] = crawlCatalog(payload);
  assert.equal(healthText(vaca), 'no ar — raspagem respondeu há 2 min');
  assert.equal(healthText(nerd), 'caído — busca no Jackett falhou');
  assert.equal(crawlCatalog({ catalog: [{ id: 'x', health: 'lindo' }] })[0].health, 'unknown');
});

test('a cor do toggle é a SAÚDE, não o liga/desliga', () => {
  const [vaca, nerd, bludv] = crawlCatalog(payload);
  assert.match(toggleStyle({ ...vaca, enabled: false }), /var\(--green\)/, 'desligado mas no ar = verde');
  assert.match(toggleStyle({ ...nerd, enabled: true }), /var\(--red\)/, 'ligado mas caído = vermelho');
  assert.match(toggleStyle({ ...vaca, health: 'instavel' }), /var\(--amber\)/);
  assert.doesNotMatch(toggleStyle({ ...vaca, health: 'unknown' }), /var\(--/, 'sem medição = neutro');
  assert.doesNotMatch(toggleStyle(bludv), /var\(--/, 'sem adaptador = neutro');
});

test('um toggle por site: rótulo ligado/desligado, cor da saúde, sem adaptador desabilitado', () => {
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
  // `textOf` inclui o `title` (dica de clique); o rótulo é o fim do texto.
  const labels = buttons.map((b) => textOf(b).trim());
  assert.ok(labels[0].endsWith('● Ligado') && labels[1].endsWith('○ Desligado') && labels[2].endsWith('Indisponível'), labels.join(' | '));
  assert.deepEqual(buttons.map((b) => b.props['aria-pressed']), ['true', 'false', 'false']);
  assert.match(String(buttons[0].props.style), /var\(--green\)/, 'Vaca no ar = verde');
  assert.match(String(buttons[1].props.style), /var\(--red\)/, 'NerdFilmes caído = vermelho');
  assert.doesNotMatch(String(buttons[2].props.style), /var\(--/);
  assert.match(text, /no ar — raspagem respondeu/);
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
