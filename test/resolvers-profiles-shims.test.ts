import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createLazyInstance } from '../resolvers/shim-instance.js';
import { createResolver as createBludv, DEFAULTS as BLUDV_DEFAULTS, META as BLUDV_META } from '../resolvers/profiles/bludv.js';
import { createResolver as createComando, DEFAULTS as COMANDO_DEFAULTS, META as COMANDO_META } from '../resolvers/profiles/comandotorrents.js';
import { createResolver as createNerd, DEFAULTS as NERD_DEFAULTS, META as NERD_META } from '../resolvers/profiles/nerdfilmes.js';
import { createResolver as createRede, DEFAULTS as REDE_DEFAULTS, META as REDE_META } from '../resolvers/profiles/redetorrent.js';
import { createResolver as createTdf, DEFAULTS as TDF_DEFAULTS, META as TDF_META } from '../resolvers/profiles/torrentdosfilmes.js';
import { createResolver as createVaca, DEFAULTS as VACA_DEFAULTS, META as VACA_META } from '../resolvers/profiles/vacatorrent.js';
import { createResolver as createApache, DEFAULTS as APACHE_DEFAULTS, META as APACHE_META } from '../resolvers/profiles/apachetorrent.js';
import { createResolver as createHDR, DEFAULTS as HDR_DEFAULTS, META as HDR_META } from '../resolvers/profiles/hdrtorrents.js';
import { RESOLVERS } from '../src/br-resolvers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const SHIM_DIRS = [
  'bludv-resolver',
  'comandotorrents-resolver',
  'nerdfilmes-resolver',
  'torrentdosfilmes-resolver',
  'vacatorrent-resolver',
  'redetorrent-resolver',
  'apachetorrent-resolver',
  'hdrtorrents-resolver',
];

/** Contrato do loader (src/br-resolvers) + shape mínimo que os testes leem. */
type ResolverFactory = (overrides: {
  port: number;
  selfUrl: string;
  siteUrl?: string;
  extraProtectors: string[];
}) => {
  createServer: () => import('node:http').Server;
  siteSelector: { url: () => string };
  inFlight: Map<string, any>;
  serveMain: (start: () => import('node:http').Server) => void;
};

const LOADER_OVERRIDES = { port: 1, selfUrl: 'http://127.0.0.1:1', siteUrl: 'https://site.example', extraProtectors: [] };

const U3_PROFILES: Array<{ name: string; factory: ResolverFactory; port: number; siteEnv: string }> = [
  { name: 'bludv', factory: createBludv, port: BLUDV_DEFAULTS.port, siteEnv: BLUDV_META.siteEnv },
  { name: 'comandotorrents', factory: createComando, port: COMANDO_DEFAULTS.port, siteEnv: COMANDO_META.siteEnv },
  { name: 'nerdfilmes', factory: createNerd, port: NERD_DEFAULTS.port, siteEnv: NERD_META.siteEnv },
  { name: 'redetorrent', factory: createRede, port: REDE_DEFAULTS.port, siteEnv: REDE_META.siteEnv },
  { name: 'torrentdosfilmes', factory: createTdf, port: TDF_DEFAULTS.port, siteEnv: TDF_META.siteEnv },
  { name: 'vacatorrent', factory: createVaca, port: VACA_DEFAULTS.port, siteEnv: VACA_META.siteEnv },
  { name: 'apachetorrent', factory: createApache, port: APACHE_DEFAULTS.port, siteEnv: APACHE_META.siteEnv },
  { name: 'hdrtorrents', factory: createHDR, port: HDR_DEFAULTS.port, siteEnv: HDR_META.siteEnv },
];

describe('U3: os oito profiles constroem com o contrato real', () => {
  for (const profile of U3_PROFILES) {
    test(`${profile.name}: DEFAULTS/META e shape da instância`, () => {
      assert.equal(typeof profile.factory, 'function');
      assert.equal(profile.port > 0, true, 'porta default');
      assert.match(profile.siteEnv, /_URL$/);
      const instance = profile.factory(LOADER_OVERRIDES);
      assert.equal(typeof instance.createServer, 'function');
      assert.equal(typeof instance.serveMain, 'function');
      assert.equal(typeof instance.siteSelector.url(), 'string');
      assert.ok(instance.inFlight instanceof Map, 'inFlight precisa ser Map real');
      assert.ok(
        Object.values(instance).some((value) => value instanceof Map),
        'ao menos um cache Map exposto',
      );
    });
  }

  test(`callback HTTP: /health responde ok e /api?t=caps devolve caps (sem rede)`, async () => {
    const instance = createBludv({ ...LOADER_OVERRIDES, port: 0 });
    const server = instance.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object', 'servidor sem address');
      const { port } = address;
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
      assert.equal(await health.text(), 'ok');

      const caps = await fetch(`http://127.0.0.1:${port}/api?t=caps`);
      assert.equal(caps.status, 200);
      assert.match(await caps.text(), /<caps>/);

      const bad = await fetch(`http://127.0.0.1:${port}/nope`);
      assert.equal(bad.status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('compatibilidade com src/br-resolvers: os oito módulos são carregáveis', () => {
    assert.equal(RESOLVERS.length, 8);
    for (const entry of RESOLVERS) {
      assert.equal(typeof entry.createResolver, 'function', `${entry.name} sem createResolver`);
      const instance = entry.createResolver(LOADER_OVERRIDES);
      assert.equal(typeof instance.createServer, 'function', `${entry.name} sem createServer`);
      assert.equal(typeof instance.siteSelector?.url?.(), 'string', `${entry.name} sem seletor`);
    }
  });
});

describe('U4: helper genérico do Proxy lazy', () => {
  test('não constrói no import, encaminha get/set/has/keys e reusa a instância', () => {
    let builds = 0;
    const lazy = createLazyInstance(() => {
      builds += 1;
      return { value: 7, greet: () => 'oi' };
    });
    assert.equal(builds, 0, 'não pode construir no import (lazy de verdade)');
    assert.equal(lazy.greet(), 'oi');
    assert.equal(lazy.value, 7);
    assert.equal(builds, 1);
    lazy.value = 9;
    assert.equal(lazy.value, 9, 'set precisa encaminhar para a instância');
    assert.equal('value' in lazy, true, 'has precisa enxergar a instância');
    assert.deepEqual(Object.keys(lazy).sort(), ['greet', 'value']);
    assert.equal(builds, 1, 'a mesma instância é reusada');
  });

  test('os sete shims preservam default lazy + standalone isMain e import .js', () => {
    for (const dir of SHIM_DIRS) {
      const ts = fs.readFileSync(path.join(ROOT, dir, 'server.ts'), 'utf8');
      assert.match(ts, /createLazyInstance\(\(\) => createResolver\(\)\)/, `${dir} sem lazy instance`);
      assert.match(ts, /if \(isMain\(import\.meta\.url\)\)/, `${dir} sem guard standalone`);
      assert.match(ts, /serveMain\(instance\.createServer\)/, `${dir} sem serveMain standalone`);
      assert.match(ts, /from '\.\.\/resolvers\/[a-z-]+\.js'/, `${dir} com import sem .js`);
    }
  });

  test('standalone: o shim rodado como principal sobe via isMain', async () => {
    const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'bludv-resolver', 'server.js')], {
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`standalone não subiu: ${out}`));
      }, 10_000);
      child.stdout.on('data', (chunk: Buffer) => {
        out += String(chunk);
        if (out.includes('torznab')) {
          clearTimeout(timer);
          resolve(out);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => { out += String(chunk); });
      child.on('error', reject);
    });
    child.kill();
    assert.match(output, /bludv-resolver :0 — torznab/);
  });
});
