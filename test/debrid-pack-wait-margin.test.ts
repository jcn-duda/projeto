// Regressão do race real descoberto no 8281b43: o nonAbortableCheck repassava
// fileWaitTimeoutMs IGUAL ao timeoutMs da corrida externa, mas o timer externo
// começa ANTES da checagem (e o upload consome parte do orçamento). Leitura
// lenta de pack fazia a espera interna estourar DEPOIS do prazo externo —
// debrid.checkCached devolvia known:false/raceLost e o ⚡ desaparecia da lista
// por causa de um tamanho cosmético (fsz).
//
// O conserto: a espera interna desiste com a margem
// (DEBRID_PACK_FILES_WAIT_MARGIN_MS) ANTES do orçamento. Aqui exercitamos o
// caminho INTEIRO via debrid.checkCached (não chamada direta ao adapter), com
// leitura de arquivos mais lenta que a espera interna e mais lenta que o
// orçamento externo: o resultado tem que sair known:true com ⚡, sem raceLost,
// e o fsz aquece depois (em fundo) para a reabertura corrigir o tamanho.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import * as metrics from '../src/utils/metrics.js';
import { raceWithDeadline } from '../src/utils/deadline.js';
import { peekFileSizes, clearFileSizes, recordFileSizes } from '../src/debrid/file-sizes.js';
import { withDebrid } from './helpers/alldebrid-mock.js';
import type { DebridAdapter } from '../types/domain.js';

interface CheckResult {
  cached: Set<string>;
  known: boolean;
}

test('espera interna de pack desiste antes do prazo externo: known:true, ⚡ preservado, sem raceLost', async () => {
  const MARGIN = 150;
  const EXTERNAL = 600;   // orçamento da corrida externa (timeoutMs)
  const FILE_READ = 900;  // leitura de arquivos: mais lenta que tudo
  const PACK = 'a9'.repeat(20);
  const GB = 1024 ** 3;
  const calls: Array<{ options?: { timeoutMs?: number; fileWaitTimeoutMs?: number; fileHashes?: string[] } }> = [];
  // Gravação do fsz espelhada no contrato de file-sizes: o teste afirma o
  // MOMENTO em que o tamanho fica pronto (depois da resposta, nunca nela).
  const recordFileSizesLocal = (hashes: string[]) => {
    for (const hash of hashes) recordFileSizes(hash, [{ path: 'Pack/Filme.2009.1080p.DUAL.mkv', size: 2.1 * GB }]);
  };

  // Adapter no moldes da AllDebrid: upload instantâneo, leitura de arquivos
  // lenta, espera interna limitada pelo fileWaitTimeoutMs RECEBIDO (fail-open:
  // o ⚡ sai mesmo com a leitura ainda em fundo).
  const adapter = {
    id: 'premiumize',
    label: 'AllDebrid-like fake',
    short: 'ad',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    keyUrl: 'https://x.test',
    async checkCached(_apiKey: string, infoHashes: string[], options?: { timeoutMs?: number; fileWaitTimeoutMs?: number; fileHashes?: string[] }) {
      calls.push({ ...(options ? { options } : {}) });
      const inicio = Date.now();
      const limite = options?.fileWaitTimeoutMs ?? 10_000;
      const leitura = new Promise<void>((resolve) => {
        setTimeout(() => {
          recordFileSizesLocal(infoHashes);
          resolve();
        }, FILE_READ);
      });
      await raceWithDeadline(leitura, Math.max(0, limite - (Date.now() - inicio)), () => 'prazo' as const);
      return { cached: new Set(infoHashes), complete: true };
    },
    async resolveLink() {
      return null;
    },
  } as unknown as DebridAdapter;

  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const restaurarMargin = withDebrid({ packFilesWaitMarginMs: MARGIN });
  const opts = { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: `chave-fake-margem-${process.pid}` };
  const run = () =>
    runtime.run({ opts, encoded: '' }, () =>
      debrid.checkCached([PACK], { timeoutMs: EXTERNAL, forceFresh: true, fileHashes: [PACK] })) as Promise<CheckResult>;

  // O timer da corrida é unref'd; o keepAlive segura o loop até o fundo (900ms)
  // assentar e o teste conferir o fsz aquecido.
  const keepAlive = setInterval(() => {}, 1000);
  const raceLostAntes = metrics.snapshot().counters['debrid.check.raceLost'] ?? 0;
  try {
    clearFileSizes();
    const inicio = Date.now();
    const result = await run();
    const decorrido = Date.now() - inicio;

    // A margem chegou ao adaptador: fileWaitTimeoutMs = orçamento - margem.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options?.timeoutMs, undefined, 'NENHUM timeoutMs de rede chega ao adaptador');
    assert.equal(calls[0].options?.fileWaitTimeoutMs, EXTERNAL - MARGIN, 'a espera interna desiste com a margem antes do prazo');

    // O conserto em uma frase: a checagem vence a corrida externa apesar da
    // leitura de arquivos (900ms) ser mais lenta que o orçamento (600ms).
    assert.equal(result.known, true, 'leitura lenta de pack NÃO pode virar known:false');
    assert.ok(result.cached.has(PACK), 'o ⚡ do pack é preservado na resposta');
    assert.ok(decorrido < EXTERNAL, `a resposta sai dentro do prazo externo (voltou em ${decorrido}ms)`);

    // Sem perda de corrida: a degradação que apagava o ⚡ fica medida zero.
    const raceLostDepois = metrics.snapshot().counters['debrid.check.raceLost'] ?? 0;
    assert.equal(raceLostDepois, raceLostAntes, 'raceLost não incrementa');

    // O tamanho ainda NÃO foi corrigido nesta resposta: a leitura ficou em
    // fundo (é o fail-open de propósito). O fsz aquece depois e a reabertura
    // reanota.
    assert.ok(!peekFileSizes(PACK), 'o tamanho não é inventado na resposta: leitura segue em fundo');
    const teto = Date.now() + 5000;
    while (Date.now() < teto && !peekFileSizes(PACK)) await new Promise((r) => setTimeout(r, 50));
    assert.ok(peekFileSizes(PACK), 'a leitura em fundo gravou o fsz para a reabertura corrigir o tamanho');
  } finally {
    clearInterval(keepAlive);
    restaurarMargin();
    debrid.BY_ID.set('premiumize', original);
    clearFileSizes();
  }
});

test('passe tardio (sem timeoutMs) mantém o limite normal de cacheCheckTimeout na espera', async () => {
  const PACK = 'b7'.repeat(20);
  const calls: Array<{ options?: { timeoutMs?: number; fileWaitTimeoutMs?: number } }> = [];
  const adapter = {
    id: 'premiumize',
    label: 'AllDebrid-like fake',
    short: 'ad',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    keyUrl: 'https://x.test',
    async checkCached(_apiKey: string, infoHashes: string[], options?: { timeoutMs?: number; fileWaitTimeoutMs?: number }) {
      calls.push({ ...(options ? { options } : {}) });
      return { cached: new Set(infoHashes), complete: true };
    },
    async resolveLink() {
      return null;
    },
  } as unknown as DebridAdapter;
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const opts = { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: `chave-fake-tardio-${process.pid}` };
  try {
    const result = await (runtime.run({ opts, encoded: '' }, () =>
      debrid.checkCached([PACK], { fileHashes: [PACK] })) as Promise<CheckResult>);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options?.timeoutMs, undefined);
    assert.equal(calls[0].options?.fileWaitTimeoutMs, undefined, 'sem orçamento dinâmico a espera usa o teto do adaptador');
    assert.equal(result.known, true);
    assert.ok(result.cached.has(PACK));
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});
