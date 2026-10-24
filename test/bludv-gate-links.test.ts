import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGateLinks, isGateUrl } from '../resolvers/profiles/bludv-gate-links.js';
import type { ResolverLink } from '../resolvers/types.js';
import { gateUrl, gatePost, multiGatePost, postUrl, legacyButton, magnet } from './helpers/bludv-gate-fixtures.js';
import { stubFetch } from './helpers/stub.js';

test('BLUDV gate: parser puro preserva metadata por botão, inclusive overlay e href relativo', () => {
  const stub = stubFetch(() => { throw new Error('parser puro não pode acessar rede'); });
  try {
    const links: ResolverLink[] = parseGateLinks(multiGatePost(), postUrl);
    assert.equal(links.length, 2);
    assert.deepEqual(links.map(({ url, quality, size, audio, source }) => ({ url, quality, size, audio, source })), [
      { url: gateUrl(), quality: 1080, size: '1.65 GB', audio: 'dublado', source: 'WEB-DL' },
      { url: gateUrl(102), quality: 720, size: '897 MB', audio: 'legendado', source: 'BLU-RAY' },
    ]);
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});

test('BLUDV gate: deduplica href sem misturar botões de portão com legado', () => {
  const html = gatePost() + gatePost() + legacyButton + `<a href="${magnet}">Magnet-Link</a>`;
  const links = parseGateLinks(html, postUrl);
  assert.equal(links.length, 1);
  assert.equal(links[0].url, gateUrl());
});

test('BLUDV gate: decodifica entidades da query e aceita aspas simples', () => {
  const html = `<p>WEB-DL 1080p Dublado (1.65 GB)</p>
    <a target='_blank' href='${gateUrl().replace('p=101', 'p=&#49;01')}'>Magnet-Link</a>`;
  assert.equal(parseGateLinks(html, postUrl)[0]?.url, gateUrl());
});

test('BLUDV gate: rejeita destino inseguro sem deixar URL de terceiro virar botão', () => {
  const path = '/gate/go/aaaaaaaaaaaaaaaa?p=101';
  const invalid = [
    `https://evil.example${path}`,
    `https://bludvfilmes1.xyz.evil.example${path}`,
    `https://127.0.0.1${path}`,
    `https://[::1]${path}`,
    `ftp://bludvfilmes1.xyz${path}`,
    `http://bludvfilmes1.xyz${path}`,
    `https://bludvfilmes1.xyz${path}&p=102`,
    `https://bludvfilmes1.xyz${path}#fragmento`,
    `javascript:location='https://bludvfilmes1.xyz${path}'`,
    `https://bludvfilmes1.xyz:8443${path}`,
    `https://usuario:senha-fixture@bludvfilmes1.xyz${path}`,
    `https://bludvfilmes.xyz${path}`,
    'https://bludvfilmes1.xyz/',
    'https://bludvfilmes1.xyz/gate/go/nao-hex?p=101',
    'https://bludvfilmes1.xyz/gate/go/aaaaaaaaaaaaaaaa',
  ];
  for (const url of invalid) {
    assert.equal(isGateUrl(url, postUrl), false, 'destino inválido aceito pelo detector');
    assert.equal(parseGateLinks(`<a href="${url}">Magnet-Link</a>`, postUrl).length, 0);
  }
});

test('BLUDV gate: detector aceita gate canônico, mas nunca legado ou callback', () => {
  assert.equal(isGateUrl(gateUrl()), true);
  assert.equal(isGateUrl(gateUrl(), postUrl), true);
  assert.equal(isGateUrl('/gate/go/aaaaaaaaaaaaaaaa?p=101', postUrl), true);
  // Domínio para onde o site redireciona desde 2026-10-24.
  assert.equal(isGateUrl('https://bludvfilmes2.xyz/gate/go/aaaaaaaaaaaaaaaa?p=101', 'https://bludvfilmes2.xyz/post/'), true);
  for (const url of ['https://systemads1.com/go/fixture', magnet, `${postUrl}?gate_error=too_fast`, '']) {
    assert.equal(isGateUrl(url, postUrl), false);
  }
});
