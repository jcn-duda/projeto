import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixture = (name: any) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

import nerd from '../nerdfilmes-resolver/server.js';
// --- NerdFilmes --------------------------------------------------------

test('nerdfilmes: card sem title não vira release e a URL repetida entra uma vez', () => {
  const posts = nerd.parsePosts(fixture('nerdfilmes-search.html'));

  assert.deepEqual(posts, [
    {
      url: 'https://nerdfilmes.org/senhor-dos-aneis-a-sociedade-do-anel/',
      title: 'O Senhor dos Anéis: A Sociedade do Anel Torrent (2001) BluRay 1080p Dual Áudio',
    },
    { url: 'https://nerdfilmes.org/matrix/', title: 'Matrix Torrent (1999) BluRay 2160p Dublado' },
  ]);
});

test('nerdfilmes: só âncora com host protetor vira botão', () => {
  const links = nerd.parseDownloadLinks(fixture('nerdfilmes-post.html'));

  // O botão do Telegram tem a mesma classe dos de download: quem filtra é o host.
  assert.deepEqual(
    links.map((link) => link.url),
    [
      'https://systemads1.com/go/nf-aaa',
      'https://videosad.net/go/nf-bbb',
      'https://systemads.net/go/nf-ccc',
    ],
  );
  assert.deepEqual(
    links.map((link) => ({ q: link.quality, size: link.size, audio: link.audio })),
    [
      { q: 1080, size: '3.2 GB', audio: 'dublado' },
      { q: 2160, size: '28.7 GB', audio: 'dublado' },
      { q: 720, size: '1.4 GB', audio: 'legendado' },
    ],
  );
});

test('nerdfilmes: parsePostDate lê o meta de publicação em ISO', () => {
  // A data alimenta o pubDate do feed; sem ela o Jackett ordena tudo por "agora".
  assert.equal(nerd.parsePostDate(fixture('nerdfilmes-post.html')), '2024-05-09T16:45:00.000Z');
  assert.equal(nerd.parsePostDate('<html><body>sem meta</body></html>'), null);
});

// --- NerdFilmes: layout novo (magnet direto no href) --------------------
//
// O tema trocou o botão protegido pelo magnet direto
// ("magnet:?xt=urn:btih:..."), como o BLUDV já fazia. Qualidade/áudio/tamanho
// continuam saindo do texto ao redor — <h3> da seção ("S05.1080p | MKV |
// 2.19 GB | Dual Áudio:") e texto da âncora ("1080p") —; o que mudou é o href,
// que deixa de passar por fetch. Contrato do magnet: só entra com
// xt=urn:btih de 40 hex ou 32 base32 em QUALQUER posição da query; sem btih
// (nem só btmh), curto ou com caractere fora do alfabeto, o link é ignorado.
// Antes do patch o href magnet tinha hostname vazio, caía fora do allowlist e
// o post inteiro voltava sem nenhum botão.

test('nerdfilmes: magnet direto vira botão no layout de série (E01/E02, qualidade no texto da âncora)', () => {
  // Estrutura real do site: <h3> com spec por seção + "Episódio NN:" antes de
  // cada magnet; o texto da âncora é só a qualidade ("1080p"). O &amp; do href
  // tem que virar & — magnet com entidade não resolve.
  const html = `
    <h3 style="text-align: center;"><strong>S05.1080p | MKV | 2.19 GB | Dual Áudio:</strong></h3>
    <p style="text-align: center;"><strong><span style="color: #808080;">Episódio 01:</span> <a href="magnet:?xt=urn:btih:14ab38e43956dc45f05f9c1770fe5b6330c6ef71&amp;dn=Harley.Quinn.S05E01.1080p.DUAL" rel="noopener">1080p</a></strong></p>
    <p style="text-align: center;"><strong><span style="color: #808080;">Episódio 02:</span> <a href="magnet:?xt=urn:btih:2d0f6c3c2d281142f6d82ebdca6891a1c4b6c2d2&amp;dn=Harley.Quinn.S05E02.1080p.DUAL" rel="noopener">1080p</a></strong></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.equal(links.length, 2, 'os dois magnet diretos viram botão');
  assert.equal(links[0].url, 'magnet:?xt=urn:btih:14ab38e43956dc45f05f9c1770fe5b6330c6ef71&dn=Harley.Quinn.S05E01.1080p.DUAL');
  assert.equal(links[1].url, 'magnet:?xt=urn:btih:2d0f6c3c2d281142f6d82ebdca6891a1c4b6c2d2&dn=Harley.Quinn.S05E02.1080p.DUAL');
  // E01 herda o spec do <h3> (tamanho incluso); E02 só tem o "1080p" do próprio
  // texto — tamanho ausente vira o sentinela "1 KB" no feed, não inventado.
  assert.deepEqual(links.map((link) => ({ episode: link.episode, quality: link.quality, size: link.size, audio: link.audio })), [{ episode: 1, quality: 1080, size: '2.19 GB', audio: 'dublado' }, { episode: 2, quality: 1080, size: null, audio: 'dublado' }]);
});

test('nerdfilmes: magnet direto vira botão no layout de filme (spec no <h3>, âncora só com imagem)', () => {
  // Post de filme real: <h3> "BluRay 1080p | MKV | 2.6 GB | Dual Áudio:" e a
  // âncora sem texto nenhum (só <img>) — a qualidade não pode depender do
  // texto da âncora aqui. O href usa &#038; em vez de &amp;.
  const html = `
    <h3 style="text-align: center;"><strong>BluRay 1080p | MKV | 2.6 GB | Dual Áudio:</strong></h3>
    <p style="text-align: center;"><strong><a rel="nofollow" href="magnet:?xt=urn:btih:acb6b94265ac592f8871c34e16e6e00a3aa6daa8&#038;dn=Coringa.2019.1080p.DUAL"><img src="/magnet-link-download.png" alt="Magnet Link"></a></strong></p>
    <h3 style="text-align: center;"><strong>BluRay 2160p | MKV | 13 GB | Dual Áudio:</strong></h3>
    <p style="text-align: center;"><strong><a rel="nofollow" href="magnet:?xt=urn:btih:c129c07cb646e9b0f7618489bfb3fce24ce67912&#038;dn=Coringa.2019.2160p.DUAL"><img src="/magnet-link-download.png" alt="Magnet Link"></a></strong></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.equal(links.length, 2);
  assert.equal(links[0].url, 'magnet:?xt=urn:btih:acb6b94265ac592f8871c34e16e6e00a3aa6daa8&dn=Coringa.2019.1080p.DUAL');
  assert.equal(links[1].url, 'magnet:?xt=urn:btih:c129c07cb646e9b0f7618489bfb3fce24ce67912&dn=Coringa.2019.2160p.DUAL');
  assert.deepEqual(links.map((link) => ({ episode: link.episode, quality: link.quality, size: link.size, audio: link.audio, source: link.source })), [{ episode: null, quality: 1080, size: '2.6 GB', audio: 'dublado', source: 'BluRay' }, { episode: null, quality: 2160, size: '13 GB', audio: 'dublado', source: 'BluRay' }]);
});

test('nerdfilmes: qualidade e "Dual Áudio" no texto da âncora guiam o botão (E01/E02)', () => {
  // Layout descrito no pedido: o botão carrega qualidade E trilha no próprio
  // texto ("720p Dual Áudio"). A qualidade tem que sair da âncora (o segmento
  // não tem resolução) e o áudio da seção continua valendo.
  const html = `
    <h3>VERSÃO MKV DUAL ÁUDIO</h3>
    <p>EPISÓDIO 01</p>
    <p><a href="magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=ep01.720p">720p Dual Áudio</a></p>
    <p><a href="magnet:?xt=urn:btih:2222222222222222222222222222222222222222&dn=ep01.1080p">1080p Dual Áudio</a></p>
    <p>EPISÓDIO 02</p>
    <p><a href="magnet:?xt=urn:btih:3333333333333333333333333333333333333333&dn=ep02.2160p">2160p Dual Áudio</a></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.equal(links.length, 3);
  assert.deepEqual(links.map((link) => ({ episode: link.episode, quality: link.quality, size: link.size, audio: link.audio })), [{ episode: 1, quality: 720, size: null, audio: 'dublado' }, { episode: 1, quality: 1080, size: null, audio: 'dublado' }, { episode: 2, quality: 2160, size: null, audio: 'dublado' }]);
});

test('nerdfilmes: "Dual Áudio"/"Legendado" só no texto da âncora também define a trilha', () => {
  // Sem <h3> de seção antes dos botões, o rótulo da trilha mora na âncora.
  // Se o parser ler áudio só do segmento, estes botões saem "desconhecido" e a
  // vaga BR reservada do addon (dublado) fica em risco — o contrato do layout
  // novo é o texto da âncora mandar. Ajuste aqui se o site real nunca publicar
  // trilha na âncora: este teste é o espelho do pedido, não da fixture.
  const html = `
    <p>EPISÓDIO 01</p>
    <p><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=ep01.1080p">1080p Dual Áudio</a></p>
    <p><a href="magnet:?xt=urn:btih:4444444444444444444444444444444444444444&dn=ep01.720p">720p Legendado</a></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.deepEqual(links.map((link) => ({ quality: link.quality, audio: link.audio })), [{ quality: 1080, audio: 'dublado' }, { quality: 720, audio: 'legendado' }]);
});

test('nerdfilmes: btih aceita 40 hex, 32 base32 e o par btih+btmh que o site publica', () => {
  // Os episódios 03/04/07 reais carregam um segundo xt=urn:btmh: ao lado do
  // btih — o btmh extra não pode invalidar o magnet, e a ORDEM dos dois xt não
  // importa: btmh antes do btih também vale. O prefixo e o hash são
  // case-insensitive — URN:BTIH, UrN:bTiH e hash em caixa alta entram igual.
  // O NOME do parâmetro também é case-insensitive: XT= e xT= entram igual.
  const html = `
    <h3>DUAL ÁUDIO</h3>
    <p>EPISÓDIO 01</p>
    <p><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=hex.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?xt=urn:btih:MFRGGZDFMZTWQ2LKNNWG23TPOBY42XPP&dn=base32.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?xt=urn:btih:f361544be19ea486eafa633e2fed1cc823a6aab3&xt=urn:btmh:12206304cad79ac3a7394008d7b01d0c75d8df3e4f233e4152880eee3b3234f8792d&dn=ep03.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?xt=urn:btmh:12206304cad79ac3a7394008d7b01d0c75d8df3e4f233e4152880eee3b3234f8792d&xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=btmh.primeiro.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?xt=URN:BTIH:0123456789abcdef0123456789abcdef01234567&dn=prefixo.upper.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?xt=UrN:bTiH:MFRGGZDFMZTWQ2LKNNWG23TPOBY42XPP&dn=prefixo.misto.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=hash.upper.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?XT=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=param.upper.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?xT=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=param.misto.1080p">1080p Dublado</a></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.equal(links.length, 9);
  assert.equal(links[0].url, 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=hex.1080p');
  assert.equal(links[1].url, 'magnet:?xt=urn:btih:MFRGGZDFMZTWQ2LKNNWG23TPOBY42XPP&dn=base32.1080p');
  assert.equal(links[2].url, 'magnet:?xt=urn:btih:f361544be19ea486eafa633e2fed1cc823a6aab3&xt=urn:btmh:12206304cad79ac3a7394008d7b01d0c75d8df3e4f233e4152880eee3b3234f8792d&dn=ep03.1080p');
  // btmh PRIMEIRO e btih válido DEPOIS: a ordem dos xt não pode importar.
  assert.equal(links[3].url, 'magnet:?xt=urn:btmh:12206304cad79ac3a7394008d7b01d0c75d8df3e4f233e4152880eee3b3234f8792d&xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=btmh.primeiro.1080p');
  // Prefixo urn:btih em caixa alta/mista: o /i do contrato aceita ambos.
  assert.equal(links[4].url, 'magnet:?xt=URN:BTIH:0123456789abcdef0123456789abcdef01234567&dn=prefixo.upper.1080p');
  assert.equal(links[5].url, 'magnet:?xt=UrN:bTiH:MFRGGZDFMZTWQ2LKNNWG23TPOBY42XPP&dn=prefixo.misto.1080p');
  // Hash em caixa alta (ABCDEF) também é 40 hex para o regex /i.
  assert.equal(links[6].url, 'magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=hash.upper.1080p');
  // Nome do parâmetro em caixa alta/mista: o resolver normaliza com toLowerCase.
  assert.equal(links[7].url, 'magnet:?XT=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=param.upper.1080p');
  assert.equal(links[8].url, 'magnet:?xT=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=param.misto.1080p');
});

test('nerdfilmes: regex do download.before do cardigann preserva o magnet com dn/btmh antes do btih', () => {
  // jackett-bludv/nerdfilmes.yml: o filtro regexp do download.before é
  // "(magnet:\?[^\s"'<>]+)" — exclui espaço/aspas/<> mas NÃO o &, senão dn ou
  // btmh antes do xt=btih truncaria o magnet na resolução e o btih sumiria.
  // O teste lê a regex do próprio yml (não duplica a string) e prova que o
  // magnet inteiro sobrevive e o btih continua extraível do que sobrou.
  const yml = fs.readFileSync(path.join(__dirname, '..', 'jackett-bludv', 'nerdfilmes.yml'), 'utf8');
  const argsMatch = yml.match(/\n\s*args:\s*"((?:[^"\\]|\\.)*magnet:(?:[^"\\]|\\.)*)"/);
  assert.ok(argsMatch, 'o download.before do nerdfilmes.yml precisa ter args com a regex do magnet');
  // YAML double-quoted: "\\?" e "\\s" vêm escapados no arquivo; virar "\?" e "\s".
  const magnetRe = new RegExp(argsMatch![1].replace(/\\\\/g, '\\'));

  const cases = [
    {
      magnet: 'magnet:?dn=Harley.Quinn.S05E01.1080p.DUAL&xt=urn:btih:14ab38e43956dc45f05f9c1770fe5b6330c6ef71&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce',
      btih: '14ab38e43956dc45f05f9c1770fe5b6330c6ef71',
      label: 'dn antes do xt=btih',
    },
    {
      magnet: 'magnet:?xt=urn:btmh:12206304cad79ac3a7394008d7b01d0c75d8df3e4f233e4152880eee3b3234f8792d&xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce',
      btih: '0123456789abcdef0123456789abcdef01234567',
      label: 'btmh antes do xt=btih',
    },
  ];
  for (const { magnet, btih, label } of cases) {
    const captured = magnet.match(magnetRe)?.[1];
    assert.equal(captured, magnet, `${label}: a regex preserva o magnet inteiro (não corta no &)`);
    assert.equal(captured.match(/urn:btih:([0-9a-f]{40})/i)?.[1], btih, `${label}: o btih continua extraível do magnet preservado`);
  }
});

test('nerdfilmes: "TEMPORADA COMPLETA" no texto da âncora zera o episódio sem cabeçalho de reset', () => {
  // Pack em botão próprio: sem <h3> de reset antes, o texto do próprio botão
  // ("TEMPORADA COMPLETA") tem que derrubar o E12 herdado — senão o pack de
  // temporada inteira vira "E12" na lista. O reset é local: o E13 da âncora
  // seguinte continua funcionando.
  const html = `
    <h3>DUAL ÁUDIO</h3>
    <p>EPISÓDIO 12</p>
    <p><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=ep12.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?xt=urn:btih:4444444444444444444444444444444444444444&dn=pack.1080p">TEMPORADA COMPLETA 1080p Dublado</a></p>
    <p>EPISÓDIO 13</p>
    <p><a href="magnet:?xt=urn:btih:5555555555555555555555555555555555555555&dn=ep13.1080p">1080p Dublado</a></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.deepEqual(links.map((link) => link.episode), [12, null, 13]);
});

test('nerdfilmes: xt=urn:btih fora da primeira posição da query continua válido', () => {
  const html = `
    <h3>DUAL ÁUDIO</h3>
    <p>EPISÓDIO 01</p>
    <p><a href="magnet:?dn=ep01.1080p&xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce">1080p Dublado</a></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'magnet:?dn=ep01.1080p&xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce');
});

test('nerdfilmes: magnet sem btih, curto, com caractere inválido ou só btmh é ignorado', () => {
  // Só o primeiro (btih hex de 40 chars) é um magnet que o cliente de torrent
  // sabe usar; os demais iriam pro play e quebrariam — ou seriam release
  // fantasma gastando a vaga BR reservada.
  const html = `
    <h3>DUAL ÁUDIO</h3>
    <p>EPISÓDIO 01</p>
    <p><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=ep01.ok">1080p Dublado</a></p>
    <p><a href="magnet:?dn=ep01.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?xt=urn:btih:abc123&dn=ep01.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?xt=urn:btih:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz&dn=ep01.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?xt=urn:btmh:12206304cad79ac3a7394008d7b01d0c75d8df3e4f233e4152880eee3b3234f8792d&dn=ep01.1080p">1080p Dublado</a></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=ep01.ok');
  assert.equal(links[0].episode, 1);
});

test('nerdfilmes: href HTTP para host fora da allowlist é ignorado no layout novo', () => {
  // Botão externo/afiliado/Telegram no meio do post não pode virar release BR
  // — magnet válido só com btih; http(s) continua exigindo host protetor.
  const html = `
    <h3>DUAL ÁUDIO</h3>
    <p>EPISÓDIO 01</p>
    <p><a href="https://exemplo-invalido.com.br/go/xyz">1080p Dublado</a></p>
    <p><a href="https://t.me/nerdfilmes">Telegram</a></p>
    <p><a href="https://www.xnerdfilmes.net/outro-post/">outro post</a></p>
    <p><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=ep01">720p Dublado</a></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=ep01');
});

test('nerdfilmes: protetor permitido antigo continua aceito ao lado do magnet', () => {
  // Post híbrido (posts antigos com protetor + layout novo): os quatro hosts
  // base seguem virando botão — inclusive o canalfutebol, que nenhuma fixture
  // cobria — e a ordem de documento é preservada.
  const html = `
    <h3>DUAL ÁUDIO</h3>
    <p>EPISÓDIO 01</p>
    <p><a href="https://systemads1.com/go/nf-aaa">1080p Dublado</a></p>
    <p><a href="https://canalfutebol.com/go/nf-bbb">2160p Dublado</a></p>
    <p><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=ep01">720p Dublado</a></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.deepEqual(
    links.map((link) => ({ url: link.url, quality: link.quality, audio: link.audio, episode: link.episode })),
    [
      { url: 'https://systemads1.com/go/nf-aaa', quality: 1080, audio: 'dublado', episode: 1 },
      { url: 'https://canalfutebol.com/go/nf-bbb', quality: 2160, audio: 'dublado', episode: 1 },
      { url: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=ep01', quality: 720, audio: 'dublado', episode: 1 },
    ],
  );
});

test('nerdfilmes: seção antiga não regride — TEMPORADA COMPLETA zera o episódio e a troca de áudio vale', () => {
  // A máquina de estado dos protetores precisa sobreviver ao layout novo: o
  // pack depois do E02 não pode herdar o episódio 2 (viraria "E02" de pack na
  // lista) e o "LEGENDADO" da seção seguinte não pode ficar dublado.
  const html = `
    <h3>DUAL ÁUDIO</h3>
    <p>EPISÓDIO 01</p>
    <p><a href="magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=ep01.1080p">1080p Dublado</a></p>
    <p>EPISÓDIO 02</p>
    <p><a href="magnet:?xt=urn:btih:2222222222222222222222222222222222222222&dn=ep02.1080p">1080p Dublado</a></p>
    <h3>TEMPORADA COMPLETA</h3>
    <p><a href="magnet:?xt=urn:btih:3333333333333333333333333333333333333333&dn=pack.1080p">1080p Dublado</a></p>
    <h3>LEGENDADO</h3>
    <p>EPISÓDIO 03</p>
    <p><a href="magnet:?xt=urn:btih:4444444444444444444444444444444444444444&dn=ep03.720p">720p Legendado</a></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.deepEqual(links.map((link) => link.episode), [1, 2, null, 3], 'pack não herda o E02');
  assert.deepEqual(links.map((link) => link.audio), ['dublado', 'dublado', 'dublado', 'legendado'], 'troca de áudio vale por seção');
  assert.deepEqual(links.map((link) => link.quality), [1080, 1080, 1080, 720], 'cada botão carrega a própria qualidade');
});

test('nerdfilmes: costura parser→resolver→yml aceita MAGNET: e entrega scheme minúsculo', async () => {
  // Teste de COSTURA, não de parser: os testes acima provam só que
  // parseDownloadLinks aceita o href. O magnet ainda atravessa
  // fetchFollowingAllowed (que antes só reconhecia "magnet:" minúsculo e
  // estourava unsupported_protocol num href que o parser tinha aprovado) e
  // depois o filtro regexp do cardigann, que é case-sensitive. Por isso o
  // resolver NORMALIZA o scheme na saída: aceitar MAGNET: sem normalizar só
  // moveria a falha para depois do Jackett, onde nenhum teste olha.
  const html = `
    <h3>DUAL ÁUDIO</h3>
    <p>EPISÓDIO 01</p>
    <p><a href="MAGNET:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&amp;dn=ep01.1080p">1080p Dublado</a></p>
  `;
  const links = nerd.parseDownloadLinks(html);
  assert.equal(links.length, 1, 'o parser aceita o scheme em caixa alta');

  // Magnet direto não faz fetch: resolve offline, sem mock de rede.
  const resolved = await nerd.fetchFollowingAllowed(links[0].url, 'https://www.xnerdfilmes.net/post');
  assert.equal(resolved, 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=ep01.1080p', 'o scheme sai minúsculo e o &amp; sai decodificado');

  // E o que sai do resolver tem que casar o filtro do yml — a ponta que
  // fechava o circuito e não era coberta por nenhum teste.
  const yml = fs.readFileSync(path.join(__dirname, '..', 'jackett-bludv', 'nerdfilmes.yml'), 'utf8');
  const argsMatch = yml.match(/\n\s*args:\s*"((?:[^"\\]|\\.)*magnet:(?:[^"\\]|\\.)*)"/);
  const magnetRe = new RegExp(argsMatch![1].replace(/\\\\/g, '\\'));
  assert.equal(resolved.match(magnetRe)?.[1], resolved, 'a regex do cardigann captura o magnet normalizado inteiro');
});

test('nerdfilmes: a qualidade do texto de um magnet não vaza para o botão seguinte', () => {
  // O segmento de cada botão começa no fim do âncora anterior: o "2160p" do
  // primeiro texto não pode alimentar o segundo, senão o 720p sairia 2160p.
  const html = `
    <h3>DUAL ÁUDIO</h3>
    <p>EPISÓDIO 01</p>
    <p><a href="magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=ep01.2160p">2160p Dublado</a></p>
    <p><a href="magnet:?xt=urn:btih:2222222222222222222222222222222222222222&dn=ep01.720p">720p Dublado</a></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.deepEqual(links.map((link) => link.quality), [2160, 720]);
});
