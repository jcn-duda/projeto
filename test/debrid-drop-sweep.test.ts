// Suíte de testes: varredura dos mortos e de não-dublados antigos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as alldebrid from '../src/debrid/alldebrid.js';
import * as held from '../src/debrid/protected.js';
import { accountScope } from '../src/utils/request-key.js';
import { settle } from './helpers/alldebrid-account-mock.js';

let keepAlive: any;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => {
  clearInterval(keepAlive);
});

/** Dublê de conta com estados arbitrários, para exercitar a varredura. */
function mockAccountStates(magnets: any) {
  const deleted: number[] = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  const byId = new Map(magnets.map((m: any) => [m.id, m]));

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const body = (data: any) => ({ ok: true, async json() { return { status: 'success', data }; } });
    if (url.pathname.endsWith('/magnet/status')) return body({ magnets: [...byId.values()] });
    if (url.pathname.endsWith('/magnet/delete')) {
      const id = Number(url.searchParams.get('id'));
      deleted.push(id);
      byId.delete(id);
      return body({ message: 'deleted' });
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;
  return { deleted, restore() { globalThis.fetch = realFetch; AbortSignal.timeout = realTimeout; } };
}

/**
 * Dublê de conta com lista MUTÁVEL: o primeiro inventário carrega o acervo e
 * o que entra depois simula uploads do addon pós-snapshot — é a única forma
 * de algo ser candidato à limpeza (knownBefore protege tudo que já estava).
 */
function mockAccountMutable(magnets: any[]) {
  const deleted: number[] = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const body = (data: any) => ({ ok: true, async json() { return { status: 'success', data }; } });
    if (url.pathname.endsWith('/magnet/status')) return body({ magnets: [...magnets] });
    if (url.pathname.endsWith('/magnet/delete')) {
      const id = Number(url.searchParams.get('id'));
      deleted.push(id);
      return body({ message: 'deleted' });
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;
  return { deleted, magnets, restore() { globalThis.fetch = realFetch; AbortSignal.timeout = realTimeout; } };
}

const antigo = Math.floor(Date.now() / 1000) - 3 * 3600;
const velhoSec = Math.floor(Date.now() / 1000) - 10 * 24 * 3600; // 10 dias
const novoSec = Math.floor(Date.now() / 1000) - 60;               // agora há pouco
const SETE_DIAS = 7 * 24 * 3600 * 1000;

// --- Varredura dos mortos -------------------------------------------------

test('varredura remove só o que está em estado terminal', async () => {
  const api = mockAccountStates([
    { id: 1, hash: '1a'.repeat(20), status: 'Ready', uploadDate: antigo },
    { id: 2, hash: '2a'.repeat(20), status: 'Downloading', uploadDate: antigo },
    { id: 3, hash: '3a'.repeat(20), status: 'No peer after 30 minutes', uploadDate: antigo },
    { id: 4, hash: '4a'.repeat(20), status: 'Expired - Files removed', uploadDate: antigo },
    { id: 5, hash: '5a'.repeat(20), status: 'File not available - no peer', uploadDate: antigo },
  ]);
  try {
    const r = await alldebrid.sweepDead('chave-varredura');
    assert.deepEqual(api.deleted.sort(), [3, 4, 5], 'Ready e Downloading ficam');
    assert.equal(r.varridos, 3);
  } finally {
    api.restore();
  }
});

test('varredura não mata download do autofetch marcado cedo demais', async () => {
  const CHAVE = 'chave-varredura-held';
  const PROTEGIDO = '6a'.repeat(20);
  held.hold(PROTEGIDO, 60, accountScope(CHAVE));
  const api = mockAccountStates([
    { id: 7, hash: PROTEGIDO, status: 'No peer after 30 minutes', uploadDate: antigo },
    { id: 8, hash: '8a'.repeat(20), status: 'No peer after 30 minutes', uploadDate: antigo },
  ]);
  try {
    await alldebrid.sweepDead(CHAVE);
    assert.deepEqual(api.deleted, [8], 'o held sobrevive à varredura');
  } finally {
    held.release(PROTEGIDO, accountScope(CHAVE));
    api.restore();
  }
});

test('varredura respeita a margem de idade: morto recém-marcado fica', async () => {
  const agora = Math.floor(Date.now() / 1000);
  const api = mockAccountStates([
    { id: 9, hash: '9a'.repeat(20), status: 'No peer after 30 minutes', uploadDate: agora },
    { id: 10, hash: 'aa'.repeat(20), status: 'No peer after 30 minutes', uploadDate: antigo },
  ]);
  try {
    await alldebrid.sweepDead('chave-varredura-idade', { minAgeMs: 30 * 60 * 1000 });
    assert.deepEqual(api.deleted, [10], 'só o que passou da margem sai');
  } finally {
    api.restore();
  }
});

// --- Varredura de não-dublados antigos ------------------------------------

test('varredura undubbed: lixo velho sai; dub/dual/pt e o acervo ficam', async () => {
  const CHAVE = 'chave-varredura-undubbed-baldes';
  const api = mockAccountMutable([
    { id: 1, hash: 'c1'.repeat(20), status: 'Ready', filename: 'Old Movie 1990 1080p BluRay x264', uploadDate: velhoSec },
  ]);
  try {
    await alldebrid.warmInventory(CHAVE);
    await settle();

    api.magnets.push(
      { id: 2, hash: 'c2'.repeat(20), status: 'Ready', filename: 'Foreign Movie 2019 TrueFrench 1080p WEBRip', uploadDate: velhoSec },
      { id: 3, hash: 'c3'.repeat(20), status: 'Ready', filename: 'Nome do Filme 2019 Dublado 1080p', uploadDate: velhoSec },
      { id: 4, hash: 'c4'.repeat(20), status: 'Ready', filename: 'Nome do Filme 2019 Dual Audio 1080p', uploadDate: velhoSec },
      { id: 5, hash: 'c5'.repeat(20), status: 'Ready', filename: 'Coração de Vingança 2019 720p', uploadDate: velhoSec },
    );

    const r = await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS });
    assert.deepEqual(api.deleted, [2], 'só o balde lixo antigo sai; dub/dual/pt e knownBefore ficam');
    assert.equal(r.varridos, 1);
  } finally {
    api.restore();
  }
});

test('varredura undubbed: lixo recente sobrevive à idade mínima', async () => {
  const CHAVE = 'chave-varredura-undubbed-idade';
  const api = mockAccountMutable([
    { id: 1, hash: 'd1'.repeat(20), status: 'Ready', filename: 'Acervo Dublado do Usuário', uploadDate: velhoSec },
  ]);
  try {
    await alldebrid.warmInventory(CHAVE);
    await settle();

    api.magnets.push(
      { id: 2, hash: 'd2'.repeat(20), status: 'Ready', filename: 'Recent Movie 2024 1080p WEBRip', uploadDate: novoSec },
      { id: 3, hash: 'd3'.repeat(20), status: 'Ready', filename: 'Old Movie 2015 TrueFrench 720p HDTV', uploadDate: velhoSec },
    );

    await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS });
    assert.deepEqual(api.deleted, [3], 'o recente fica, o velho sai');
  } finally {
    api.restore();
  }
});

test('varredura undubbed: sem uploadDate não há prova de idade — fica', async () => {
  const CHAVE = 'chave-varredura-undubbed-sem-data';
  const api = mockAccountMutable([
    { id: 1, hash: 'g1'.repeat(20), status: 'Ready', filename: 'Acervo Dublado do Usuário', uploadDate: velhoSec },
  ]);
  try {
    await alldebrid.warmInventory(CHAVE);
    await settle();

    api.magnets.push(
      { id: 2, hash: 'g2'.repeat(20), status: 'Ready', filename: 'Old Foreign Movie 2012 1080p WEBRip x264' },
      { id: 3, hash: 'g3'.repeat(20), status: 'Ready', filename: 'Another Old Movie 2013 BRRip x264', uploadDate: 0 },
      { id: 4, hash: 'g4'.repeat(20), status: 'Ready', filename: 'Third Old Movie 2011 TrueFrench HDTV x264', uploadDate: velhoSec },
    );

    await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS });
    assert.deepEqual(api.deleted, [4], 'sem prova de idade, fica; só o datado e velho sai');
  } finally {
    api.restore();
  }
});

test('varredura undubbed: download do autofetch em hold sobrevive', async () => {
  const CHAVE = 'chave-varredura-undubbed-held';
  const PROTEGIDO = 'e2'.repeat(20);
  const api = mockAccountMutable([
    { id: 1, hash: 'e1'.repeat(20), status: 'Ready', filename: 'Acervo Dublado do Usuário', uploadDate: velhoSec },
  ]);
  held.hold(PROTEGIDO, 60, accountScope(CHAVE));
  try {
    await alldebrid.warmInventory(CHAVE);
    await settle();

    api.magnets.push(
      { id: 2, hash: PROTEGIDO, status: 'Downloading', filename: 'New Movie 2024 1080p WEBRip', uploadDate: velhoSec },
      { id: 3, hash: 'e3'.repeat(20), status: 'Ready', filename: 'Another Old Movie 2014 TrueFrench BRRip', uploadDate: velhoSec },
    );

    await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS });
    assert.deepEqual(api.deleted, [3], 'o held sobrevive à varredura');
  } finally {
    held.release(PROTEGIDO, accountScope(CHAVE));
    api.restore();
  }
});

test('varredura undubbed: inventário frio é AGUARDADO, não pula a rodada (bug dos 812)', async () => {
  const CHAVE = 'chave-varredura-undubbed-fria';
  const api = mockAccountMutable([
    { id: 2, hash: 'f2'.repeat(20), status: 'Ready', filename: 'Acervo Dublado do Usuário', uploadDate: velhoSec },
  ]);
  try {
    const r = await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS });
    assert.equal(r.pulado, undefined, 'inventário frio: aguarda e não pula a rodada');
    assert.deepEqual(api.deleted, [], 'preexistente continua protegido');
    await settle();
  } finally {
    api.restore();
  }
});

test('varredura undubbed: teto corta pelos mais antigos, independente da ordem', async () => {
  const CHAVE = 'chave-varredura-undubbed-teto';
  const agora = Math.floor(Date.now() / 1000);
  const api = mockAccountMutable([
    { id: 1, hash: 'a1'.repeat(20), status: 'Ready', filename: 'Acervo Dublado', uploadDate: velhoSec },
  ]);
  try {
    await alldebrid.warmInventory(CHAVE);
    await settle();

    const ordem = [3, 0, 4, 1, 2];
    for (const i of ordem) {
      api.magnets.push({
        id: 10 + i,
        hash: `a${i + 2}`.repeat(20),
        status: 'Ready',
        filename: `Old Movie ${2010 + i} TrueFrench 720p HDTV x264`,
        uploadDate: agora - (20 - i) * 24 * 3600,
      });
    }

    const r = await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS, max: 2 });
    assert.deepEqual(api.deleted.sort((a, b) => a - b), [10, 11], 'os dois mais antigos saem');
    assert.equal(r.varridos, 2);
  } finally {
    api.restore();
  }
});
