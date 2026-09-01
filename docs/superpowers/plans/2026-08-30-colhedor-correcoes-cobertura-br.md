# Colhedor — Correções + Cobertura BR — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consertar os 3 defeitos de contrato do colhedor (config ao vivo ignorada no worker, `topReleases` sem ordenação, aviso de quota a cada tick) e fechar 2 buracos de cobertura BR (bludv sem fallback de título pt, varredura pt-BR tudo-ou-nada), mais a métrica de descarte.

**Architecture:** Tudo acontece em `src/providers/harvest-worker.ts` (M1, M2, M4, M5) e em dois pontos de `src/providers/harvester.ts` (M3, M6). A fila, o ciclo `tick`, a semente e o índice não mudam. Os testes vivem em `test/harvester.test.ts` e seguem o harness existente: `stubFetch` para rede falsa, mutação de `config.*` com save/restore em `finally`, e `harvester.tick()`/`harvestWorker.harvestOne()` dirigidos manualmente.

**Tech Stack:** TypeScript ESM, Node ≥ 20, `node:test`. Testes rodam de `dist/` — **build antes de cada rodada de teste**. PowerShell: separar comandos com `;`, nunca `&&`.

**Spec:** `docs/superpowers/specs/2026-08-30-colhedor-correcoes-cobertura-br-design.md`

**Convenções do projeto que o executor PRECISA saber:**

- `npm run build` compila `src/` + `test/` para `dist/` com `noEmitOnError: true` — build vermelho deixa o `dist/` antigo intacto. Nunca confie num `dist/` de build que falhou.
- Um arquivo de teste só: `node --test dist/test/harvester.test.js` (roda o arquivo inteiro; os testes são ordenados e compartilham fila/módulos — por isso cada um drena o que encontrou antes).
- `harvesterLive.effective()` lê `config.harvest.*` NA HORA de cada chamada (via `envDefaults()`), então mutar o estático em teste continua funcionando; o override do painel (`harvesterLive.set`) tem precedência. `harvesterLive.reset()` limpa TODOS os overrides — usar só em `finally` e nunca assumir estado dele entre testes.
- Métricas: `metrics.snapshot().counters` é um `Record<string, number>` acumulado do processo; cobrar por **delta** (antes/depois), nunca por valor absoluto.
- Após cada task: `npm run typecheck` (zero) → `npm run build` → `node --test dist/test/harvester.test.js` → commit.

---

### Task 1: M1 — Config ao vivo respeitada dentro do worker

**Files:**
- Modify: `src/providers/harvest-worker.ts:68-70` (topo de `harvestOne`) e os 4 usos em `:111`, `:117`, `:147`, `:148`
- Test: `test/harvester.test.ts` (fim do arquivo)

- [ ] **Step 1: Escrever o teste que falha**

Adicione ao final de `test/harvester.test.ts`. O import do worker ainda não existe no arquivo — adicione junto dos imports do topo:

```ts
import * as harvestWorker from '../src/providers/harvest-worker.js';
```

Teste:

```ts
test('harvestOne obedece teto e janela AO VIVO (override), não o .env estático', async () => {
  // O painel promete aplicação em tempo real dos 12 parâmetros; até aqui o
  // worker lia config.harvest.maxPerHour/idleWindowMs estáticos DENTRO da obra
  // — mudar no painel só afetava a decisão de começar. Este teste dirige
  // harvestOne direto (sem tick) para provar que o override vale por dentro.
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
  };
  const stub = stubFetch((url: string) => {
    if (url.includes('/api/v2.0/indexers/')) return { ok: true, status: 200, json: async () => ({ Results: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    config.harvest.maxPerHour = 1000; // .env ALTO: quem tem que cortar é o override
    config.harvest.idleWindowMs = 0;  // estático não pode travar o caso A
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['live-a', 'live-b', 'live-c'];
    config.jackett.apiKey = 'fake-key';
    cache.set('meta:movie:tt9500100', { name: 'Live Cap Movie', year: '2024', type: 'movie' }, 3600);

    // Caso A: override de maxPerHour=2 corta a obra no MEIO do harvestOne.
    harvesterLive.set({ harvestMaxPerHour: 2 });
    const before = harvestWorker.queriesThisHour();
    const resA = await harvestWorker.harvestOne({
      imdbId: 'tt9500100',
      type: 'movie',
      reason: 'live-a',
      enqueuedAt: Date.now(),
    } as any);
    assert.equal(resA.capped, true, 'teto AO VIVO cortou a obra no meio');
    assert.equal(harvestWorker.queriesThisHour() - before, 2, 'só as 2 consultas do override, não as 1000 do .env');

    // Caso B: janela AO VIVO grande + tráfego recém-notado trava o laço inteiro.
    harvesterLive.set({ harvestIdleWindowMs: 600_000 });
    activity.noteUserRequest();
    const resB = await harvestWorker.harvestOne({
      imdbId: 'tt9500100',
      type: 'movie',
      reason: 'live-b',
      enqueuedAt: Date.now(),
    } as any);
    assert.equal(harvestWorker.queriesThisHour() - before, 2, 'com tráfego na janela ao vivo, nenhuma consulta nova');
    assert.equal(resB.capped, false, 'freio de atividade não é corte de teto');
  } finally {
    harvesterLive.reset();
    stub.restore();
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
  }
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm run build; node --test dist/test/harvester.test.js`
Expected: FAIL no caso A — `resA.capped` é `false` (com o .env em 1000 o worker atual não corta nada) e a contagem sai 3, não 2.

- [ ] **Step 3: Implementar**

Em `src/providers/harvest-worker.ts`, no topo de `harvestOne` (logo após `const startedAt = Date.now();`), capture UM snapshot:

```ts
// Snapshot ÚNICO no início: o guard `queriesThisHour() + attempted >= teto`
// precisa de um teto estável durante a obra, e o painel promete aplicação ao
// vivo dos dois campos que antes eram lidos estáticos do .env.
const live = harvesterLive.effective();
```

Substitua os 4 usos (e só eles):

1. Linha ~111 (`sweepTargets`): `activity.recentUserTraffic(config.harvest.idleWindowMs)` → `activity.recentUserTraffic(live.harvestIdleWindowMs)`
2. Linha ~117 (guard da varredura): `>= config.harvest.maxPerHour` → `>= live.harvestMaxPerHour`
3. Linha ~147 (freio no laço): `activity.recentUserTraffic(config.harvest.idleWindowMs)` → `activity.recentUserTraffic(live.harvestIdleWindowMs)`
4. Linha ~148 (guard do laço): `>= config.harvest.maxPerHour` → `>= live.harvestMaxPerHour`

`harvesterLive` já é importado no arquivo (linha 27). `indexerDelayMs` já é live em `awaitIndexerGap` — não tocar.

- [ ] **Step 4: Rodar e confirmar passagem**

Run: `npm run build; node --test dist/test/harvester.test.js`
Expected: PASS no teste novo **e** nos existentes (a mutação estática de `config.harvest.maxPerHour` nos testes antigos continua valendo porque `envDefaults()` a lê na hora, sem override).

- [ ] **Step 5: Commit**

```powershell
git add src/providers/harvest-worker.ts test/harvester.test.ts; git commit -m "fix(harvest): worker obedece teto e janela ao vivo do painel"
```

---

### Task 2: M2 — rdWarmer recebe o BR primeiro (ordenação por score)

**Files:**
- Modify: `src/providers/harvest-worker.ts:192-205` (bloco `topReleases`)
- Test: `test/harvester.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Ao final de `test/harvester.test.ts`:

```ts
test('rdWarmer recebe os releases ordenados por score: BR dublado dentro do corte de 10', async () => {
  // 11 legendados coletados PRIMEIRO + 1 BR dublado por último: sem ordenar,
  // o slice(0, 10) corta o BR — exatamente o release que o ⚡ mais vale.
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
    tmdbApiKey: config.tmdb.apiKey,
    ptSweepGlobal: config.jackett.ptSweepGlobal,
    rdWarmEnabled: config.debrid.rdWarm.enabled,
    debridService: config.debrid.service,
  };
  const hashBr = 'f'.repeat(40);
  const hashesLeg = Array.from({ length: 11 }, (_, i) => (i < 10 ? 'd' : 'e') + '0'.repeat(38) + (i < 10 ? i : i - 10).toString(16).padStart(1, '0'));
  const results = hashesLeg.map((hash, i) => ({
    Title: 'Test Sort Movie (2024) 1080p English Subbed',
    MagnetUri: `magnet:?xt=urn:btih:${hash}&dn=leg${i}`,
    Seeders: 30 - i,
    Tracker: 'thepiratebay',
  }));
  results.push({
    Title: 'Filme Teste Sort (2024) 1080p DUAL Dublado',
    MagnetUri: `magnet:?xt=urn:btih:${hashBr}&dn=br`,
    Seeders: 5,
    Tracker: 'comandotorrents',
    isBr: true,
  } as any);

  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          movie_results: [{ title: 'Filme Teste Sort', original_title: 'Test Sort Movie', release_date: '2024-01-01' }],
        }),
      };
    }
    if (url.includes('/api/v2.0/indexers/')) return { ok: true, status: 200, json: async () => ({ Results: results }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    cache.clearNamespace('raw');
    cache.clearNamespace('tmdb');
    cache.clearNamespace('meta');
    cache.clearNamespace('rdc');
    cache.clearNamespace('rdq');
    rdWarmer.reset();
    config.jackett.ptSweepGlobal = false; // isola: uma passada de indexer só
    config.debrid.rdWarm.enabled = true;
    config.debrid.service = 'realdebrid';
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['test-sort-idx'];
    config.tmdb.apiKey = 'fake-key';

    config.jackett.apiKey = '';
    let guard = 0;
    while ((harvester.status() as any).queueDepth > 0 && guard++ < 250) await harvester.tick();

    const before = (harvester.status() as any).queriesThisHour || 0;
    config.harvest.maxPerHour = before + 50;
    config.jackett.apiKey = 'fake-key';
    cache.set('meta:movie:tt9500101', { name: 'Test Sort Movie', year: '2024', type: 'movie' }, 3600);
    harvester.enqueue({ imdbId: 'tt9500101', type: 'movie', reason: `sort-test-${Date.now()}` } as any);
    await harvester.tick();

    const warmQueue = cache.get(`${prefix('rdq')}wq`) as any[];
    assert.ok(Array.isArray(warmQueue) && warmQueue.length > 0, 'warmQueue persistida');
    assert.equal(warmQueue.length, 10, 'corte de 10 respeitado');
    assert.ok(warmQueue.some((e) => e.hash === hashBr && e.score === 80), 'BR dublado está entre os 10 (score 80)');
    assert.equal(warmQueue[0].score, 80, 'o primeiro enfileirado é o BR');
  } finally {
    stub.restore();
    config.jackett.ptSweepGlobal = saved.ptSweepGlobal;
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
    config.tmdb.apiKey = saved.tmdbApiKey;
    config.debrid.rdWarm.enabled = saved.rdWarmEnabled;
    config.debrid.service = saved.debridService;
    rdWarmer.reset();
  }
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm run build; node --test dist/test/harvester.test.js`
Expected: FAIL — `warmQueue.some(hash===hashBr)` é false (o 12º coletado caiu fora do `slice(0, 10)`).

- [ ] **Step 3: Implementar**

Em `src/providers/harvest-worker.ts`, no bloco do rdWarmer, ordene antes do corte. O `.filter(...)` que valida o hash ganha o `.sort(...)`:

```ts
      .filter((r: any) => /^[a-f0-9]{40}$/.test(r.hash))
      // O corte é de 10; sem ordenar, "top" era a ordem de coleta e o BR
      // dublado — o que mais vale ⚡ — podia cair fora dele.
      .sort((a: any, b: any) => b.score - a.score);
    for (const item of topReleases.slice(0, 10)) {
      rdWarmer.enqueue([item.hash], item.score);
    }
```

(ou seja: mova o `.slice(0, 10)` para depois do `.sort()`, dentro do `for`.)

- [ ] **Step 4: Rodar e confirmar passagem**

Run: `npm run build; node --test dist/test/harvester.test.js`
Expected: PASS no teste novo; o teste antigo de score (80/40/5) continua passando.

- [ ] **Step 5: Commit**

```powershell
git add src/providers/harvest-worker.ts test/harvester.test.ts; git commit -m "fix(harvest): rdWarmer recebe releases ordenados por score"
```

---

### Task 3: M3 — Cooldown no aviso de quota

**Files:**
- Modify: `src/config/harvest.ts` (objeto `harvest()`)
- Modify: `src/providers/harvester.ts:40-58` (`checkQuotaWarning`)
- Modify: `.env.example` (documentar a env nova)
- Test: `test/harvester.test.ts`

- [ ] **Step 1: Adicionar a config**

Em `src/config/harvest.ts`, dentro de `export const harvest = () => ({...})`, após `brMaxWaitMs`:

```ts
  // Cooldown da checagem de quota (checkQuotaWarning): a checagem atualizava
  // a conta a cada tick (60s) de ociosidade. O marcador vale para QUALQUER
  // checagem bem-sucedida — sã ou não a conta; erro de rede não grava.
  quotaWarnCooldownMs: Math.max(0, num(process.env.HARVEST_QUOTA_WARN_COOLDOWN_MS, 6 * 3600 * 1000)),
```

- [ ] **Step 2: Escrever o teste que falha**

Import do debrid no topo de `test/harvester.test.ts` (ainda não existe):

```ts
import debrid from '../src/debrid/index.js';
```

Teste ao final do arquivo:

```ts
test('aviso de quota respeita cooldown: uma checagem por janela, não por tick', async () => {
  // checkQuotaWarning rodava a cada tick (60s) e esbarrava em accountStatus
  // da AllDebrid por minuto. O marcador harvest:v1:quotaWarn limita a checagem
  // ao cooldown; cooldown=0 desliga o freio (não o aviso).
  const saved = {
    notifyEnabled: config.notify.enabled,
    webhookUrl: config.notify.webhookUrl,
    service: config.debrid.service,
    apiKey: config.debrid.apiKey,
    allowEnvKey: config.debrid.allowEnvKey,
    idleWindowMs: config.harvest.idleWindowMs,
    indexers: config.jackett.indexers,
    jackettApiKey: config.jackett.apiKey,
  };
  const cooldownMs = (config.harvest as any).quotaWarnCooldownMs;
  const flush = () => new Promise((r) => setTimeout(r, 20)); // checkQuotaWarning é fire-and-forget no tick
  try {
    config.notify.enabled = true;
    config.notify.webhookUrl = 'http://notify.invalid/hook';
    config.debrid.service = 'alldebrid';
    config.debrid.allowEnvKey = true;
    config.debrid.apiKey = 'fake-key';
    config.harvest.idleWindowMs = 0;

    const adapter = debrid.BY_ID.get('alldebrid') as any;
    assert.ok(adapter && typeof adapter.accountStatus === 'function', 'alldebrid expõe accountStatus');
    const originalStatus = adapter.accountStatus;
    let calls = 0;
    adapter.accountStatus = async () => {
      calls += 1;
      return { magnets: 10, ready: 0, active: 0 }; // abaixo do limiar: nunca notifica
    };

    const stub = stubFetch(() => ({ ok: true, status: 200, json: async () => ({}) }));
    try {
      // Fila vazia: tick ainda roda checkQuotaWarning antes do guard de fila.
      config.jackett.indexers = [];
      config.jackett.apiKey = '';
      let guard = 0;
      while ((harvester.status() as any).queueDepth > 0 && guard++ < 250) await harvester.tick();

      cache.forget(`${prefix('harvest')}quotaWarn`);
      (config.harvest as any).quotaWarnCooldownMs = 3_600_000;
      await harvester.tick();
      await flush();
      await harvester.tick();
      await flush();
      assert.equal(calls, 1, 'segundo tick dentro do cooldown não consulta a conta');

      // cooldown 0: desliga o freio, cada tick checa de novo.
      (config.harvest as any).quotaWarnCooldownMs = 0;
      await harvester.tick();
      await flush();
      await harvester.tick();
      await flush();
      assert.equal(calls, 3, 'sem cooldown, cada tick checa');
    } finally {
      stub.restore();
      adapter.accountStatus = originalStatus;
      cache.forget(`${prefix('harvest')}quotaWarn`);
    }
  } finally {
    config.notify.enabled = saved.notifyEnabled;
    config.notify.webhookUrl = saved.webhookUrl;
    config.debrid.service = saved.service;
    config.debrid.apiKey = saved.apiKey;
    config.debrid.allowEnvKey = saved.allowEnvKey;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.jackettApiKey;
    (config.harvest as any).quotaWarnCooldownMs = cooldownMs;
  }
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `npm run build; node --test dist/test/harvester.test.js`
Expected: FAIL — `calls` sai 4 (ou 2 antes do ramo de cooldown 0), porque ainda não existe marcador: todo tick consulta.

- [ ] **Step 4: Implementar**

Em `src/providers/harvester.ts`, substitua `checkQuotaWarning` inteira:

```ts
async function checkQuotaWarning() {
  if (!config.notify.enabled || !config.notify.webhookUrl) return;
  const adapter = config.debrid.service ? debrid.BY_ID.get(config.debrid.service) : null;
  if (!adapter || typeof adapter.accountStatus !== 'function') return;
  if (!config.debrid.apiKey || !config.debrid.allowEnvKey) return;
  const cooldownMs = Math.max(0, config.harvest.quotaWarnCooldownMs);
  const marca = `${prefix('harvest')}quotaWarn`;
  // Checagem recente: a rede da conta não é perguntada a cada tick ocioso.
  if (cooldownMs > 0 && cache.get(marca)) return;
  try {
    const status = await adapter.accountStatus(config.debrid.apiKey);
    // Marcador a cada sucesso, sã ou não a conta: o problema era a frequência
    // da chamada, não só o spam do webhook. Erro de rede não grava — o tick
    // seguinte tenta de novo (erro instantâneo é barato).
    if (cooldownMs > 0) cache.set(marca, Date.now(), Math.ceil(cooldownMs / 1000));
    if (status && typeof status.magnets === 'number' && status.magnets >= config.notify.magnetsWarn) {
      await notify('debrid_quota_warning', 'warning', `Conta ${adapter.id} atingiu ${status.magnets} magnets (próximo do limite de 1000)`, {
        adapter: adapter.id,
        magnets: status.magnets,
        ready: status.ready,
        active: status.active,
      });
    }
  } catch (err: unknown) {
    log.debug('[harvest] verificação de quota falhou:', log.errorMessage(err));
  }
}
```

E no bloco de imports do topo, onde `prefix` ainda não é importado neste arquivo:

```ts
import { prefix } from '../utils/cache-keys.js';
```

- [ ] **Step 5: Documentar no `.env.example`**

No bloco das variáveis `HARVEST_*` do `.env.example`, adicione:

```
# Cooldown da checagem de quota do colhedor em ms (padrão 6h; 0 = checar a cada tick)
#HARVEST_QUOTA_WARN_COOLDOWN_MS=21600000
```

- [ ] **Step 6: Rodar e confirmar passagem**

Run: `npm run build; node --test dist/test/harvester.test.js`
Expected: PASS (`calls === 1` com cooldown, `=== 3` sem).

- [ ] **Step 7: Commit**

```powershell
git add src/config/harvest.ts src/providers/harvester.ts .env.example test/harvester.test.ts; git commit -m "fix(harvest): cooldown de 6h na checagem de quota da conta"
```

---

### Task 4: M4 — bludv com fallback de query (sem dependência do título pt)

**Files:**
- Modify: `src/providers/harvest-worker.ts:173-179` (bloco bludv)
- Test: `test/harvester.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Import no topo de `test/harvester.test.ts`:

```ts
import bludv from '../src/providers/bludv.js';
```

Teste:

```ts
test('bludv é consultado na colheita mesmo sem título pt-BR no TMDB', async () => {
  // O site é BR: post em PT casa com o título original o tempo todo. Antes,
  // `if (config.bludv.enabled && ptQuery)` deixava a colheita cega ao BluDV
  // quando o TMDB não tinha título pt para a obra.
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
    tmdbApiKey: config.tmdb.apiKey,
    ptSweepGlobal: config.jackett.ptSweepGlobal,
    bludvEnabled: config.bludv.enabled,
  };
  const originalSearch = bludv.search;
  const bludvQueries: string[] = [];
  (bludv as any).search = async (q: string) => {
    bludvQueries.push(q);
    return [];
  };
  const stub = stubFetch((url: string) => {
    if (url.includes('/api/v2.0/indexers/')) return { ok: true, status: 200, json: async () => ({ Results: [] }) };
    return { ok: false, status: 404, json: async () => ({}) }; // TMDB cai: sem título pt
  });
  try {
    config.bludv.enabled = true;
    config.jackett.ptSweepGlobal = false;
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['bludv-probe-idx'];

    config.jackett.apiKey = '';
    let guard = 0;
    while ((harvester.status() as any).queueDepth > 0 && guard++ < 250) await harvester.tick();

    const before = (harvester.status() as any).queriesThisHour || 0;
    config.harvest.maxPerHour = before + 50;
    config.jackett.apiKey = 'fake-key';
    cache.set('meta:movie:tt9500102', { name: 'Plain Original Movie', year: '2024', type: 'movie' }, 3600);
    harvester.enqueue({ imdbId: 'tt9500102', type: 'movie', reason: `bludv-test-${Date.now()}` } as any);
    await harvester.tick();

    assert.equal(bludvQueries.length, 1, 'bludv foi consultado sem ptQuery');
    assert.ok(bludvQueries[0].includes('Plain Original Movie'), `query de reserva é a original; recebido: ${bludvQueries[0]}`);
  } finally {
    (bludv as any).search = originalSearch;
    stub.restore();
    config.bludv.enabled = saved.bludvEnabled;
    config.jackett.ptSweepGlobal = saved.ptSweepGlobal;
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
    config.tmdb.apiKey = saved.tmdbApiKey;
  }
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm run build; node --test dist/test/harvester.test.js`
Expected: FAIL — `bludvQueries.length` é 0 (condição atual exige `ptQuery`).

- [ ] **Step 3: Implementar**

Em `src/providers/harvest-worker.ts`, substitua o bloco:

```ts
  if (config.bludv.enabled && ptQuery) {
    try {
      collected.push(...(await bludv.search(ptQuery)).filter((i: any) => !i.fromAccount));
    } catch (err: unknown) {
      log.warn('[harvest] bludv falhou:', log.errorMessage(err));
    }
  }
```

por:

```ts
  // Fallback de propósito: o BluDV é site BR e publica post em PT que casa com
  // o título original. Exigir ptQuery deixava a colheita cega ao BluDV para
  // toda obra sem título pt no TMDB.
  if (config.bludv.enabled) {
    try {
      collected.push(...(await bludv.search(ptQuery || query)).filter((i: any) => !i.fromAccount));
    } catch (err: unknown) {
      log.warn('[harvest] bludv falhou:', log.errorMessage(err));
    }
  }
```

- [ ] **Step 4: Rodar e confirmar passagem**

Run: `npm run build; node --test dist/test/harvester.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/providers/harvest-worker.ts test/harvester.test.ts; git commit -m "feat(harvest): bludv consultado com fallback do título original"
```

---

### Task 5: M5 — Varredura pt-BR parcial (fatia que cabe no orçamento)

**Files:**
- Modify: `src/providers/harvest-worker.ts:109-142` (bloco da varredura)
- Test: `test/harvester.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Teste (baseado no teste existente da varredura; mude `tmdb` e use id novo):

```ts
test('varredura pt-BR parcial: orçamento apertado colhe a fatia que cabe', async () => {
  // Antes era tudo-ou-nada: sem orçamento para os N alvos inteiros, a varredura
  // inteira (a consulta de maior valor por unidade) era sacrificada. Com fatia,
  // o que cabe no teto roda.
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
    ptBrIndexers: config.jackett.ptBrIndexers,
    tmdbApiKey: config.tmdb.apiKey,
  };
  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          movie_results: [
            {
              title: 'Star Wars: O Ataque dos Clones',
              original_title: 'Star Wars: Episode II - Attack of the Clones',
              release_date: '2002-05-16',
            },
          ],
        }),
      };
    }
    if (url.includes('/api/v2.0/indexers/')) return { ok: true, status: 200, json: async () => ({ Results: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['glob-a', 'glob-b', 'br-x'];
    config.jackett.ptBrIndexers = ['br-x'];
    config.tmdb.apiKey = 'chave-de-teste';

    config.jackett.apiKey = '';
    let guard = 0;
    while ((harvester.status() as any).queueDepth > 0 && guard++ < 250) await harvester.tick();

    cache.set(
      'meta:movie:tt9500103',
      { name: 'Star Wars: Episode II - Attack of the Clones', year: '2002', type: 'movie' },
      3600,
    );
    const antes = (harvester.status() as any).queriesThisHour || 0;
    const partialAntes = metrics.snapshot().counters['harvest.sweep.partial'] || 0;
    // Orçamento de UMA consulta: a varredura tem 2 alvos (glob-a, glob-b).
    harvesterLive.set({ harvestMaxPerHour: antes + 1 });
    config.harvest.maxPerHour = antes + 500; // .env alto: prova que quem manda é o live
    config.jackett.apiKey = 'chave-de-teste';
    harvester.enqueue({ imdbId: 'tt9500103', type: 'movie', reason: `partial-test-${Date.now()}` } as any);
    await harvester.tick();

    const expectedSweep = ptSweepQueryFor({
      titles: { pt: 'Star Wars: O Ataque dos Clones', original: 'Star Wars: Episode II - Attack of the Clones' },
    });
    assert.ok(expectedSweep, 'sanidade: há raiz pt para o título');
    const qOf = (u: string) => {
      try {
        return new URL(u).searchParams.get('Query') || '';
      } catch {
        return '';
      }
    };
    const jacketUrls = stub.calls.map((c) => c.url).filter((u) => u.includes('/api/v2.0/indexers/'));
    const sweepUrls = jacketUrls.filter((u) => qOf(u) === expectedSweep);
    assert.equal(sweepUrls.length, 1, 'a fatia consulta exatamente o alvo que cabe no orçamento');
    assert.ok(sweepUrls[0].includes('/indexers/glob-a'), 'a fatia começa pela cabeça da lista de alvos');
    assert.ok(!jacketUrls.some((u) => u.includes('/indexers/glob-b/') && qOf(u) === expectedSweep), 'glob-b ficou de fora (sem orçamento)');
    assert.ok((metrics.snapshot().counters['harvest.sweep.partial'] || 0) > partialAntes, 'colheita parcial contada');
  } finally {
    harvesterLive.reset();
    stub.restore();
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
    config.jackett.ptBrIndexers = saved.ptBrIndexers;
    config.tmdb.apiKey = saved.tmdbApiKey;
  }
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm run build; node --test dist/test/harvester.test.js`
Expected: FAIL — `sweepUrls.length` é 0 (guard tudo-ou-nada atual pula a varredura inteira com orçamento 1 < 2).

- [ ] **Step 3: Implementar**

Em `src/providers/harvest-worker.ts`, substitua o bloco do guard + varredura (linhas ~114 a ~142, o `if (sweepQuery && sweepTargets.length > 0) { ... }` inteiro) por:

```ts
  if (sweepQuery && sweepTargets.length > 0) {
    // Fatia em vez de tudo-ou-nada: sem orçamento para os N alvos inteiros, a
    // varredura NÃO é mais sacrificada por inteira — colhe a cabeça da lista na
    // ordem que ptSweepIndexers já devolve, na mesma moeda do teto e do gap.
    const restante = Math.max(0, live.harvestMaxPerHour - queriesThisHour());
    const fatia = restante > 0 ? sweepTargets.slice(0, restante) : [];
    if (!fatia.length) {
      log.debug('[harvest] teto horário atingido antes da varredura pt');
    } else {
      if (fatia.length < sweepTargets.length) metrics.count('harvest.sweep.partial');
      for (const target of fatia) {
        await awaitIndexerGap(target);
      }
      attempted += fatia.length;
      metrics.count('harvest.sweep');
      try {
        const items = await jackett.search(sweepQuery, entry.type, fatia, {
          matchContext,
          recordStatus: false,
        });
        for (const target of fatia) {
          lastQueryAt.set(target, Date.now());
        }
        succeeded += fatia.length;
        collected.push(...items.filter((i: any) => !i.fromAccount));
      } catch (err: unknown) {
        for (const target of fatia) {
          lastQueryAt.set(target, Date.now());
        }
        log.warn('[harvest] varredura pt falhou:', log.errorMessage(err));
      }
    }
  }
```

`live` vem da Task 1. O comentário acima do bloco (linhas ~94-108 sobre a varredura vir primeiro) permanece.

- [ ] **Step 4: Rodar e confirmar passagem**

Run: `npm run build; node --test dist/test/harvester.test.js`
Expected: PASS no teste novo; o teste antigo da varredura completa continua passando (com orçamento folgado a fatia é o total).

- [ ] **Step 5: Commit**

```powershell
git add src/providers/harvest-worker.ts test/harvester.test.ts; git commit -m "feat(harvest): varredura pt-BR parcial respeita o orçamento restante do teto"
```

---

### Task 6: M6 — Métrica da obra descartada após 3 cortes

**Files:**
- Modify: `src/providers/harvester.ts:102-104` (ramo `tries > 3` do `capped`)
- Test: `test/harvester.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

O teste avança o relógio com monkey-patch de `Date.now` para virar o balde horário a cada tick (o acumulador do teto é indexado por `Math.floor(Date.now()/3.6e6)` e `queriesThisHour()` poda baldes antigos — virar a hora zera o orçamento sem esperar 1h de verdade):

```ts
test('obra cortada 4 vezes pelo teto é descartada e conta harvest.capped.dropped', async () => {
  // Hoje a obra some da fila sem sinal depois de 3 cortes. A métrica torna o
  // descarte visível no /metrics.json.
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
  };
  const stub = stubFetch((url: string) => {
    if (url.includes('/api/v2.0/indexers/')) return { ok: true, status: 200, json: async () => ({ Results: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  const realNow = Date.now;
  let shift = 0;
  (Date as any).now = () => realNow.call(Date) + shift;
  const virarHora = () => {
    shift += 3_600_000 + 1_000;
  };
  try {
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['cap-a', 'cap-b', 'cap-c'];

    config.jackett.apiKey = '';
    let guard = 0;
    while ((harvester.status() as any).queueDepth > 0 && guard++ < 250) await harvester.tick();

    cache.set('meta:movie:tt9500104', { name: 'Capped Forever Movie', year: '2024', type: 'movie' }, 86_400);
    config.harvest.maxPerHour = 2; // cada hora gasta 2 de 3 indexers e corta
    config.jackett.apiKey = 'fake-key';
    harvester.enqueue({ imdbId: 'tt9500104', type: 'movie', reason: `drop-test-${Date.now()}` } as any);
    const droppedAntes = metrics.snapshot().counters['harvest.capped.dropped'] || 0;

    for (let i = 0; i < 4; i++) {
      await harvester.tick();
      virarHora();
    }
    await harvester.tick();

    const stored = (cache.get(`${prefix('harvest')}q`) || []) as any[];
    assert.ok(!stored.some((e) => e.imdbId === 'tt9500104'), 'obra descartada não está mais na fila');
    assert.ok((metrics.snapshot().counters['harvest.capped.dropped'] || 0) > droppedAntes, 'descarte contado');
  } finally {
    Date.now = realNow;
    stub.restore();
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
  }
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm run build; node --test dist/test/harvester.test.js`
Expected: FAIL na segunda asserção — a métrica não existe ainda (contador `undefined → 0`, não aumenta). A primeira asserção já passa hoje (o descarte existe, só é silencioso).

- [ ] **Step 3: Implementar**

Em `src/providers/harvester.ts`, no ramo `capped` do `tick`:

```ts
      if (tries <= 3) {
        metrics.count('harvest.capped');
        harvestQueue.head(entry);
        harvestQueue.persist();
      } else {
        attemptsByObra.delete(identity);
        // A obra saiu da fila sem cobertura completa: sem este contador o
        // descarte era invisível — só a próxima busca do usuário a traz de volta.
        metrics.count('harvest.capped.dropped');
      }
```

- [ ] **Step 4: Rodar e confirmar passagem**

Run: `npm run build; node --test dist/test/harvester.test.js`
Expected: PASS (4 cortes consomem as 3 readmissões + o 4º descarta no 5º tick).

- [ ] **Step 5: Commit**

```powershell
git add src/providers/harvester.ts test/harvester.test.ts; git commit -m "feat(harvest): métrica harvest.capped.dropped para obra descartada por cortes"
```

---

### Task 7: Validação completa

- [ ] **Step 1: Typecheck zero**

Run: `npm run typecheck`
Expected: sem saída (exit 0).

- [ ] **Step 2: Build + linha de orçamento**

Run: `npm run build; npm run lint:lines`
Expected: build limpo. Se `check-line-budget` apontar `src/providers/harvest-worker.ts` ou `src/providers/harvester.ts` acima do baseline registrado em `.line-budget.json`, ajuste os números registrados naquele JSON para o estado atual (mesma convenção dos commits anteriores) — **não** corte comentários explicativos para caber.

- [ ] **Step 3: Suíte do colhedor**

Run: `node --test dist/test/harvester.test.js dist/test/harvester-live.test.js dist/test/harvester-panel.test.js`
Expected: todos PASS (os dois últimos cobrem painel/config live e não devem ter regredido).

- [ ] **Step 4: Suíte completa**

Run: `npm test`
Expected: suíte inteira verde (centenas de testes; nenhum novo arquivo — `test:complete` não muda).

- [ ] **Step 5: Commit final (se Step 2 exigiu ajuste de budget)**

```powershell
git add .line-budget.json; git commit -m "chore: atualiza baseline de linhas do colhedor"
```

---

## Self-review do plano (já executada por quem escreveu)

1. **Cobertura da spec:** M1→Task 1, M2→Task 2, M3→Task 3, M4→Task 4, M5→Task 5, M6→Task 6. Testes 1-6 da spec mapeiam 1:1 nas Tasks 1-6. Kill-switch (env do cooldown) na Task 3, `.env.example` na Task 3 Step 5. Sem lacuna.
2. **Placeholders:** nenhum — todo passo de código mostra o código completo.
3. **Consistência de tipos:** `live` (Task 1) é usado pela Task 5; `harvestWorker.queriesThisHour()` exportado existe (`harvest-worker.ts:42`); `debrid.BY_ID` é a superfície real (`harvester.ts:42`); chaves `prefix('harvest')`/`prefix('rdq')` batem com os testes existentes.
