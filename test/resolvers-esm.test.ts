import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import bludvShim from '../bludv-resolver/server.js';
import comandotorrentsShim from '../comandotorrents-resolver/server.js';
import nerdfilmesShim from '../nerdfilmes-resolver/server.js';
import torrentdosfilmesShim from '../torrentdosfilmes-resolver/server.js';
import vacatorrentShim from '../vacatorrent-resolver/server.js';
import redetorrentShim from '../redetorrent-resolver/server.js';
import apachetorrentShim from '../apachetorrent-resolver/server.js';

import * as bludvProfile from '../resolvers/profiles/bludv.js';
import * as comandotorrentsProfile from '../resolvers/profiles/comandotorrents.js';
import * as nerdfilmesProfile from '../resolvers/profiles/nerdfilmes.js';
import * as torrentdosfilmesProfile from '../resolvers/profiles/torrentdosfilmes.js';
import * as vacatorrentProfile from '../resolvers/profiles/vacatorrent.js';
import * as redetorrentProfile from '../resolvers/profiles/redetorrent.js';
import * as apachetorrentProfile from '../resolvers/profiles/apachetorrent.js';

import { isMain } from '../resolvers/is-main.js';
import * as brResolvers from '../src/br-resolvers.js';

// Contratos fixados pela conversão da Etapa 2: os resolvers (resolvers/ + os
// seis *-resolver/) são ESM NATIVO, os shims mantêm o default lazy que todos os
// consumidores já importavam, e os profiles continuam exportando a FACTORY (não
// uma instância). Os testes aqui impedem regressão silenciosa de volta para
// CommonJS ou para um shim sem default.
// O teste roda compilado de dist/test: o ROOT do projeto é o ancestral que
// contém o package.json (dist/ não tem um). Resolver por walk-up mantém o teste
// válido tanto de dist/ quanto de um runner sobre test/.
function projectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 5; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`package.json não encontrado a partir de ${start}`);
}

const ROOT = projectRoot(path.dirname(fileURLToPath(import.meta.url)));
// O teste roda de dist/test; o emit fica em dist/ e é de lá que os shims e o
// is-main carregam em runtime (a fonte agora tem folhas .ts que o Node não
// resolve por specifier .js). A varredura de pureza continua na FONTE, que é o
// que se versiona.
const DIST_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOLVERS_DIR = path.join(ROOT, 'resolvers');
const DIST_RESOLVERS_DIR = path.join(DIST_ROOT, 'resolvers');
const SHIM_DIRS = [
  'bludv-resolver',
  'comandotorrents-resolver',
  'nerdfilmes-resolver',
  'torrentdosfilmes-resolver',
  'vacatorrent-resolver',
  'redetorrent-resolver',
  'apachetorrent-resolver',
];

function jsFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFilesUnder(full);
    return entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) ? [full] : [];
  });
}

describe('Ilha dos resolvers é ESM puro (Node 20/22)', () => {
  const files = [
    ...jsFilesUnder(RESOLVERS_DIR),
    ...SHIM_DIRS.flatMap((dir) => jsFilesUnder(path.join(ROOT, dir))),
  ];

  test('nenhum require(), module.exports ou "use strict"', () => {
    // 30 arquivos de núcleo/profiles + shims + is-main: guarda contra a
    // varredura casar vazio por engano.
    assert.ok(files.length >= 30, `esperava >= 30 arquivos ESM na ilha, achou ${files.length}`);
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(!/\brequire\s*\(/.test(src), `${file} ainda usa require()`);
      assert.ok(!/module\.exports/.test(src), `${file} ainda usa module.exports`);
      assert.ok(!/^\s*['"]use strict['"];?/m.test(src), `${file} ainda tem 'use strict'`);
    }
  });

  test('nenhum package.json "type": "commonjs" na ilha', () => {
    const pkgPaths = [
      path.join(RESOLVERS_DIR, 'package.json'),
      ...SHIM_DIRS.map((dir) => path.join(ROOT, dir, 'package.json')),
    ];
    for (const pkg of pkgPaths) {
      assert.equal(fs.existsSync(pkg), false, `${pkg} ainda existe (override CommonJS)`);
    }
    const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { type?: string };
    assert.equal(rootPkg.type, 'module', 'a raiz precisa continuar type: module');
  });

  test('os sete shims carregam por import() nativo, sem interop CJS', () => {
    // O caminho de carregamento no Node 20/22 é o import dinâmico nativo; se
    // algum módulo da ilha voltasse a ser CommonJS, `require(esm)`/interop
    // apareceria aqui como falha de resolução.
    const urls = SHIM_DIRS.map((dir) => pathToFileURL(path.join(DIST_ROOT, dir, 'server.js')).href);
    const script = [
      ...urls.map((url, i) => `const m${i} = await import(${JSON.stringify(url)}); if (typeof m${i}.default?.createServer !== 'function') throw new Error('shim ${i} sem default instance');`),
      "process.stdout.write('ok');",
    ].join('\n');
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(res.stdout.trim(), 'ok');
  });

  test('os sete shims declaram export default em TS (sem .d.ts redundante)', () => {
    for (const dir of SHIM_DIRS) {
      const ts = fs.readFileSync(path.join(ROOT, dir, 'server.ts'), 'utf8');
      assert.match(ts, /export default resolver;/, `${dir}/server.ts sem export default`);
      assert.ok(!/export\s*=\s*resolver/.test(ts), `${dir}/server.ts ainda usa export =`);
      // U4: a implementação TS é o contrato; o shim .d.ts e a fonte .js morreram.
      assert.equal(fs.existsSync(path.join(ROOT, dir, 'server.d.ts')), false, `${dir}/server.d.ts deveria ter sido removido`);
      assert.equal(fs.existsSync(path.join(ROOT, dir, 'server.js')), false, `${dir}/server.js fonte deveria ter sido removido`);
    }
  });
});

describe('Shims preservam o default lazy; profiles exportam factory', () => {
  const shims = {
    bludv: bludvShim,
    comandotorrents: comandotorrentsShim,
    nerdfilmes: nerdfilmesShim,
    torrentdosfilmes: torrentdosfilmesShim,
    vacatorrent: vacatorrentShim,
    redetorrent: redetorrentShim,
    apachetorrent: apachetorrentShim,
  };

  const profiles = {
    bludv: bludvProfile,
    comandotorrents: comandotorrentsProfile,
    nerdfilmes: nerdfilmesProfile,
    torrentdosfilmes: torrentdosfilmesProfile,
    vacatorrent: vacatorrentProfile,
    redetorrent: redetorrentProfile,
    apachetorrent: apachetorrentProfile,
  };

  for (const [name, shim] of Object.entries(shims)) {
    test(`${name}: default é a instância completa (createServer/serveMain/siteSelector)`, () => {
      assert.equal(typeof shim.createServer, 'function');
      assert.equal(typeof shim.serveMain, 'function');
      assert.equal(typeof shim.siteSelector?.url, 'function');
    });
  }

  for (const [name, profile] of Object.entries(profiles)) {
    test(`${name}: profile exporta createResolver/DEFAULTS/META, nunca a instância`, () => {
      assert.equal(typeof profile.createResolver, 'function');
      assert.ok(profile.DEFAULTS && typeof profile.DEFAULTS === 'object');
      assert.ok(profile.META && typeof profile.META === 'object');
      assert.equal('default' in profile, false, 'profile não deve ter default export');
      assert.equal('createServer' in profile, false, 'profile não deve exportar instância');
      assert.equal('siteSelector' in profile, false, 'profile não deve exportar seletor');
    });
  }
});

describe('resolvers/is-main.js', () => {
  test('argv[1] ausente devolve false', () => {
    assert.equal(isMain('file:///qualquer/server.js', undefined), false);
    assert.equal(isMain('file:///qualquer/server.js', ''), false);
  });

  test('normaliza caminho e file URL para o mesmo alvo', () => {
    const target = path.join(DIST_RESOLVERS_DIR, 'is-main.js');
    assert.equal(isMain(pathToFileURL(target).href, target), true);
    assert.equal(isMain(pathToFileURL(target).href, path.join(DIST_RESOLVERS_DIR, 'outro.js')), false);
  });

  test('Windows: caixa do drive não distingue o entrypoint', { skip: process.platform !== 'win32' }, () => {
    assert.equal(isMain('file:///C:/proj/server.js', 'c:/proj/server.js'), true);
  });

  test('execução direta devolve true; importado/-e devolve false', () => {
    const isMainUrl = pathToFileURL(path.join(DIST_RESOLVERS_DIR, 'is-main.js')).href;
    const script = `import { isMain } from ${JSON.stringify(isMainUrl)};\nprocess.stdout.write(String(isMain(import.meta.url)));\n`;
    const tmp = path.join(os.tmpdir(), `adom-is-main-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(tmp, script, 'utf8');
    try {
      const direct = spawnSync(process.execPath, [tmp], { encoding: 'utf8' });
      assert.equal(direct.status, 0, direct.stderr);
      assert.equal(direct.stdout.trim(), 'true', 'script rodado direto é o principal');

      const evaluated = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', `import { isMain } from ${JSON.stringify(isMainUrl)}; process.stdout.write(String(isMain(import.meta.url)));`],
        { encoding: 'utf8' },
      );
      assert.equal(evaluated.status, 0, evaluated.stderr);
      assert.equal(evaluated.stdout.trim(), 'false', 'sem argv[1] de script não há principal');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});

describe('Carregador embutido: oito factories estáticas', () => {
  test('RESOLVERS traz createResolver em todas as oito entradas', () => {
    assert.equal(brResolvers.RESOLVERS.length, 8);
    for (const entry of brResolvers.RESOLVERS) {
      assert.equal(typeof entry.createResolver, 'function', `${entry.name} sem createResolver`);
      assert.equal(typeof entry.siteEnv, 'string');
      assert.equal(typeof entry.port, 'number');
    }
    assert.deepEqual(
      brResolvers.RESOLVERS.map((entry) => entry.name),
      ['bludv', 'comandotorrents', 'nerdfilmes', 'torrentdosfilmes', 'vacatorrent', 'redetorrent', 'apachetorrent', 'hdrtorrents'],
    );
  });
});
