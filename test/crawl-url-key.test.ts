// Fase 8 — identidade de página do `crawl.db` por `(site, url_key)`, com a
// chave sendo o CAMINHO (e a `url` gravada sendo o host vigente).
//
// Cobre três camadas, porque o defeito mora nas três:
//   1. a chave pura (host novo = mesma página; barra final, `//`, query e
//      fragmento não criam linha nova; entrada malformada nunca vira `''`,
//      que colapsaria a fila inteira);
//   2. a FUSÃO das linhas que passaram a ser a mesma coisa (quem sobrevive:
//      progresso > inflight > partial > error > done > …, com `releases` no
//      máximo e `addedAt` no mínimo);
//   3. o ARMAZAMENTO de verdade — as DUAS engines (memória sempre, SQLite
//      quando `node:sqlite` existe) e a MIGRAÇÃO de um `crawl.db` no formato
//      antigo (chave `(site,url)`, sem `url_key`/`progress`), que é o que
//      roda no primeiro boot depois do deploy.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/utils/crawl-store.js';
import { crawlUrlKey, mergeCrawlUrlRows } from '../src/utils/crawl-url-key.js';
import type { CrawlUrlRow } from '../src/providers/crawl-types.js';

let hasNodeSqlite = true;
let sqlite: typeof import('node:sqlite') | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  hasNodeSqlite = false;
}
const skipSemSqlite = !hasNodeSqlite && 'node:sqlite indisponível — precisa de Node 22+';

const tempDirs: string[] = [];
const freshDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-key-'));
  tempDirs.push(d);
  return d;
};
const movie = (url: string, lastmod = '2026-09-25') => ({ url, lastmod, kind: 'movie' as const });

function row(over: Partial<CrawlUrlRow> = {}): CrawlUrlRow {
  return {
    site: 'vacatorrent', url: 'https://a.com/p/1', lastmod: '2026-01-01', kind: 'movie',
    status: 'pending', imdb: null, tries: 0, nextAt: 0, checkedAt: 0, releases: 0,
    error: '', progress: '', addedAt: 10, ...over,
  };
}

after(() => {
  store.resetForTests();
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('chave pura: o CAMINHO é a identidade da página', () => {
  test('troca de domínio não cria página nova', () => {
    const antigo = crawlUrlKey('https://xnerdfilmes.net/filme/tard-season-1-dublado/');
    const novo = crawlUrlKey('https://www.filmesviatorrenthd.net/filme/tard-season-1-dublado/');
    assert.equal(antigo, novo, 'mesmo caminho, mesmo site lógico: uma linha só');
    assert.equal(crawlUrlKey('http://vaqueirofilmes.com/pt/filmes/x/'), crawlUrlKey('https://vaqueirofilmes.com/pt/filmes/x/'));
  });

  test('normalização: barra final, //, query e fragmento não inventam página', () => {
    const base = crawlUrlKey('https://x.com/a/b');
    assert.equal(base, '/a/b');
    assert.equal(crawlUrlKey('https://x.com/a/b/'), base, 'barra final fora');
    assert.equal(crawlUrlKey('https://x.com/a//b'), base, '// colapsada');
    assert.equal(crawlUrlKey('https://x.com/a/b?utm_source=wp&nocache=1'), base, 'query é ruído de rastreio');
    assert.equal(crawlUrlKey('https://x.com/a/b#anexo'), base, 'fragmento nunca é identidade');
    assert.equal(crawlUrlKey('https://x.com'), '/', 'host sem caminho é a raiz');
  });

  test('caminhos diferentes continuam páginas diferentes', () => {
    assert.notEqual(crawlUrlKey('https://x.com/a'), crawlUrlKey('https://x.com/b'));
    assert.notEqual(crawlUrlKey('https://x.com/filme/1'), crawlUrlKey('https://x.com/filme/10'));
    assert.notEqual(crawlUrlKey('https://x.com/a%2Fb'), crawlUrlKey('https://x.com/a/b'), 'encoding não se mistura');
  });

  test('relativa e malformada: mesma normalização, nunca vazia', () => {
    assert.equal(crawlUrlKey('/a/b/'), '/a/b', 'relativa (linha legada/teste sem host)');
    assert.equal(crawlUrlKey('a/b'), 'a/b', 'relativa sem barra inicial não vira raiz');
    assert.equal(crawlUrlKey('https://x.com//'), '/');
    assert.equal(crawlUrlKey('https://x.com?p=1'), '/');
    // O caso catastrófico: chave vazia colapsaria TODA a fila do site numa
    // linha — o sintoma seria "12 h de raspagem sem ler nada".
    for (const ruim of ['::::', 'http://', '%%%', '?x=1', '  /a  ']) {
      assert.notEqual(crawlUrlKey(ruim), '', `entrada ${JSON.stringify(ruim)} não pode virar chave vazia`);
    }
    assert.equal(crawlUrlKey('  /a  '), '/a', 'espaço em volta é aparado, não é parte do caminho');
    assert.equal(crawlUrlKey(''), '', 'vazio é vazio (e o chamador recusa)');
    assert.equal(crawlUrlKey('   '), '', 'só espaço é entrada vazia, não caminho');
  });
});

describe('fusão: duas linhas do mesmo caminho viram uma só', () => {
  test('vence a linha com trabalho registrado, e o resto não se perde', () => {
    const done = row({ url: 'https://antigo.com/p', status: 'done', imdb: 'tt7', releases: 4, checkedAt: 100, addedAt: 10 });
    const erro = row({ url: 'https://novo.com/p', status: 'error', error: '403', tries: 2, nextAt: 900, checkedAt: 200, addedAt: 20 });
    const parcial = row({ url: 'https://novo.com/p', status: 'partial', progress: '{"v":1,"doneCards":["/c"],"totalCards":9}', checkedAt: 300, addedAt: 30 });
    const merged = mergeCrawlUrlRows([done, erro, parcial]) as CrawlUrlRow;
    assert.equal(merged.status, 'partial', 'progresso de série é o trabalho mais caro: não se perde');
    assert.equal(merged.tries, 2, 'tentativas com backoff sobrevivem');
    assert.equal(merged.releases, 4, 'contagem de releases não zera por causa da fusão');
    assert.equal(merged.imdb, 'tt7', 'obra resolvida antes sobrevive');
    assert.equal(merged.checkedAt, 300, 'último toque é o mais recente');
    assert.equal(merged.addedAt, 10, 'entrada mais antiga preserva a ordem da fila');
  });

  test('progresso vence status, e a escolha é determinística', () => {
    const pend = row({ url: 'https://x.com/p', status: 'pending' });
    const comProgresso = row({ url: 'https://x.com/p', status: 'pending', progress: '{"v":1,"doneCards":[],"totalCards":0}' });
    const merged = mergeCrawlUrlRows([pend, comProgresso]) as CrawlUrlRow;
    assert.equal(merged.progress, comProgresso.progress);
    // Mesma entrada em ordem invertida dá o MESMO resultado (a migração é
    // one-shot: rodar duas vezes não pode dar estados diferentes).
    assert.deepEqual(merged, mergeCrawlUrlRows([comProgresso, pend]));
  });

  test('fail com backoff vence sucesso, e lista vazia devolve null', () => {
    const done = row({ url: 'https://x.com/p', status: 'done' });
    const erro = row({ url: 'https://x.com/p', status: 'error', error: '500', tries: 1, nextAt: 5000 });
    const merged = mergeCrawlUrlRows([done, erro]) as CrawlUrlRow;
    assert.equal(merged.status, 'error', 'reenfileirar é o lado barato; perder o done é o caro');
    assert.equal(merged.nextAt, 5000, 'a dormência do backoff passa junto');
    assert.equal(merged.error, '500');
    assert.equal(mergeCrawlUrlRows([]), null);
  });
});

describe('armazenamento: as DUAS engines keyed por (site, url_key)', () => {
  const engines: Array<[string, () => void]> = [['memória', () => {
    store.resetForTests();
    store.open(undefined, { forceMemory: true });
  }]];
  if (hasNodeSqlite) engines.push(['sqlite', () => {
    store.resetForTests();
    store.open(path.join(freshDir(), 'crawl.db'));
  }]);

  for (const [nome, abrir] of engines) {
    test(`${nome}: mesma página em host novo é a MESMA linha`, () => {
      abrir();
      const e = store.engine();
      assert.deepEqual(e.upsertUrls('vacatorrent', [movie('https://antigo.com/a')], 1000), { added: 1, refreshed: 0, unchanged: 0 });
      e.markResult('vacatorrent', 'https://antigo.com/a', { status: 'done', imdb: 'tt1', releases: 3 }, 2000);
      // Redescoberta no domínio novo, mesmo lastmod: o estado NÃO é refeito,
      // mas a URL gravada passa a ser a do host vigente.
      assert.deepEqual(e.upsertUrls('vacatorrent', [movie('https://novo.com/a')], 3000), { added: 0, refreshed: 0, unchanged: 1 });
      const linha = e.getUrl('vacatorrent', 'https://novo.com/a') as CrawlUrlRow;
      assert.ok(linha, 'a linha é encontrada pelo host novo');
      assert.equal(linha.status, 'done', 'o acervo da página sobrevive à migração de domínio');
      assert.equal(linha.releases, 3);
      assert.equal(linha.url, 'https://novo.com/a', 'a URL gravada é a do host atual');
      assert.equal(e.counters('vacatorrent').total, 1, 'não nasce página duplicada');
    });

    test(`${nome}: marcação e reenfileiramento por qualquer host batem na mesma linha`, () => {
      abrir();
      const e = store.engine();
      e.upsertUrls('nerdfilmes', [movie('https://a.com/p')], 1000);
      assert.equal(e.requeueUrl('nerdfilmes', 'https://b.com/p/'), true, 'host diferente, mesmo caminho');
      e.markResult('nerdfilmes', 'https://a.com/p', { status: 'done', imdb: 'tt2', releases: 1 }, 2000);
      assert.equal(e.getUrl('nerdfilmes', 'https://b.com/p')?.status, 'done');
      assert.equal(e.getUrl('nerdfilmes', 'https://b.com/OUTRA'), null, 'caminho outro é linha outra');
    });

    test(`${nome}: ordem de retomada é determinística pelo caminho`, () => {
      abrir();
      const e = store.engine();
      e.upsertUrls('vacatorrent', [movie('https://x.com/c'), movie('https://x.com/a'), movie('https://x.com/b')], 1000);
      assert.equal(e.takeNext('vacatorrent', 2000)?.url, 'https://x.com/a');
      assert.equal(e.takeNext('vacatorrent', 2000)?.url, 'https://x.com/b');
      assert.equal(e.takeNext('vacatorrent', 2000)?.url, 'https://x.com/c');
      assert.equal(e.takeNext('vacatorrent', 2000), null);
    });

    test(`${nome}: "Zerar site" leva as linhas do site e só dele`, () => {
      abrir();
      const e = store.engine();
      e.upsertUrls('vacatorrent', [movie('https://x.com/a')], 1000);
      e.upsertUrls('nerdfilmes', [movie('https://y.com/a')], 1000);
      assert.equal(e.clearSite('vacatorrent').urls, 1);
      assert.equal(e.counters('vacatorrent').total, 0);
      assert.equal(e.counters('nerdfilmes').total, 1);
    });
  }
});

describe('migração do crawl.db legado (chave (site,url))', { skip: skipSemSqlite }, () => {
  const LEGACY_DDL = `
    CREATE TABLE crawl_url (
      site TEXT NOT NULL, url TEXT NOT NULL, lastmod TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'movie', status TEXT NOT NULL DEFAULT 'pending',
      imdb TEXT, tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      checked_at INTEGER NOT NULL DEFAULT 0, releases INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (site, url)
    );`;

  type Insert = [string, string, string, number, number];
  const legacyDb = (inserts: Insert[], ddl = LEGACY_DDL): string => {
    const dbPath = path.join(freshDir(), 'crawl.db');
    const db = new (sqlite as typeof import('node:sqlite')).DatabaseSync(dbPath);
    db.exec(ddl);
    for (const [site, url, status, releases, added] of inserts) {
      db.prepare('INSERT INTO crawl_url (site, url, lastmod, status, releases, checked_at, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(site, url, '2026-01-01', status, releases, 1000, added);
    }
    db.close();
    return dbPath;
  };

  test('banho legado migra a identidade, funde duplicatas e preserva o estado', () => {
    const dbPath = legacyDb([
      ['vacatorrent', 'https://antigo.com/p', 'done', 4, 1],
      ['vacatorrent', 'https://novo.com/p', 'pending', 0, 2],   // mesma página, host novo
      ['vacatorrent', 'https://antigo.com/outra/', 'error', 0, 3],
    ]);
    store.resetForTests();
    store.open(dbPath);
    const e = store.engine();
    assert.equal(e.kind, 'sql', 'o banco migrado segue em SQLite (não caiu para memória)');
    const linha = e.getUrl('vacatorrent', 'https://qualquer.com/p') as CrawlUrlRow;
    assert.equal(linha.status, 'done', 'a página já lida continua lida');
    assert.equal(linha.releases, 4);
    assert.equal(linha.addedAt, 1, 'ordem da fila preservada');
    assert.equal(e.counters('vacatorrent').total, 2, '/p colapsou numa linha; /outra é outra');
    const erro = e.getUrl('vacatorrent', 'https://antigo.com/outra') as CrawlUrlRow;
    assert.equal(erro.status, 'error', 'linha legada com barra final continua endereçável');
    store.resetForTests();
  });

  test('o esquema migrado tem a chave (site,url_key) e a url_key preenchida', () => {
    const dbPath = legacyDb([['vacatorrent', 'https://x.com/p', 'pending', 0, 1]]);
    store.resetForTests();
    store.open(dbPath);
    store.close();
    const { DatabaseSync } = sqlite as typeof import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    const ddl = String((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='crawl_url'").get() as Record<string, unknown>).sql);
    assert.match(ddl, /PRIMARY KEY \(site, url_key\)/, 'a identidade passa a ser o caminho');
    const r = db.prepare('SELECT url, url_key FROM crawl_url').get() as Record<string, unknown>;
    assert.equal(String(r.url_key), '/p');
    assert.equal(String(r.url), 'https://x.com/p', 'a URL continua gravada inteira');
    db.close();
  });

  test('reabrir o banco já migrado é no-op (idempotente, sem rebuild)', () => {
    const dbPath = legacyDb([['vacatorrent', 'https://x.com/p', 'done', 2, 1]]);
    store.resetForTests();
    store.open(dbPath);
    // Mesmo lastmod no host novo: o conteúdo é o mesmo, então o estado fica.
    store.engine().upsertUrls('vacatorrent', [movie('https://y.com/p', '2026-01-01')], 2000);
    // Lastmod novo (conteúdo mudou): reprocessa do zero — e a identidade
    // continua sendo o caminho, não a URL.
    store.engine().upsertUrls('vacatorrent', [movie('https://y.com/p', '2026-02-02')], 2500);
    store.close();
    store.open(dbPath);
    const linha = store.engine().getUrl('vacatorrent', 'https://y.com/p') as CrawlUrlRow;
    assert.equal(linha.status, 'pending', 'lastmod novo manda reprocessar');
    assert.equal(linha.releases, 0, 'conteúdo novo não herda a contagem antiga');
    assert.equal(linha.url, 'https://y.com/p');
    // O lastmod novo re-enfileira como NOVIDADE (added_at = o momento da
    // redescoberta, a fila é `added_at DESC`); a segunda abertura não o mexe.
    assert.equal(linha.addedAt, 2500, 'a segunda abertura não recriou a linha');
    assert.equal(store.engine().counters('vacatorrent').total, 1, 'nenhuma página duplicada');
    store.resetForTests();
  });

  test('banco com CHECK legada ainda migra (uma transação serve às duas causas)', () => {
    const dbPath = legacyDb([['fake', '/a', 'done', 4, 1]], `
      CREATE TABLE crawl_url (
        site TEXT NOT NULL, url TEXT NOT NULL, lastmod TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'movie',
        status TEXT NOT NULL CHECK (status IN ('pending','inflight','done','no-torrent','no-work','error')),
        imdb TEXT, tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        checked_at INTEGER NOT NULL DEFAULT 0, releases INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (site, url)
      );`);
    store.resetForTests();
    store.open(dbPath);
    const e = store.engine();
    assert.equal(e.kind, 'sql');
    assert.equal(e.getUrl('fake', '/a')?.status, 'done');
    // A CHECK antiga rejeitaria o status novo; a migração já a removeu.
    e.markResult('fake', '/a', { status: 'simulated', releases: 1 }, 500);
    assert.equal(e.getUrl('fake', '/a')?.status, 'simulated');
    store.resetForTests();
  });

  test('coluna legada ausente (progress) nasce vazia, linha preservada', () => {
    const dbPath = legacyDb([['fake', '/antiga', 'done', 5, 1]]);
    store.resetForTests();
    store.open(dbPath);
    const linha = store.engine().getUrl('fake', '/antiga') as CrawlUrlRow;
    assert.equal(linha.status, 'done');
    assert.equal(linha.releases, 5);
    assert.equal(linha.progress, '');
    assert.equal(linha.kind, 'movie');
    store.resetForTests();
  });
});
