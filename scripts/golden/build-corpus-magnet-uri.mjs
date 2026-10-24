#!/usr/bin/env node
/**
 * Gera `scripts/golden/corpus-magnet-uri.json`: casos de `magnet-uri.ts`
 * (`sanitizeMagnet`, `defaultMagnet` e `extractInfoHash`). Gerador descartável
 * do corpus; o arquivo commitado é a fonte.
 *
 * Operações (campo `op`): `sanitize` (uri, hash), `default` (hash) e `info`
 * (text, para extractInfoHash, que é exportada de title-normalization.ts).
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts/golden/corpus-magnet-uri.json');

const H = 'aabbccddeeff00112233445566778899aabbccdd';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const FLOOR = 'udp://tracker.opentrackr.org:1337/announce';
const MAGNET = (hash, rest = '') => `magnet:?xt=urn:btih:${hash}${rest}`;

const cases = [];
const add = (note, obj) => cases.push({ note, input: JSON.stringify(obj) });

// extractInfoHash (info)
add('info: vazio dá null', { op: 'info', text: '' });
add('info: 40 hex passa em minúscula', { op: 'info', text: H });
add('info: 40 hex em maiúscula vira minúscula', { op: 'info', text: H.toUpperCase() });
add('info: base32 de 32 caracteres vira hex', { op: 'info', text: B32 });
add('info: magnet com xt', { op: 'info', text: MAGNET(H, '&dn=x') });
add('info: btih em qualquer ponto', { op: 'info', text: `dn=btih:${H}` });
add('info: 39 caracteres não casam', { op: 'info', text: `btih:${H.slice(1)}` });
add('info: 32 caracteres fora do alfabeto base32 dá null', { op: 'info', text: 'btih:0123456789abcdefghijklmnopqrstuv' });
add('info: espaços em volta são removidos', { op: 'info', text: `  ${H}  ` });
add('info: BOM em volta é removido (trim do JS)', { op: 'info', text: `﻿${H}﻿` });
add('info: BTIH em caixa alta', { op: 'info', text: `BTIH:${H}` });
add('info: lixo sem btih dá null', { op: 'info', text: 'nada aqui' });

// defaultMagnet (default)
add('default: hash padrão com o piso de trackers', { op: 'default', hash: H });

// sanitizeMagnet (sanitize)
add('sanitize: sem dn e sem tracker do post dá null (é o padrão)', { op: 'sanitize', uri: MAGNET(H), hash: H });
add('sanitize: hash do xt diferente do da chave dá null', { op: 'sanitize', uri: MAGNET('11'.repeat(20)), hash: H });
add('sanitize: não começa com magnet:? dá null', { op: 'sanitize', uri: `http://x/${H}`, hash: H });
add('sanitize: uri nula dá null', { op: 'sanitize', uri: null, hash: H });
add('sanitize: xt de outro esquema dá null', { op: 'sanitize', uri: `magnet:?xt=urn:ed2k:${H}`, hash: H });
add('sanitize: btih em dn não forja identidade', { op: 'sanitize', uri: `magnet:?xt=urn:btih:${'11'.repeat(20)}&dn=btih:${H}`, hash: H });
add('sanitize: xt em base32 bate com o hash hex', { op: 'sanitize', uri: `magnet:?xt=urn:btih:${B32}&dn=Filme`, hash: '0123456789abcdef0123456789abcdef01234567' });
add('sanitize: dn curto é mantido como veio (com escape)', { op: 'sanitize', uri: MAGNET(H, '&dn=Filme%20Teste'), hash: H });
add('sanitize: dn vazio é preservado', { op: 'sanitize', uri: MAGNET(H, '&dn='), hash: H });
add('sanitize: dn com escape malformado curto é mantido', { op: 'sanitize', uri: MAGNET(H, '&dn=%E9x'), hash: H });
add('sanitize: tracker do post é mantido', { op: 'sanitize', uri: MAGNET(H, '&tr=udp%3A%2F%2Fx.example%3A80%2Fannounce'), hash: H });
add('sanitize: tracker igual ao piso não duplica', { op: 'sanitize', uri: MAGNET(H, `&tr=${encodeURIComponent(FLOOR)}`), hash: H });
add('sanitize: tracker repetido deduplica', { op: 'sanitize', uri: MAGNET(H, '&tr=udp%3A%2F%2Fa.example%3A80&tr=udp%3A%2F%2Fa.example%3A80'), hash: H });
add('sanitize: passkey no nome do parâmetro é descartado', { op: 'sanitize', uri: MAGNET(H, `&tr=${encodeURIComponent('udp://x.example/announce?passkey=abc')}`), hash: H });
add('sanitize: passkey em forma percent-encoded é descartado', { op: 'sanitize', uri: MAGNET(H, '&tr=udp%3A%2F%2Fx.example%2Fannounce%3Fpasskey%3Dabc'), hash: H });
add('sanitize: token curto no nome é descartado', { op: 'sanitize', uri: MAGNET(H, `&tr=${encodeURIComponent('http://x.example/a?token=1')}`), hash: H });
add('sanitize: segmento longo depois do announce é descartado', { op: 'sanitize', uri: MAGNET(H, `&tr=${encodeURIComponent('http://x.example/announce/ABCDEFGHIJKLMNOP1234')}`), hash: H });
add('sanitize: segmento longo antes do announce é descartado', { op: 'sanitize', uri: MAGNET(H, `&tr=${encodeURIComponent('http://x.example/ABCDEFGHIJKLMNOP1234/announce')}`), hash: H });
add('sanitize: valor de query de 16 chars é descartado', { op: 'sanitize', uri: MAGNET(H, `&tr=${encodeURIComponent('udp://x.example/announce?x=ABCDEFGHIJKLMNOP')}`), hash: H });
add('sanitize: valor com 15 chars passa', { op: 'sanitize', uri: MAGNET(H, `&tr=${encodeURIComponent('udp://x.example/announce?x=ABCDEFGHIJKLMNO')}`), hash: H });
add('sanitize: segunda delimitação (#) não entra na query', { op: 'sanitize', uri: MAGNET(H, `&tr=${encodeURIComponent('udp://x.example/announce?a=1#b=ABCDEFGHIJKLMNOP')}`), hash: H });
add('sanitize: key com s longo não casa passkey/secure', { op: 'sanitize', uri: MAGNET(H, `&tr=${encodeURIComponent('udp://x.example/announce?keſ=1')}`), hash: H });
add('sanitize: key com K de Kelvin não casa key', { op: 'sanitize', uri: MAGNET(H, `&tr=${encodeURIComponent('udp://x.example/announce?Key=1')}`), hash: H });
add('sanitize: escape malformado no tracker mantém o valor cru', { op: 'sanitize', uri: MAGNET(H, '&tr=%E9%E9'), hash: H });
add('sanitize: tracker com ponto não é credencial', { op: 'sanitize', uri: MAGNET(H, `&tr=${encodeURIComponent('http://x.example/announce.announce.announce')}`), hash: H });
add('sanitize: dn de caractere multibyte no limite', { op: 'sanitize', uri: MAGNET(H, `&dn=${'ç'.repeat(1200)}`), hash: H });
add('sanitize: dn longo ASCII é truncado', { op: 'sanitize', uri: MAGNET(H, `&dn=${'a'.repeat(3000)}`), hash: H });
add('sanitize: dn longo malformado é omitido', { op: 'sanitize', uri: MAGNET(H, `&dn=${'a'.repeat(3000)}%E9`), hash: H });
add('sanitize: tracker grande demais é pulado, menor depois entra', {
  op: 'sanitize',
  uri: MAGNET(H, `&tr=${encodeURIComponent('http://x.example/' + 'announce.'.repeat(300))}&tr=${encodeURIComponent('http://y.example/announce')}`),
  hash: H,
});
add('sanitize: muitos trackers preenchem até o teto', {
  op: 'sanitize',
  uri: MAGNET(H, Array.from({ length: 80 }, (_, i) => `&tr=${encodeURIComponent(`udp://t${i}.example:80/announce`)}`).join('')),
  hash: H,
});
add('sanitize: dn com fim ao lado de muitos trackers', {
  op: 'sanitize',
  uri: MAGNET(H, `&dn=${'Ç'.repeat(400)}` + Array.from({ length: 30 }, (_, i) => `&tr=${encodeURIComponent(`udp://u${i}.example:80/announce`)}`).join('')),
  hash: H,
});
add('sanitize: tr que decodifica para piso não duplica', { op: 'sanitize', uri: MAGNET(H, `&tr=${FLOOR}&dn=x`), hash: H });
add('sanitize: hash maiúsculo na chave é comparado em minúscula', { op: 'sanitize', uri: MAGNET(H), hash: H.toUpperCase() });

// corpus de inputs grandes para o teste de limite
const body = cases
  .map((c, i) => ({ id: `mu-${String(i + 1).padStart(3, '0')}`, input: c.input, note: c.note }))
  .map((c) => '    ' + JSON.stringify(c))
  .join(',\n');

writeFileSync(
  OUT,
  `{
  "version": "corpus-magnet-uri/1",
  "note": "magnet-uri.ts: sanitizeMagnet (op sanitize), defaultMagnet (op default) e extractInfoHash (op info). Entrada JSON; saída: magnet, hash ou 'null'. Cobre credenciais, truncamento de dn e as regras de decodeURIComponent/encodeURIComponent do JS. IDs estáveis.",
  "cases": [
${body}
  ]
}
`,
);
console.log(`[corpus] ${cases.length} casos`);
