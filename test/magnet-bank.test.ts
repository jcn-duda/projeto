// Banco de magnets vivo (Etapa 2): engine, merge durável, lie global e fila.
//
// Roda SEM rede. O engine é isolado por teste: `open(<diretório>)` faz o
// `node:sqlite` falhar e cai no Map em memória — o mesmo contrato do catálogo e
// do cache, e o que mantém o arquivo determinístico no Node 20 (sem
// `node:sqlite`). O engine SQLite ganha testes próprios, pulados quando o
// módulo não existe.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as metrics from '../src/utils/metrics.js';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import { accountScope } from '../src/utils/request-key.js';

// node:sqlite é experimental no Node 22+; no Node 20 o engine cai em memória.
let hasNodeSqlite = true;
try {
  await import('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

const FRESH_DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'magnet-bank-test-'));
const hex = (c: string) => c.repeat(40);
const magnet = (h: string, extra = '') => `magnet:?xt=urn:btih:${h}${extra}`;
const sleeper = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  bank.resetForTests();
  // Diretório como caminho: o SQLite não abre e o engine de memória assume.
  bank.open(FRESH_DIR());
  // O `mag` é durável (`data/cache.db`) e o lie global é a UNIÃO de contas:
  // um hash `6.repeat(40)` de outra suíte voltaria como lie. Isola o teste.
  cache.clearNamespace('mag');
  metrics.reset();
  config.magnetBank.enabled = true;
  config.magnetBank.queueMax = 500;
  config.magnetDb.enabled = true;
  config.magnetDb.lieEnabled = true;
});

after(() => {
  bank.resetForTests();
});

test('merge: first_seen fixo, seeders_max máximo, flags OR, quality/título/size primeiros', () => {
  const h = hex('a');
  const rich = magnet(h, `&dn=Filme%202024&tr=${encodeURIComponent('https://custom.example/announce')}`);
  bank.captureItems([
    { title: 'Filme 2024 Dublado 1080p', infoHash: h, size: 111, seeders: 3, isBr: true, dubbed: true, quality: '1080p', magnet: rich },
  ], 'nerdfilmes', { imdbId: 'tt111', season: null, episode: null });
  bank.flushNow();

  const first = bank.lookup(h);
  assert.ok(first);
  assert.ok(first!.firstSeen > 0);

  bank.captureItems([
    { title: '', infoHash: h, size: 0, seeders: 9, magnet: magnet(h), quality: '' },
  ], 'global', { imdbId: 'tt111', season: null, episode: null });
  bank.flushNow();

  const merged = bank.lookup(h)!;
  assert.equal(merged.firstSeen, first!.firstSeen, 'first_seen nunca regride');
  assert.ok(merged.lastSeen >= first!.lastSeen, 'last_seen avança na nova escrita');
  assert.equal(merged.seedersMax, 9, 'seeders_max é o máximo observado');
  assert.equal(merged.seedersLast, 9, 'seeders_last é a última observação');
  assert.equal(merged.isBr, 1, 'is_br é OR');
  assert.equal(merged.dubbed, 1, 'dubbed é OR');
  assert.equal(merged.title, 'Filme 2024 Dublado 1080p', 'título é o primeiro não vazio');
  assert.equal(merged.size, 111, 'tamanho é o primeiro não vazio');
  assert.equal(merged.quality, '1080p', 'quality é o primeiro não vazio');
  assert.equal(merged.uri, first!.uri, 'URI padrão não rebaixa a URI rica do post');
  assert.equal(bank.sourcesFor(h).length, 2, 'as duas fontes ficam registradas');
});

test('seeders_last: ausente preserva a anterior; 0 explícito é observação', () => {
  const h = hex('b');
  bank.captureItems([{ title: 'S', infoHash: h, seeders: 5, magnet: magnet(h) }], 'x', {});
  bank.flushNow();
  assert.equal(bank.lookup(h)!.seedersLast, 5);
  assert.equal(bank.sourcesFor(h)[0].seedersLast, 5);

  // Item SEM seeders: preserva a última observação (não vira 0).
  bank.captureItems([{ title: 'S', infoHash: h, magnet: magnet(h) }], 'x', {});
  bank.flushNow();
  assert.equal(bank.lookup(h)!.seedersLast, 5, 'ausente preserva o magnet');
  assert.equal(bank.sourcesFor(h)[0].seedersLast, 5, 'ausente preserva a fonte');

  // 0 explícito É observação válida.
  bank.captureItems([{ title: 'S', infoHash: h, seeders: 0, magnet: magnet(h) }], 'x', {});
  bank.flushNow();
  assert.equal(bank.lookup(h)!.seedersLast, 0, '0 explícito sobrescreve');
  assert.equal(bank.lookup(h)!.seedersMax, 5, 'seeders_max continua o máximo');
  assert.equal(bank.sourcesFor(h)[0].seedersLast, 0);
});

test('URI só sobe por riqueza: mais trackers e depois dn=; empate/queda preserva', () => {
  const h = hex('c');
  const t1 = encodeURIComponent('https://t1.example/announce');
  const t2 = encodeURIComponent('https://t2.example/announce');
  const capture = (uri: string) => {
    bank.captureItems([{ title: 'U', infoHash: h, magnet: uri }], 'x', {});
    bank.flushNow();
    return bank.lookup(h)!.uri;
  };
  const base = capture(magnet(h));
  assert.equal(base.includes('dn='), false);

  const one = capture(magnet(h, `&tr=${t1}`));
  assert.equal(one.includes(t1), true, 'um tracker a mais é mais rico que o piso');

  const two = capture(magnet(h, `&tr=${t1}&tr=${t2}`));
  assert.equal(two.includes(t2), true, 'dois trackers vencem um');

  const backToOne = capture(magnet(h, `&tr=${t1}`));
  assert.equal(backToOne, two, 'menos trackers NÃO rebaixa a URI guardada');

  const withDn = capture(magnet(h, '&dn=Release%20Completa'));
  assert.match(withDn, /dn=Release/, 'dn= vence mesmo com menos trackers');
});

test('hashOf tenta infoHash, magnet, MagnetUri e Guid até achar válido', () => {
  const h1 = hex('1');
  const h2 = hex('2');
  const h3 = hex('3');
  bank.captureItems([
    { title: 'A', infoHash: 'nao-e-hash', magnet: magnet(h1) },
    { title: 'B', infoHash: '', MagnetUri: magnet(h2), Guid: 'https://site/pagina' },
    { title: 'C', Guid: magnet(h3) },
  ], 'x', {});
  bank.flushNow();
  assert.equal(bank.lookup(h1)?.hash, h1, 'infoHash inválido cede para magnet');
  assert.equal(bank.lookup(h2)?.hash, h2, 'MagnetUri cobre infoHash ausente');
  assert.equal(bank.lookup(h3)?.hash, h3, 'Guid de magnet é aceito');
  assert.equal(bank.status().magnets, 3);
});

test('merge na mesma leva: magnet coalesce e fontes por indexer coexistem', () => {
  const h = hex('d');
  const t1 = encodeURIComponent('https://t1.example/announce');
  bank.captureItems([
    { title: '', infoHash: h, seeders: 2, tracker: 'Tracker A', magnet: magnet(h) },
    { title: 'Primeiro Nome', infoHash: h, seeders: 7, tracker: 'Tracker B', quality: '720p', magnet: magnet(h, `&tr=${t1}`) },
  ], 'nerdfilmes', {});
  bank.flushNow();

  const row = bank.lookup(h)!;
  assert.equal(row.title, 'Primeiro Nome', 'título cai no primeiro não vazio da leva');
  assert.equal(row.quality, '720p');
  assert.equal(row.seedersMax, 7);
  assert.equal(row.seedersLast, 7, 'última captura da leva vence');
  assert.equal(row.uri.includes(t1), true, 'URI mais rica da leva vence');
  const sources = bank.sourcesFor(h);
  assert.equal(sources.length, 1, 'mesmo indexer continua uma fonte só');

  // Segundo indexer: fonte nova, mesmo magnet.
  bank.captureItems([{ title: '', infoHash: h, seeders: 1, magnet: magnet(h) }], 'global', {});
  bank.flushNow();
  assert.equal(bank.sourcesFor(h).length, 2, 'indexers distintos geram fontes distintas');
});

test('passed_filter: 1 sobrevivente e 0 cortado; captura futura sem filtro derruba 1→0', () => {
  const ctx = { imdbId: 'tt900', season: 1, episode: 2, resetPassedFilter: true };
  const survivor = { title: 'Serie S01E02 Dublado', infoHash: hex('e'), magnet: magnet(hex('e')) };
  const cut = { title: 'Outra Coisa S01E02', infoHash: hex('f'), magnet: magnet(hex('f')) };
  bank.captureItems([survivor, cut], 'bludv', ctx);
  bank.markFilterResult([survivor.infoHash, cut.infoHash], [survivor.infoHash], ctx);
  bank.flushNow();
  assert.equal(bank.worksFor(survivor.infoHash)[0].passedFilter, 1);
  assert.equal(bank.worksFor(cut.infoHash)[0].passedFilter, 0, 'cortado fica 0');

  // Nova captura da MESMA obra sem resultado de filtro: última observação = 0.
  bank.captureItems([survivor], 'bludv', ctx);
  bank.flushNow();
  assert.equal(bank.worksFor(survivor.infoHash)[0].passedFilter, 0, '1→0 na captura sem filtro');

  // A mesma busca promove de novo.
  bank.markFilterResult([survivor.infoHash], [survivor.infoHash], ctx);
  bank.flushNow();
  assert.equal(bank.worksFor(survivor.infoHash)[0].passedFilter, 1, '0→1 na marca da mesma busca');
});

test('markFilterResult não cria work órfão de fonte não Jackett', () => {
  const ctx = { imdbId: 'tt901', season: null, episode: null };
  const orphan = hex('0');
  bank.markFilterResult([orphan], [orphan], ctx);
  bank.flushNow();
  assert.equal(bank.worksFor(orphan).length, 0, 'fonte sem captura não cria obra');
  assert.equal(bank.status().works, 0);

  // Com uma captura existente, o filtro atualiza SÓ ela.
  const captured = hex('9');
  bank.captureItems([{ title: 'X', infoHash: captured, magnet: magnet(captured) }], 'jackett', ctx);
  bank.markFilterResult([captured, orphan], [captured], ctx);
  bank.flushNow();
  assert.equal(bank.worksFor(captured)[0].passedFilter, 1);
  assert.equal(bank.worksFor(orphan).length, 0, 'órfão continua fora');
});

test('item de conta (fromAccount) fica fora da captura', () => {
  const account = hex('8');
  const site = hex('7');
  bank.captureItems([
    { title: 'Ja na conta', infoHash: account, magnet: magnet(account), fromAccount: true },
    { title: 'Do site', infoHash: site, magnet: magnet(site) },
  ], 'nerdfilmes', {});
  bank.flushNow();
  assert.equal(bank.lookup(account), null, 'inventário da conta não é acervo do site');
  assert.equal(bank.lookup(site)?.hash, site);
});

test('lie global: recém-marcado é visto, OR em linha existente, expirado é ignorado', async () => {
  // OR em linha existente: linha nasce lied=0 e o lie global posterior promove.
  const h = hex('6');
  bank.captureItems([{ title: 'X', infoHash: h, lied: false, magnet: magnet(h) }], 'x', {});
  bank.flushNow();
  assert.equal(bank.lookup(h)!.lied, 0);
  magnetdb.markLie('alldebrid', 'chave-de-teste', h);
  bank.captureItems([{ title: 'X', infoHash: h, lied: false, magnet: magnet(h) }], 'x', {});
  bank.flushNow();
  assert.equal(bank.lookup(h)!.lied, 1, 'lie global recém-gravado é visto sem janela');

  // Chave `lie` EXPIRADA não condena: `peek` ignora o vencido.
  const expired = hex('5');
  const key = `${prefix('mag')}lie:alldebrid:${accountScope('chave-expirada')}:${expired}`;
  cache.set(key, 1, 0.001);
  await sleeper();
  bank.captureItems([{ title: 'Y', infoHash: expired, lied: false, magnet: magnet(expired) }], 'x', {});
  bank.flushNow();
  assert.equal(bank.lookup(expired)!.lied, 0, 'lie expirado não conta');
});
