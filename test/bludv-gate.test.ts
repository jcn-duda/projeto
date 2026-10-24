import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Portão de anúncio do BLUDV (Fase 4): a detecção única e o que o provider em
 * processo faz quando o post deixa de publicar os links do protetor.
 *
 * ASSINATURA É CAPTURA REAL: `/gate/go/<hex>?p=<id>` + rótulo "Magnet-Link"
 * foram medidos em 2026-10-13 pelo FlareSolverr do container em dois posts de
 * `bludvfilmes1.xyz` (ver o cabeçalho da fixture e de
 * `resolvers/profiles/bludv-gate.ts`). A forma simples `>Magnet-Link</a>` e a
 * forma com o overlay do player injetado dentro do `<a>` ocorrem as duas no
 * mesmo dia — a regex que exigia `</a>` perdia metade dos posts.
 */
import config from '../src/config.js';
import bludvProvider from '../src/providers/bludv.js';
import {
  hasAdGate,
  assertNoAdGate,
  isBludvAdGate,
  BLUDV_AD_GATE_RE,
  BLUDV_AD_GATE_REASON,
} from '../resolvers/profiles/bludv-gate.js';
import { assertNoAdGate as assertNoAdGateViaParsers } from '../resolvers/profiles/bludv-parsers.js';
import { stubFetch } from './helpers/stub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// De dist/test/ a raiz do repositório fica dois níveis acima.
const ROOT = path.join(__dirname, '..', '..');
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const gateHtml = fixture('bludv-gate-post.html');
const protectorHtml = fixture('bludv-post.html');

// --- (a) detecção no post com portão ---------------------------------------

test('bludv: post com portão e sem botão lança a mensagem exata do portão', () => {
  let err: any = null;
  try {
    assertNoAdGate(gateHtml, 0);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'o post que só tem o botão /gate/go/ deveria bloquear');
  assert.equal(err.message, 'bludv: portão de anúncio');
  assert.equal(err.message, BLUDV_AD_GATE_REASON);
  // O provider distingue portão de rede por marca própria, não por string solta.
  assert.equal(isBludvAdGate(err), true);
  assert.equal(isBludvAdGate(new Error('HTTP 503')), false);
});

test('bludv: portão com link aproveitável não derruba o post', () => {
  // Um post que publicar o protetor E o portão serve as releases boas; o
  // detector existe para nomear o silêncio, não para comê-lo.
  assert.doesNotThrow(() => assertNoAdGate(gateHtml, 1));
  assert.equal(hasAdGate(gateHtml), true);
});

test('bludv: a assinatura casa as duas formas reais do botão', () => {
  // Capturadas em 2026-10-13: o overlay do player entra DENTRO do <a> em alguns
  // renders. Exigir `</a>` após o rótulo (a regex antiga) perdia esses posts.
  const comOverlay = '<a href="https://bludvfilmes1.xyz/gate/go/38a7e919c6e717de?p=80753" class="customButton" target="_blank">Magnet-Link<div class="eas-video-overlay-wrapper" style="position: absolute;"></div></a>';
  const simples = '<a href="https://bludvfilmes1.xyz/gate/go/f1d9d62d0c5cc562?p=80137" class="customButton" target="_blank">Magnet-Link</a>';
  assert.equal(BLUDV_AD_GATE_RE.test(comOverlay), true, 'perdeu o post com overlay injetado');
  assert.equal(BLUDV_AD_GATE_RE.test(simples), true, 'perdeu o post simples');
  assert.equal(/Magnet-Link\s*<\/a>/i.test(comOverlay), false, 'a forma antiga deveria voltar como regressão');

  // Os links reais do protetor continuam NEGATIVOS: é o que separa "portão" de
  // "post normal", e um falso positivo aqui custaria todas as releases do site.
  assert.equal(BLUDV_AD_GATE_RE.test('<a href="https://systemads1.com/go/aaa111">Magnet-Link</a>'), false);
  assert.equal(BLUDV_AD_GATE_RE.test('<a href="https://videosad.net/go/ccc333">Magnet-Link</a>'), false);
  // Decoy medido na mesma captura: mesmo rótulo e classe, href do próprio site.
  assert.equal(BLUDV_AD_GATE_RE.test('<a href="/" class="customButton">Magnet-Link<div class="eas-video-overlay-wrapper"></div></a>'), false);
});

// --- (b) post sem portão não dispara ----------------------------------------

test('bludv: post com links do protetor não é portão', () => {
  assert.doesNotThrow(() => assertNoAdGate(protectorHtml, 0));
  assert.equal(hasAdGate(protectorHtml), false);
  // Sem esta linha a asserção acima seria vazia: um HTML sem nada também não
  // dispara. O post de referência tem, sim, botões de protetor.
  assert.ok(bludvProvider.parseDownloadLinks(protectorHtml).length > 0, 'a fixture deveria ter links systemads/videosad');
});

// --- uma única regex para os três consumidores -------------------------------

test('bludv: bludv-parsers reexporta a detecção do módulo do portão', () => {
  // Reexport (e não uma segunda implementação): a porta do portão continuou no
  // barramento do perfil para não partir importadores antigos.
  assert.equal(assertNoAdGateViaParsers, assertNoAdGate);
});

test('bludv: nenhum consumidor carrega a regex do portão no próprio corpo', () => {
  // A regra do lado Rust é a mesma assinatura; aqui o que se cobra é que o TS
  // não tenha cópias — duas regex divergem em silêncio quando o site mudar.
  const consumidores = [
    'src/providers/bludv.ts',
    'resolvers/profiles/bludv.ts',
    'resolvers/profiles/bludv-parsers.ts',
  ];
  for (const rel of consumidores) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.equal(src.includes('/gate/go/'), false, `${rel} duplica a assinatura do portão`);
  }
  const unicos = fs.readFileSync(path.join(ROOT, 'resolvers', 'profiles', 'bludv-gate.ts'), 'utf8');
  assert.ok(unicos.includes('/gate/go/'), 'a assinatura deveria viver em bludv-gate.ts');
});

// --- (c) provider em processo: busca degradada, mas com motivo ---------------

interface Captured {
  items: any[];
  logs: string[];
  warns: string[];
}

/**
 * Roda `bludvProvider.search()` com o fetch dublado e o console capturado.
 * O cache cru é desligado (`ttlBr`/`maxItems` = 0) para o teste medir o scrape,
 * não uma entrada deixada por uma corrida anterior.
 */
async function searchStubbed(postHtml: string, query: string): Promise<Captured> {
  const postUrl = `${config.bludv.baseUrl}/o-final-da-turne-2016/`;
  const searchHtml = `<div class="posts"><div class="post"><div class="title">` +
    `<a href="${postUrl}">O Final da Turnê Torrent &#8211; (2016) Blu-ray Rip 720p e 1080p Dublado</a>` +
    `</div></div></div>`;
  const stub = stubFetch((url) => ({
    ok: true,
    status: 200,
    text: async () => (url.includes('?s=') ? searchHtml : postHtml),
  }));

  const saved = {
    enabled: config.bludv.enabled,
    ttlBr: config.rawCache.ttlBr,
    maxItems: config.rawCache.maxItems,
  };
  const realLog = console.log;
  const realWarn = console.warn;
  const logs: string[] = [];
  const warns: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
  try {
    config.bludv.enabled = true;
    config.rawCache.ttlBr = 0;
    config.rawCache.maxItems = 0;
    const items = await bludvProvider.search(query);
    return { items, logs, warns };
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    stub.restore();
    config.bludv.enabled = saved.enabled;
    config.rawCache.ttlBr = saved.ttlBr;
    config.rawCache.maxItems = saved.maxItems;
  }
}

test('bludv: provider em processo com portão devolve [] e loga o motivo', async () => {
  const { items, logs, warns } = await searchStubbed(gateHtml, 'o final da turne com portao');

  // Falha de layout nunca derruba a busca: o resultado é vazio, não um erro.
  assert.equal(items.length, 0);

  // O motivo aparece em nível visível por padrão (warn) e com o caminho do post.
  const gateWarns = warns.filter((l) => l.includes('[bludv]'));
  assert.equal(gateWarns.length, 1, `esperava um warn do portão, veio: ${JSON.stringify(warns)}`);
  assert.match(gateWarns[0], /portão de anúncio/);
  assert.ok(gateWarns[0].includes('/o-final-da-turne-2016/'), 'o log deve dizer qual post é o portão');

  // E o resumo deixa de ser o silêncio "N post(s) → 0 magnet(s)".
  const summary = logs.find((l) => l.startsWith('[bludv]') && l.includes('magnet(s)')) || '';
  assert.ok(summary.includes('[portão de anúncio em 1/1 post(s)]'), summary);
});

test('bludv: provider sem portão e sem links loga o resumo simples', async () => {
  // "Site sem resultado" continua distinguível do portão: o mesmo [] vem com um
  // log diferente, e é exatamente isso que o operador precisa para não ficar no
  // escuro quando o site trocar o protetor de link.
  const plainPostHtml = '<html><body><h1>Filme Qualquer Torrent &#8211; (2024) WEB-DL 1080p Dublado</h1></body></html>';
  const { items, logs, warns } = await searchStubbed(plainPostHtml, 'filme qualquer sem portao');

  assert.equal(items.length, 0);
  assert.equal(warns.filter((l) => l.includes('portão')).length, 0);
  const summary = logs.find((l) => l.startsWith('[bludv]') && l.includes('magnet(s)')) || '';
  assert.equal(summary, '[bludv] 1 post(s) → 0 magnet(s)');
});
