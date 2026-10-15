// Config ao vivo do crawler (Fase 4): schema/clamps, overlay sobre o `.env`,
// persistência em `cfg:v1:crawler`, reset e o callback de mudança que o motor
// usa para rearmar o timer sem restart.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const live = await import('../src/utils/crawler-live.js');
const cache = await import('../src/utils/cache.js');
const { prefix } = await import('../src/utils/cache-keys.js');

const savedCrawl = { ...config.crawl };

beforeEach(() => {
  live._resetForTest();
});

after(() => {
  live._resetForTest();
  Object.assign(config.crawl, savedCrawl);
});

describe('crawler-live: config ao vivo', () => {
  test('effective() parte dos defaults do .env', () => {
    Object.assign(config.crawl, { enabled: false, dryRun: true, delayMs: 1234 });
    const eff = live.effective();
    assert.equal(eff.enabled, false);
    assert.equal(eff.dryRun, true);
    assert.equal(eff.delayMs, 1234);
    assert.deepEqual(eff.sites, config.crawl.sites);
  });

  test('set() aplica override e persiste em cfg:v1:crawler', () => {
    const outcome = live.set({ enabled: true, delayMs: 2000 });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.overriddenKeys.sort(), ['delayMs', 'enabled'].sort());
    const eff = live.effective();
    assert.equal(eff.enabled, true);
    assert.equal(eff.delayMs, 2000);
    const persisted = cache.get(`${prefix('cfg')}crawler`) as Record<string, unknown>;
    assert.equal(persisted.enabled, true);
    assert.equal(persisted.delayMs, 2000);
  });

  test('clamps: valores fora da faixa são truncados ao min/max do schema', () => {
    live.set({
      delayMs: -10,            // → 0
      maxPerHour: 999_999,     // → 20000
      idleWindowMs: 10_000_000, // → 3600000
      maxTries: 0,             // → 1
      layoutCanary: 50_000,    // → 1000
      incrementalIntervalMin: 99_999, // → 1440
    });
    const eff = live.effective();
    assert.equal(eff.delayMs, 0);
    assert.equal(eff.maxPerHour, 20_000);
    assert.equal(eff.idleWindowMs, 3_600_000);
    assert.equal(eff.maxTries, 1);
    assert.equal(eff.layoutCanary, 1000);
    assert.equal(eff.incrementalIntervalMin, 1440);
  });

  test('chave desconhecida é erro (rejeita o patch inteiro)', () => {
    const outcome = live.set({ enabled: true, sites: ['vacatorrent'] });
    assert.equal(outcome.ok, false);
    assert.ok(outcome.errors?.some((e) => e.includes('sites')));
    // Patch rejeitado não grava NADA — `enabled` ficou de fora.
    assert.notEqual(live.effective().enabled, true);
  });

  test('reset() restaura os padrões do .env e limpa a persistência', () => {
    live.set({ enabled: true, delayMs: 9999 });
    live.reset();
    assert.equal(cache.get(`${prefix('cfg')}crawler`), null);
    assert.equal(live.effective().delayMs, config.crawl.delayMs);
  });

  test('snapshot() traz effective, envDefaults, overriddenKeys e schema', () => {
    live.set({ enabled: true });
    const snap = live.snapshot();
    assert.equal(snap.effective.enabled, true);
    assert.equal(snap.envDefaults.enabled, config.crawl.enabled);
    assert.deepEqual(snap.overriddenKeys, ['enabled']);
    const keys = snap.schema.map((f) => f.key);
    assert.ok(keys.includes('enabled'));
    assert.ok(keys.includes('dryRun'));
    assert.ok(keys.includes('delayMs'));
    // `sites` não é campo ao vivo (lista; cliente fora do escopo da fase).
    assert.ok(!keys.includes('sites'));
  });

  test('onConfigChange dispara no set/reset e para ao limpar', () => {
    let hits = 0;
    live.onConfigChange(() => { hits += 1; });
    live.set({ enabled: true });
    live.reset();
    assert.equal(hits, 2);
    live.onConfigChange(null);
    live.set({ enabled: false });
    assert.equal(hits, 2, 'sem listener, não dispara');
  });

  test('contrato enabled: default false; ligar pelo painel persiste após restart; reset volta ao env', () => {
    Object.assign(config.crawl, { enabled: false });
    live._resetForTest();
    assert.equal(live.effective().enabled, false, 'default seguro: desligado');
    assert.equal(live.snapshot().envDefaults.enabled, false);

    // Requisito da Fase 4: o painel pode habilitar ao vivo e isso é decisão
    // explícita do operador — grava em `cfg:v1:crawler`.
    const outcome = live.set({ enabled: true });
    assert.equal(outcome.ok, true);
    const key = `${prefix('cfg')}crawler`;
    const persisted = cache.get(key) as Record<string, unknown>;
    assert.equal(persisted.enabled, true);

    // "Restart": a memória some, o disco fica. O motor relê o override.
    live._resetForTest();
    cache.set(key, persisted, 315_360_000);
    assert.equal(live.effective().enabled, true, 'o habilitado pelo painel sobrevive ao restart');

    // Reset volta ao default do `.env` (desligado) e limpa o override.
    live.reset();
    assert.equal(live.effective().enabled, false);
    assert.equal(cache.get(key), null);
  });
});
