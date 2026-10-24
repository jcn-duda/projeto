import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import nerd from '../nerdfilmes-resolver/server.js';

// Gate same-origin `/link.php` do plugin botoes-viatorrents: o post aponta para
// o gate no MESMO host e o magnet só aparece no HTML dele. Vive num arquivo
// separado do resto dos parsers do nerdfilmes porque o assunto é outro (a
// travessia de um salto a mais, não a leitura de um card) — e porque o irmão
// já estava no teto de linhas.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: any) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// --- NerdFilmes: gate same-origin /link.php (plugin botoes-viatorrents) ---
const LINKPHP_BASE = 'https://www.filmesviatorrenthd.org/coringa-2019/';

test('nerdfilmes: aceita /link.php same-origin e rejeita outra path same-origin', () => {
  const links = nerd.parseDownloadLinks(fixture('nerdfilmes-post-linkphp.html'), LINKPHP_BASE);

  assert.deepEqual(
    links.map((link) => link.url),
    [
      'https://www.filmesviatorrenthd.org/link.php?id=abc123blob',
      'https://www.filmesviatorrenthd.org/Link.PHP?id=relativo720',
    ],
  );
  assert.deepEqual(
    links.map((link) => ({ q: link.quality, size: link.size, audio: link.audio })),
    [
      { q: 1080, size: '4.1 GB', audio: 'dublado' },
      { q: 720, size: '2.0 GB', audio: 'dublado' },
    ],
  );

  // Sem baseUrl não há origem do post — absoluto link.php no detail host
  // também fica de fora (não promove o domínio a protetor genérico).
  assert.equal(nerd.parseDownloadLinks(fixture('nerdfilmes-post-linkphp.html')).length, 0);
});

test('nerdfilmes: fetchFollowingAllowed extrai magnet do gate /link.php', async () => {
  const realFetch = globalThis.fetch;
  const gateHtml = fixture('nerdfilmes-linkphp-gate.html');
  const gateUrl = 'https://www.filmesviatorrenthd.org/link.php?id=abc123blob';
  globalThis.fetch = (async (input: any) => {
    const url = String(input?.url ?? input);
    if (url === gateUrl) {
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => gateHtml,
      };
    }
    throw new Error(`fetch inesperado: ${url}`);
  }) as unknown as typeof globalThis.fetch;

  try {
    const resolved = await nerd.fetchFollowingAllowed(gateUrl, LINKPHP_BASE);
    assert.equal(
      resolved,
      'magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&dn=Coringa.2019.1080p',
    );
    // Detail host já está na allowlist — /link.php não precisa de EXTRA_ALLOWED.
    assert.doesNotThrow(() => nerd.assertAllowedUrl(gateUrl));
    assert.throws(
      () => nerd.assertAllowedUrl('https://evil.example/link.php?id=x'),
      /blocked_host/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
