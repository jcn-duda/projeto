// Fase 8, item 8.15 — a catraca do `preexistente`.
//
// O `submitted` era um Map em memória: o restart o apagava e o snapshot
// seguinte classificava TUDO que estava na conta como acervo do usuário —
// imune à limpeza para sempre. A conta saiu de ~0 para 904 magnets em 8 dias
// com o autofetch gateado (medido em produção, 2026-08-31): cada deploy lavava
// a própria sujeira. O conserto grava a posse em `adsub:v1` (sobrevive ao
// restart) COM regra de proveniência (o upload é idempotente e não diz se
// criou — sem prova de criação, NÃO etiqueta: é a polaridade do fail-safe que
// protege o acervo do usuário).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import { accountScope } from '../src/utils/request-key.js';
import {
  preexisting,
  rememberSubmitted,
  knownBefore,
  resetSubmittedForTests,
  submittedAt,
  forgetSubmitted,
  waitProvenanceReference,
} from '../src/debrid/alldebrid-inventory.js';
import { enqueue } from '../src/debrid/alldebrid-play.js';

const adsubKey = (account: string, hash: string) => `${prefix('adsub')}${account}:${hash}`;

const KEY = 'chave-adsub-restart';
const ACCOUNT = accountScope(KEY);
// 40 hex como os hashes reais.
const NOSSO = 'aa11'.repeat(10);
const DO_USUARIO = 'bb22'.repeat(10);

let realFetch: typeof globalThis.fetch;
let realTimeout: typeof AbortSignal.timeout;

before(() => {
  realFetch = globalThis.fetch;
  realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
});

after(() => {
  globalThis.fetch = realFetch;
  AbortSignal.timeout = realTimeout;
});

/** Repõe o estado por teste: memória de posse limpa, snapshots limpos, L1 limpo. */
function resetar() {
  resetSubmittedForTests();
  preexisting.clear();
  cache.forget(adsubKey(ACCOUNT, NOSSO));
  cache.forget(adsubKey(ACCOUNT, DO_USUARIO));
}

/** Dublê só do /magnet/status: devolve a lista de magnets da conta. */
function mockStatus(hashes: string[]) {
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/magnet/status')) {
      throw new Error(`URL inesperada: ${url.pathname}`);
    }
    const magnets = hashes.map((hash, i) => ({ hash, id: 1000 + i, status: 'Ready', ready: true }));
    return {
      ok: true,
      async json() {
        return { status: 'success', data: { magnets } };
      },
    } as any;
  }) as unknown as typeof globalThis.fetch;
}

function restaurarFetch() {
  globalThis.fetch = realFetch;
}

test('8.15: upload com prova de criação é etiquetado em memória E persistido', () => {
  resetar();
  try {
    // Snapshot fresco que NÃO contém o hash: o upload criou.
    preexisting.set(ACCOUNT, { hashes: new Set([DO_USUARIO]), loadedAt: Date.now() });
    rememberSubmitted(ACCOUNT, NOSSO);
    assert.notEqual(cache.get(adsubKey(ACCOUNT, NOSSO)), null, 'registro adsub gravado');
  } finally {
    resetar();
  }
});

test('8.15/B-1: hash JÁ presente no snapshot NÃO é etiquetado (pode ser acervo do usuário)', () => {
  resetar();
  try {
    // O upload é idempotente: uma busca que toca um magnet que o usuário já
    // tinha não pode reetiquetá-lo como "nosso" — seria o dano da catraca com
    // a polaridade invertida.
    preexisting.set(ACCOUNT, { hashes: new Set([DO_USUARIO]), loadedAt: Date.now() });
    rememberSubmitted(ACCOUNT, DO_USUARIO);
    assert.equal(cache.get(adsubKey(ACCOUNT, DO_USUARIO)), null, 'nada persistido sem prova de criação');
  } finally {
    resetar();
  }
});

test('8.15: sem inventário (conta fria) não etiqueta — fail-safe fecha no lado que protege', () => {
  resetar();
  try {
    // Sem snapshot (inventário em voo ou expirado), a ausência de prova não
    // autoriza a etiqueta: o pior caso é o lixo ficar protegido até a próxima
    // busca com inventário, nunca o contrário.
    rememberSubmitted(ACCOUNT, NOSSO);
    assert.equal(cache.get(adsubKey(ACCOUNT, NOSSO)), null);
  } finally {
    resetar();
  }
});

test('8.15: após restart simulado, a posse durável mantém o upload fora do preexistente', async () => {
  resetar();
  const realFetchLocal = globalThis.fetch;
  try {
    // Estado pré-restart: snapshot fresco contendo só o magnet do usuário;
    // a busca sobe NOSSO (prova de criação) e o registro vai ao cache.
    preexisting.set(ACCOUNT, { hashes: new Set([DO_USUARIO]), loadedAt: Date.now() });
    rememberSubmitted(ACCOUNT, NOSSO);

    // Restart: a memória do processo morre, o cache persiste.
    resetSubmittedForTests();
    preexisting.clear();
    assert.equal(preexisting.has(ACCOUNT), false, 'sem referência em memória, como após o restart');

    // O snapshot seguinte lê a conta com OS DOIS magnets.
    globalThis.fetch = (async (input: any) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/magnet/status')) {
        throw new Error(`URL inesperada: ${url.pathname}`);
      }
      return {
        ok: true,
        async json() {
          return {
            status: 'success',
            data: {
              magnets: [NOSSO, DO_USUARIO].map((hash, i) => ({ hash, id: 1000 + i, status: 'Ready', ready: true })),
            },
          };
        },
      } as any;
    }) as unknown as typeof globalThis.fetch;

    knownBefore(KEY, ACCOUNT);
    const merged = await preexisting.get(ACCOUNT)!.promise;
    assert.notEqual(merged, null);
    // A catraca quebrada: o que o addon subiu NÃO vira preexistente após o
    // restart — a limpeza volta a alcançá-lo.
    assert.equal(merged!.has(NOSSO), false, 'posse durável sobrevive ao restart');
    assert.equal(merged!.has(DO_USUARIO), true, 'acervo do usuário continua protegido');
  } finally {
    globalThis.fetch = realFetchLocal;
    resetar();
  }
});

test('8.15/B-1 e2e: magnet do usuário tocado por busca continua protegido após restart', async () => {
  resetar();
  const realFetchLocal = globalThis.fetch;
  try {
    // O usuário já tinha DO_USUARIO. A busca toca o mesmo hash, mas a regra de
    // proveniência recusa a etiqueta (hash presente no snapshot).
    preexisting.set(ACCOUNT, { hashes: new Set([DO_USUARIO]), loadedAt: Date.now() });
    rememberSubmitted(ACCOUNT, DO_USUARIO);
    assert.equal(cache.get(adsubKey(ACCOUNT, DO_USUARIO)), null, 'sem registro durável');

    // Restart + snapshot: o magnet do usuário precisa continuar na referência
    // protegida — se sumisse, o dropReady o apagaria na busca seguinte.
    resetSubmittedForTests();
    preexisting.clear();
    globalThis.fetch = (async (input: any) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/magnet/status')) {
        throw new Error(`URL inesperada: ${url.pathname}`);
      }
      return {
        ok: true,
        async json() {
          return {
            status: 'success',
            data: { magnets: [{ hash: DO_USUARIO, id: 1000, status: 'Ready', ready: true }] },
          };
        },
      } as any;
    }) as unknown as typeof globalThis.fetch;

    knownBefore(KEY, ACCOUNT);
    const merged = await preexisting.get(ACCOUNT)!.promise;
    assert.equal(merged!.has(DO_USUARIO), true, 'o magnet do usuário não vira lixo');
  } finally {
    globalThis.fetch = realFetchLocal;
    restaurarFetch();
    resetar();
  }
});

// --- Purga da posse e proveniência estrita no enqueue -----------------------
//
// O enqueue do autofetch usa a MESMA regra estrita da checagem (o antigo
// `proven: true` foi aposentado): snapshot contém o hash ⇒ não etiqueta;
// ausente ⇒ etiqueta; sem referência ⇒ não etiqueta (fail-safe). A purga
// (`forgetSubmitted`) é o fecho da limpeza: o que saiu de verdade da conta
// deixa de ser nosso, senão um re-add legítimo do usuário ficaria sem prova
// de criação no snapshot seguinte.

function mockUpload() {
  const realFetchLocal = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/magnet/upload')) {
      throw new Error(`URL inesperada: ${url.pathname}`);
    }
    const hashes = url.searchParams.getAll('magnets[]');
    return {
      ok: true,
      async json() {
        return { status: 'success', data: { magnets: hashes.map((hash) => ({ hash, id: 700, ready: true })) } };
      },
    } as any;
  }) as unknown as typeof globalThis.fetch;
  return () => { globalThis.fetch = realFetchLocal; };
}

test('enqueue estrito: snapshot contém o hash do usuário ⇒ sem adsub; ausente ⇒ com adsub', async () => {
  resetar();
  const restaurar = mockUpload();
  try {
    // Magnet do usuário reusado pelo enqueue: presente no snapshot, o upload
    // não criou nada — etiquetar seria a catraca com polaridade invertida.
    preexisting.set(ACCOUNT, { hashes: new Set([DO_USUARIO]), loadedAt: Date.now() });
    await enqueue(KEY, DO_USUARIO);
    assert.equal(submittedAt(ACCOUNT, DO_USUARIO), null, 'hash do usuário NÃO etiquetado');

    // Hash ausente do snapshot: o upload criou — etiqueta com prova.
    await enqueue(KEY, NOSSO);
    assert.notEqual(submittedAt(ACCOUNT, NOSSO), null, 'hash novo é etiquetado');
    assert.notEqual(cache.get(adsubKey(ACCOUNT, NOSSO)), null, 'etiqueta persistida');
  } finally {
    restaurar();
    resetar();
  }
});

test('enqueue sem referência de proveniência não etiqueta (fail-safe), após esperar o teto', async () => {
  resetar();
  const restaurar = mockUpload();
  const tetoReal = config.debridCheckFloor;
  config.debridCheckFloor = 120; // encurta a espera do teste
  try {
    // Sem snapshot e sem refresh em voo: a espera esgota o teto e o fail-safe
    // fecha no lado que protege — o pior caso é o download do chupim ficar
    // sem etiqueta, nunca o acervo do usuário ser etiquetado por engano.
    const inicio = Date.now();
    await enqueue(KEY, NOSSO);
    const gasto = Date.now() - inicio;
    assert.ok(gasto >= 100, `o enqueue esperou a referência pelo teto (gastou ${gasto}ms)`);
    assert.equal(submittedAt(ACCOUNT, NOSSO), null, 'sem referência NÃO etiqueta');
  } finally {
    config.debridCheckFloor = tetoReal;
    restaurar();
    resetar();
  }
});

test('forgetSubmitted purga a posse em memória E no registro durável', () => {
  resetar();
  try {
    preexisting.set(ACCOUNT, { hashes: new Set([DO_USUARIO]), loadedAt: Date.now() });
    rememberSubmitted(ACCOUNT, NOSSO);
    assert.notEqual(submittedAt(ACCOUNT, NOSSO), null, 'precondição: posse ativa');

    forgetSubmitted(ACCOUNT, NOSSO);
    assert.equal(submittedAt(ACCOUNT, NOSSO), null, 'posse em memória purgada');
    assert.equal(cache.peek(adsubKey(ACCOUNT, NOSSO)), null, 'registro durável purgado');
  } finally {
    resetar();
  }
});

test('waitProvenanceReference resolve com o snapshot corrente, com o previous do refresh, e nunca lança', async () => {
  resetar();
  try {
    assert.equal(await waitProvenanceReference(ACCOUNT, 10), false, 'sem referência: esgota o teto');

    preexisting.set(ACCOUNT, { hashes: new Set([DO_USUARIO]), loadedAt: Date.now() });
    assert.equal(await waitProvenanceReference(ACCOUNT), true, 'snapshot corrente é referência');

    // Durante o refresh (hashes null), o snapshot ANTERIOR também vale.
    preexisting.set(ACCOUNT, { hashes: null, loadedAt: 0, previous: new Set([DO_USUARIO]) });
    assert.equal(await waitProvenanceReference(ACCOUNT, 10), true, 'previous do refresh é referência');
  } finally {
    resetar();
  }
});
