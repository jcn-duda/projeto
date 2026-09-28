// Sonda amostral por site (Fase 8, 8.3), parte 2: a FRONTEIRA do processo.
//
// O bloco de relatório cobre a decisão de segurança (nenhum cookie, token ou
// URL de protetor no que sai) e o parse de CLI/env — com a gravação do veredito
// como ÓPT-IN por `--write`, porque o veredito gravado é a autorização de
// entrada do site na rotação. O bloco do entry-point responde ao pedido mais
// concreto do defeito: `--help` e flag desconhecida saem ANTES de abrir o
// `crawl.db` ou resolver adaptador, provado por processo separado (o diretório
// do `CRAWL_DB_PATH` não pode nem ser criado) e por ordem estrutural no
// código-fonte. O bloco final é a promessa operacional da sonda, verificada
// pelo MESMO `processCrawlPage` que a produção usa: em dry-run + noPersist ela
// não escreve `crawl_url`, não muda o status de uma linha que já existe e não
// toca o acervo — só a linha sintética da amostra, que não existe em lugar
// nenhum.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const { createPageProcessor, processCrawlPage } = await import('../src/providers/crawl-page.js');
const { DEFAULT_PROBE_THRESHOLDS, PROBE_STATE_KEY, classifyPage, summarize } = await import('../src/providers/crawl-site-probe.js');
const {
  PROBE_USAGE, pageSlug, parseProbeArgv, parseProbeOptions, probeArgGate, scrub,
} = await import('../src/providers/crawl-site-probe-report.js');
import type { PageCollaborators } from '../src/providers/crawl-page.js';
import type { PageReading } from '../src/providers/crawl-site-probe.js';
import type { CrawlDiscovery, CrawlSite, CrawlUrlRow } from '../src/providers/crawl-types.js';
import type { RawItem } from '../types/domain.js';


// --- Relatório sem segredo --------------------------------------------------

describe('sonda: relatório não carrega segredo', () => {
  test('cookie, token e URL de protetor saem redigidos', () => {
    const sujo = 'falhou em https://systemtech.space/gate?token=abc123&api_key=SEGREDO '
      + 'Cookie: enc_liberado=xyz; cf_clearance=zzz; '
      + 'https://magnet-down.example/redirect?h=1 Authorization: Bearer eyJhbGciOi';
    const limpo = scrub(sujo);
    assert.ok(!limpo.includes('systemtech.space'), 'host de protetor não pode atravessar');
    assert.ok(!limpo.includes('magnet-down.example'), 'URL de protetor não pode atravessar');
    assert.ok(!limpo.includes('SEGREDO'), 'chave de API não pode atravessar');
    assert.ok(!limpo.includes('abc123'), 'token não pode atravessar');
    assert.ok(!limpo.includes('enc_liberado'), 'cookie não pode atravessar');
    assert.ok(!limpo.includes('eyJhbGciOi'), 'bearer não pode atravessar');
    assert.ok(limpo.includes('[url]'), 'a ocorrência de URL é marcada, não omitida em silêncio');
  });

  test('`api_key` colado com espaço ou como header também é redigido', () => {
    for (const sujo of ['x apikey=SEGREDO', 'api_key = SEGREDO', 'x-api-key:SEGREDO', "session='SEGREDO'"]) {
      assert.ok(!scrub(sujo).includes('SEGREDO'), `sujo=${sujo}`);
    }
    // O `pass` solto só é redigido na forma `=`: em texto corrido "pass: 3
    // páginas" é palavra, e trocar por *** destruiria o diagnóstico.
    assert.equal(scrub('pass: 3 páginas'), 'pass: 3 páginas');
    assert.equal(scrub({ message: 'x'.repeat(500) }).length, 201, 'texto longo é truncado');
    assert.equal(scrub('erro\nde\ttab'), 'erro de tab', 'espaçamento colapsado (relatório de uma linha)');
  });

  test('a página entra no relatório como SLUG, sem host e sem query', () => {
    const slug = pageSlug('https://vaqueirofilmes.com/pt/movie/expresso-do-amanha/?utm=1#x');
    assert.equal(slug, 'expresso-do-amanha');
    assert.ok(!slug.includes('vaqueirofilmes'), 'o host do failover não vaza no relatório');
    assert.equal(pageSlug('https://x.tld/a/b/'), 'b');
    assert.equal(pageSlug('lixo-sem-slash'), 'lixo-sem-slash');
  });
});

// --- Opções (CLI/env) -------------------------------------------------------

describe('sonda: opções da rodada', () => {
  const defaults = { site: 'vacatorrent', delayMs: 1000, seriesMaxCards: 10, seriesMaxButtons: 40 };

  test('default < env < CLI', () => {
    assert.equal(parseProbeOptions([], {}, defaults).sample, 40);
    assert.equal(parseProbeOptions([], { CRAWL_PROBE_SAMPLE: '12' }, defaults).sample, 12);
    assert.equal(parseProbeOptions(['--sample=8'], { CRAWL_PROBE_SAMPLE: '12' }, defaults).sample, 8);
  });

  test('site, offset, série e --out', () => {
    const o = parseProbeOptions(['--site=nerdfilmes', '--offset=13', '--series', '--out=/tmp/rel.json'], {}, defaults);
    assert.equal(o.site, 'nerdfilmes');
    assert.equal(o.offset, 13);
    assert.equal(o.series, true);
    assert.equal(o.out, '/tmp/rel.json');
    assert.equal(parseProbeOptions([], {}, { ...defaults, site: '' }).site, '', 'sem site, sem env e sem default: quem chama decide');
    assert.equal(parseProbeOptions([], { CRAWL_PROBE_SITE: 'bludv' }, defaults).site, 'bludv');
  });

  test('a escrita do veredito é ÓPT-IN: só `--write` grava', () => {
    // O veredito gravado é a AUTORIZAÇÃO de entrada do site na rotação: quem
    // não pediu, não libera. O default antigo (`!argv.includes('--no-write')`)
    // gravava por omissão — e `--no_write` gravava do mesmo jeito.
    assert.equal(parseProbeOptions([], {}, defaults).write, false, 'sem flag: nada é gravado');
    assert.equal(parseProbeOptions(['--no-write'], {}, defaults).write, false);
    assert.equal(parseProbeOptions(['--site=nerdfilmes'], {}, defaults).write, false, 'outra flag não é pedido de escrita');
    assert.equal(parseProbeOptions(['--write'], {}, defaults).write, true);
    // O ambiente NÃO liga: a autorização é da chamada explícita do operador.
    assert.equal(parseProbeOptions([], { CRAWL_PROBE_WRITE: 'true' }, defaults).write, false);
  });

  test('typo de flag é REJEITADO, nunca lido como "observe"', () => {
    for (const argv of [['--no_write'], ['--write=false'], ['--site'], ['--qualquer=1'], ['-w'], ['--helpp']]) {
      const parsed = parseProbeArgv(argv, {}, defaults);
      assert.equal(parsed.kind, 'error', `${argv.join(' ')} tem de ser erro, não rodada`);
      if (parsed.kind === 'error') assert.match(parsed.message, /--write/);
    }
    // Mesmo pelo parse cru (sem o gate), nenhuma forma malformada vira escrita.
    for (const argv of [['--no_write'], ['--write=false'], ['-w']]) {
      assert.equal(parseProbeOptions(argv, {}, defaults).write, false, argv.join(' '));
    }
  });

  test('--help/-h é desfecho próprio e a contradição é erro', () => {
    for (const flag of ['--help', '-h']) {
      const parsed = parseProbeArgv([flag], {}, defaults);
      assert.equal(parsed.kind, 'help', flag);
      if (parsed.kind === 'help') assert.equal(parsed.usage, PROBE_USAGE);
    }
    const contradiction = parseProbeArgv(['--write', '--no-write'], {}, defaults);
    assert.equal(contradiction.kind, 'error');
    if (contradiction.kind === 'error') assert.match(contradiction.message, /--write e --no-write/);
  });

  test('o uso documenta TODA flag aceita, e o gate aceita só o que o uso lista', () => {
    // Fecha o drift: a lista viva é a do gate, e o texto tem que cobrir cada
    // nome — o contrário (flag que só existe num dos dois) é o que devolve o
    // "flag desconhecida" para o operador no meio de uma rodada.
    const booleanas = ['--series', '--write', '--no-write'];
    const comValor = [
      '--site', '--sample', '--offset', '--delay-ms', '--out',
      '--min-valid', '--min-magnet', '--min-identify', '--min-magnets',
    ];
    for (const flag of booleanas) {
      assert.deepEqual(probeArgGate([flag]).unknown, [], `${flag} tem de ser aceita`);
      assert.ok(PROBE_USAGE.includes(flag), `${flag} ausente do uso`);
    }
    for (const flag of comValor) {
      assert.deepEqual(probeArgGate([`${flag}=1`]).unknown, [], `${flag}= tem de ser aceita`);
      assert.ok(PROBE_USAGE.includes(flag), `${flag} ausente do uso`);
    }
    for (const flag of ['--help', '-h']) assert.ok(PROBE_USAGE.includes(flag), `${flag} ausente do uso`);
    assert.ok(PROBE_USAGE.includes('probe:verdict'), 'o uso diz o que a --write escreve');
  });

  test('valor fora de faixa cai no default (limiar >1 ou negativo é erro de dedo)', () => {
    const o = parseProbeOptions(['--sample=0', '--min-valid=5', '--offset=-4', '--delay-ms=abc'], {}, defaults);
    assert.equal(o.sample, 40);
    assert.equal(o.thresholds.validRate, DEFAULT_PROBE_THRESHOLDS.validRate, 'taxa fora de 0..1 é ignorada');
    assert.equal(o.offset, 0);
    assert.equal(o.delayMs, defaults.delayMs);
  });

  test('limiares por eixo, incluindo magnts/página (que passa de 1)', () => {
    const o = parseProbeOptions(['--min-valid=0.4', '--min-magnet=0.3', '--min-identify=0.2', '--min-magnets=2.5'], {}, defaults);
    assert.equal(o.thresholds.validRate, 0.4);
    assert.equal(o.thresholds.magnetRate, 0.3);
    assert.equal(o.thresholds.identifyRate, 0.2);
    assert.equal(o.thresholds.magnetsPerPage, 2.5);
  });
});

// (a trava de gravação por tipo de página tem suíte própria, `crawl-site-probe-write`)


describe('sonda: o entry-point responde antes de abrir store ou raspar', () => {
  const script = fileURLToPath(new URL('../scripts/crawl-site-probe.js', import.meta.url));

  /** `CRAWL_DB_PATH` aponta para um diretório que NÃO existe: a `sqliteEngine`
   *  faz `mkdirSync(dirname(dbPath))` ao abrir, então a ausência do diretório
   *  depois do processo prova que o store não foi aberto. */
  function runCli(args: string[], dbDir: string) {
    return spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CRAWL_DB_PATH: path.join(dbDir, 'crawl.db'),
        CRAWL_ENABLED: 'false',
        CRAWL_DRY_RUN: 'true',
        CRAWL_SITES: 'vacatorrent',
      },
      timeout: 60_000,
    });
  }

  for (const flag of ['--help', '-h']) {
    test(`${flag} sai 0 com o uso, sem abrir o crawl.db e sem rodar a sonda`, () => {
      const dbDir = path.join(os.tmpdir(), `adom-sonda-${process.pid}-${flag.replace(/-/g, '')}`);
      const r = runCli([flag], dbDir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /--site=<id>/);
      assert.match(r.stdout, /--sample=<n>/);
      assert.match(r.stdout, /--offset=<n>/);
      assert.match(r.stdout, /--delay-ms=<n>/);
      assert.match(r.stdout, /--series/);
      assert.match(r.stdout, /--write/);
      assert.match(r.stdout, /--no-write/);
      assert.match(r.stdout, /--out=<arquivo>/);
      assert.match(r.stdout, /--min-valid=<r>/);
      assert.doesNotMatch(r.stdout, /\[sonda\]/, 'o uso não executa a sonda');
      assert.equal(fs.existsSync(dbDir), false, 'o store não foi aberto para imprimir o uso');
      fs.rmSync(dbDir, { recursive: true, force: true });
    });
  }

  test('flag desconhecida sai diferente de 0, com erro claro e sem abrir o crawl.db', () => {
    const dbDir = path.join(os.tmpdir(), `adom-sonda-${process.pid}-typo`);
    const r = runCli(['--site=vacatorrent', '--no_write'], dbDir);
    assert.notEqual(r.status, 0, 'flag desconhecida não pode sair 0 em silêncio');
    assert.match(r.stderr, /flag desconhecida: --no_write/);
    assert.match(r.stderr, /--write/, 'o erro diz qual é a flag de escrita');
    assert.equal(fs.existsSync(dbDir), false, 'a validação precede a abertura do store');
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  test('o portão de flags roda ANTES de qualquer import que abra store ou rede', () => {
    // Estrutural, e é o que sustenta o "não faz rede": enquanto o gate não
    //ouviu `--help`, o `crawl-store` (que abre o `crawl.db` no `engine()`) e
    // os profiles do resolvedor não foram carregados. Reordenar as duas
    // primeiras linhas faz o teste falhar.
    const src = fs.readFileSync(script, 'utf8');
    const gate = src.indexOf('probeArgGate(argvRaw)');
    const storeImport = src.indexOf("import('../src/utils/crawl-store.js')");
    const resolverImport = src.indexOf("import('../src/br-resolvers.js')");
    assert.ok(gate > 0, 'o portão de flags precisa existir no entry-point');
    assert.ok(storeImport > gate, 'o crawl-store só pode ser importado DEPOIS do portão');
    assert.ok(resolverImport > gate, 'os resolvers só podem ser importados DEPOIS do portão');
    assert.match(src, /process\.exit\(0\)/, '--help sai 0');
  });
});

// --- A promessa de não escrever --------------------------------------------

const savedCrawl = { ...config.crawl };

function item(seed: string): RawItem {
  const hash = (seed.replace(/\W/g, '') + '0'.repeat(40)).slice(0, 40).padEnd(40, '0');
  return { title: `Fake (2000) 1080p DUBLADO`, magnet: `magnet:?xt=urn:btih:${hash}`, indexer: 'fake', tracker: 'Fake', isBr: true, seeders: 1, size: 1000 };
}

/** Dublê com os quatro desfechos que a classificação precisa distinguir. */
function probeSite(): CrawlSite {
  const discovery = (): CrawlDiscovery => ({
    urls: [
      { url: '/a/ok', lastmod: '1', kind: 'movie' },
      { url: '/a/stream', lastmod: '1', kind: 'movie' },
      { url: '/a/nomagnet', lastmod: '1', kind: 'movie' },
      { url: '/a/erro', lastmod: '1', kind: 'movie' },
    ],
    complete: true, failures: [],
  });
  return {
    id: 'fake', label: 'Fake', discover: async () => discovery(),
    fetchWork: async (url: string) => {
      if (url === '/a/stream') return { url, status: 'no-torrent' as const, imdb: null, title: 'S', year: 2000, type: 'movie' as const, releases: [], requestCost: 2 };
      if (url === '/a/nomagnet') {
        throw Object.assign(new Error('fake: 2 botão(ões) anunciados, nenhum magnet'), { requestCost: 7 });
      }
      if (url === '/a/erro') return { url, status: 'error' as const, error: 'layout: página sem <h1> de título', requestCost: 1 };
      return { url, status: 'done' as const, imdb: 'tt1000000', title: 'Fake', year: 2000, type: 'movie' as const, releases: [item(url)], requestCost: 4 };
    },
  };
}

const linha = (url: string): CrawlUrlRow => ({
  site: 'fake', url, lastmod: '1', kind: 'movie', status: 'pending', imdb: null,
  tries: 0, nextAt: 0, checkedAt: 0, releases: 0, error: '', progress: '', addedAt: 0,
});

test('sonda: dry-run + noPersist não toca a fila nem muda linha existente', async () => {
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  Object.assign(config.crawl, { ...savedCrawl, dryRun: true, delayMs: 0 });
  const site = probeSite();
  const motor = store.engine();
  // Uma linha REAL do motor, com estado que a sonda não pode tocar.
  motor.upsertUrls('fake', [{ url: '/a/ok', lastmod: '1', kind: 'movie' }], 1);
  motor.markResult('fake', '/a/ok', { status: 'done', imdb: 'tt1000000', releases: 3 }, 2);
  const antes = motor.getUrl('fake', '/a/ok');
  assert.equal(antes?.status, 'done');
  assert.equal(antes?.releases, 3);

  const readings = [];
  for (const url of ['/a/ok', '/a/ok', '/a/stream', '/a/nomagnet', '/a/erro']) {
    readings.push(classifyPage(await processCrawlPage(site, linha(url), { dryRun: true, noPersist: true }).then((o) => ({
      kind: o.kind, siteLevelError: o.siteLevelError, detail: o.detail,
      releases: o.releases, requests: o.requestCost, slug: url,
    }))));
  }

  assert.deepEqual(readings.map((r) => r.bucket), [
    'withRelease', 'withRelease', 'noTorrent', 'buttonNoMagnet', 'pageError',
  ]);
  assert.equal(readings[0].magnets, 1, 'o desfecho devolve as releases vistas');
  assert.equal(readings[3].requests, 7, 'o custo medido vem anexado no throw (F1)');
  assert.equal(readings[3].magnets, 0);

  // A fila é a MESMA: mesma linha, mesmo status, mesma contagem, nenhuma nova.
  assert.equal(motor.getUrl('fake', '/a/ok')?.status, 'done', 'a linha real não virou simulated');
  assert.equal(motor.getUrl('fake', '/a/ok')?.releases, 3, 'a contagem real não foi sobrescrita');
  assert.equal(motor.counters('fake').total, 1, 'nenhuma URL entrou na fila');
  assert.equal(motor.getState('fake', PROBE_STATE_KEY), null, 'a sonda não grava veredito sozinha');
  assert.deepEqual(motor.counters('fake').byStatus.pending, 0, 'nada foi reivindicado da fila');
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});

// --- `no-work`: resposta negativa, e o que a fila continua sabendo -----------

/**
 * Dublê da identificação com as TRÊS respostas que a sonda precisa separar.
 * `unidentified` é o TMDB respondendo "não é esta obra" (o caso da série, que
 * não resolve por título); `unavailable` é a NOSSA dependência fora; e
 * `identified` é o acerto. A página devolve DUAS releases para que o desfecho
 * observável (o `releases` do `PageOutcome`) possa ser distinguido do que a
 * fila grava.
 */
function identDuble(): PageCollaborators['identify'] {
  return async (input) => {
    if (input.title.includes('TMDB-FORA')) return { outcome: 'unavailable', imdb: null, reason: 'tmdb: timeout' };
    if (input.title.includes('SEM-OBRA')) return { outcome: 'unidentified', imdb: null, reason: 'nome-sem-casamento' };
    return { outcome: 'identified', imdb: 'tt1000000', reason: 'tmdb: exato' };
  };
}

/** Site cujas páginas viram 2 releases cada, com o título ditando a resposta. */
function releaseSite(urls: string[]): CrawlSite {
  return {
    id: 'fake', label: 'Fake',
    discover: async (): Promise<CrawlDiscovery> => ({
      urls: urls.map((url) => ({ url, lastmod: '1', kind: 'movie' })), complete: true, failures: [],
    }),
    fetchWork: async (url: string) => {
      const titulo = url.includes('tmdb-fora') ? 'TMDB-FORA' : url.includes('sem-obra') ? 'SEM-OBRA' : 'ACHADA';
      return {
        url, status: 'done' as const, imdb: null, title: titulo, year: 2000,
        type: 'movie' as const, releases: [item(`${url}-1`), item(`${url}-2`)], requestCost: 3,
      };
    },
  };
}

test('sonda: `no-work` devolve as releases vistas e a fila continua em 0', async () => {
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  Object.assign(config.crawl, { ...savedCrawl, dryRun: true, delayMs: 0 });
  const processar = createPageProcessor({ identify: identDuble() });
  const motor = store.engine();
  const site = releaseSite(['/a/achada', '/a/sem-obra', '/a/tmdb-fora']);
  for (const url of ['/a/achada', '/a/sem-obra', '/a/tmdb-fora']) motor.upsertUrls('fake', [{ url, lastmod: '1', kind: 'movie' }], 1);

  const leituras: PageReading[] = [];
  for (const url of ['/a/achada', '/a/sem-obra', '/a/tmdb-fora']) {
    const t0 = Date.now();
    const desfecho = await processar(site, linha(url), { dryRun: true });
    leituras.push(classifyPage({
      kind: desfecho.kind, siteLevelError: desfecho.siteLevelError, detail: desfecho.detail,
      releases: desfecho.releases, requests: desfecho.requestCost, latencyMs: Date.now() - t0, slug: url,
    }));
    // A página VISTA é o que a fila sabe; e no `no-work` a gravação é 0.
    const gravado = motor.getUrl('fake', url);
    if (desfecho.kind === 'no-work') {
      assert.equal(gravado?.status, 'no-work');
      assert.equal(gravado?.releases, 0, 'nada foi gravado no acervo, e a fila registra 0');
      assert.equal(desfecho.releases, 2, 'mas o desfecho devolve as 2 releases que o adaptador viu');
    }
  }

  // Denominadores: `no-work` é resposta do TMDB (fica no denominador, como
  // negativa) e só `unavailable` sai — são contagens independentes.
  const s = summarize(leituras);
  assert.equal(s.counts.withRelease, 3);
  assert.equal(s.counts.identified, 1);
  assert.equal(s.counts.noWork, 1, 'a resposta negativa tem contagem própria');
  assert.equal(s.counts.tmdbDown, 1, 'e a dependência fora tem outra');
  assert.equal(s.denominators.identifyAnswered, 2, '3 com release − 1 sem resposta do TMDB');
  assert.equal(s.rates.identify, 0.5);
  assert.equal(s.counts.magnets, 6, 'as 3 páginas renderam 2 releases cada — inclusive a sem obra');
  assert.equal(s.rates.magnetsPerPage, 2);
  assert.deepEqual(s.classes, {
    identificada: 1, 'no-work': 1, 'tmdb-down': 1, 'botao-sem-magnet': 0,
    'sem-botao': 0, 'erro-pagina': 0, 'site-fora': 0,
  });
  // O custo é medido, e a latência existe porque a CLI cronometra a leitura.
  assert.equal(s.cost.requests, 9, '3 páginas × requestCost 3');
  assert.equal(s.cost.requestsPerPage, 3);
  assert.equal(s.cost.measuredPages, 3);
  assert.ok(s.cost.p95LatencyMs >= 0 && s.cost.maxLatencyMs >= s.cost.p95LatencyMs);
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});
