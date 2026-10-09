import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import bludv from '../bludv-resolver/server.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const toStr = (url: any) => (typeof url === 'string' ? url : url.href);
const okHtml = (html: any) => ({ ok: true, status: 200, text: async () => html });

describe('BluDV Resolver: fallback do resolvePost e chaves por preferência', () => {
  let originalFetch: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    bludv.postCache.clear();
    bludv.searchCache.clear();
    bludv.magnetCache.clear();
    bludv.inFlight.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('resolvePost: protetor morto no melhor botão cai para o próximo', async () => {
    const POST_URL = 'https://bludvfilmes.xyz/post-fallback/';
    const GOOD_MAGNET = `magnet:?xt=urn:btih:7777777777777777777777777777777777777777&dn=Ok`;
    const calls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      const u = toStr(url);
      calls.push(u);
      if (u.includes('post-fallback')) {
        return okHtml(`
          <h3>DUAL ÁUDIO</h3>
          <p><a href="https://systemads1.com/go/fail1">1080p</a></p>
          <p><a href="https://videosad.net/go/ok1">720p</a></p>
        `);
      }
      if (u.includes('fail1')) return { ok: false, status: 502 };
      if (u.includes('ok1')) return okHtml(`<script>var DEST_URL = "${GOOD_MAGNET}";</script>`);
      throw new Error(`Unexpected url: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const magnet = await bludv.resolvePost(POST_URL);
    assert.equal(magnet, GOOD_MAGNET);
    assert.ok(calls.some((u) => u.includes('fail1')), 'o primeiro botão foi tentado');
    assert.ok(calls.some((u) => u.includes('ok1')), 'o fallback foi tentado');

    // Quando NENHUM botão resolve, o erro do último propaga.
    bludv.postCache.clear();
    bludv.magnetCache.clear();
    globalThis.fetch = (async (url: any) => {
      const u = toStr(url);
      if (u.includes('post-fallback')) {
        return okHtml(`<p><a href="https://systemads1.com/go/fail1">1080p</a></p>`);
      }
      return { ok: false, status: 502 };
    }) as unknown as typeof globalThis.fetch;
    await assert.rejects(() => bludv.resolvePost(POST_URL), /http_502/);
  });

  test('resolvePost: o fallback para no teto de tentativas', async () => {
    // Post com 8 botões e o protetor inteiro fora do ar: sem teto, cada botão
    // consome TIMEOUT_MS (15s) enquanto o Jackett já desistiu em 8s — a task
    // seguia viva no inFlight segurando socket. O erro do último tentado é o
    // que propaga.
    const POST_URL = 'https://bludvfilmes.xyz/post-teto/';
    const buttons = Array.from(
      { length: 8 },
      (_, i) => `<p><a href="https://systemads1.com/go/dead${i}">1080p</a></p>`,
    ).join('\n');
    let protectorHits = 0;
    globalThis.fetch = (async (url: any) => {
      const u = toStr(url);
      if (u.includes('post-teto')) return okHtml(`<h3>DUAL ÁUDIO</h3>${buttons}`);
      protectorHits += 1;
      return { ok: false, status: 502 };
    }) as unknown as typeof globalThis.fetch;

    await assert.rejects(() => bludv.resolvePost(POST_URL), /http_502/);
    assert.equal(protectorHits, 5, 'tenta no máximo MAX_RESOLVE_ATTEMPTS botões');
    assert.equal(bludv.inFlight.size, 0, 'nada fica pendurado no inFlight');
  });

  test('resolvePost: a chave da cache distingue as preferências', async () => {
    // /resolve aceita audio= e quality=; chave sem prefs serviria o magnet
    // dublado pra quem pediu legendado na segunda chamada.
    const POST_URL = 'https://bludvfilmes.xyz/post-prefs/';
    const DUB_MAGNET = `magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=dub`;
    const LEG_MAGNET = `magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=leg`;
    globalThis.fetch = (async (url: any) => {
      const u = toStr(url);
      if (u.includes('post-prefs')) {
        return okHtml(`
          <h3>VERSÃO MKV DUAL ÁUDIO</h3>
          <p><a href="${DUB_MAGNET}">1080p Dublado</a></p>
          <h3>VERSÃO MP4 LEGENDADO</h3>
          <p><a href="${LEG_MAGNET}">720p</a></p>
        `);
      }
      throw new Error(`Unexpected url: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    assert.equal(await bludv.resolvePost(POST_URL), DUB_MAGNET, 'sem prefs o dublado vence');
    assert.equal(await bludv.resolvePost(POST_URL, { audio: 'legendado' }), LEG_MAGNET, 'legendado não recebe o cache do dublado');

    assert.ok(bludv.magnetCache.has(`magnet:best:${POST_URL}::`));
    assert.ok(bludv.magnetCache.has(`magnet:best:${POST_URL}:legendado:`));
  });
});

