// Régua do NOME DA OBRA compartilhada pelo TorrentDosFilmes e pelo
// ComandoTorrents (`work-name.ts`). Cada caso é um `<h1>` REAL da raspagem de
// 2026-09-28 que ia para `no-work` por sobra de vitrine no nome — e os casos
// de guarda são nomes que a régua NÃO pode comer.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanWorkName, fichaYear, h1Text, readWorkTitle, splitParenYear } from '../src/providers/crawl-sites/work-name.js';
import { workTitleYear as ctWorkTitleYear } from '../src/providers/crawl-sites/comandotorrents-discovery.js';
import { workTitleYear as tdfWorkTitleYear } from '../src/providers/crawl-sites/torrentdosfilmes-discovery.js';
import { pageSeasonOf, seasonPageGroups } from '../src/providers/crawl-sites/season-page.js';

const h1 = (text: string) => `<h1 class="entry-title">${text}</h1>`;
const nameOf = (text: string) => {
  const { rest, year } = splitParenYear(h1Text(h1(text)));
  return { title: cleanWorkName(rest), year };
};

describe('work-name: sobras de vitrine medidas', () => {
  const cases: Array<[string, string, number | null]> = [
    // ComandoTorrents (antes com `cleanPostTitle`)
    ['Curvas da Vida &#8211; GDRIVE (2012) BluRay 1080p Dual Áudio', 'Curvas da Vida', 2012],
    ['Em Meus Sonhos Torrent (2016) BluRay 720p e 1080p Dual Áudio', 'Em Meus Sonhos', 2016],
    ['Do Not Reply Torrent (2020) WEB-DL 720p e 1080p Legendado', 'Do Not Reply', 2020],
    ['O Regresso (2015) WEB-DL 720p Legendado / Legendas Fixas em Português', 'O Regresso', 2015],
    ['Eek The Cat Torrent Dublado 8 Episódios (1992)', 'Eek The Cat', 1992],
    // TorrentDosFilmes
    ['Quebrando Regras Torrent &#8211; Bluray 720p Dual Aúdio (2008)', 'Quebrando Regras', 2008],
    ['007 Contra o Satânico Dr. No &#8211; BluRay 3D HSBS (1962) Dual &#8211; Download Torrent', '007 Contra o Satânico Dr. No', 1962],
    ['À Procura da Liberdade Torrent (2016) DVD-R Oficial Dual Áudio', 'À Procura da Liberdade', 2016],
    ['À Procura da Liberdade Torrent (2016) DVD R Oficial Dual Áudio', 'À Procura da Liberdade', 2016],
  ];
  for (const [raw, title, year] of cases) {
    test(`"${raw}" → "${title}"`, () => {
      assert.deepEqual(nameOf(raw), { title, year });
    });
  }
});

describe('work-name: o que a régua NÃO pode comer', () => {
  test('3D sozinho é nome; só o par "3D HSBS/SBS/HOU" é formato de arquivo', () => {
    assert.equal(nameOf('Sea Rex 3D: Journey to a Prehistoric World (2010) Dublado 1080p').title,
      'Sea Rex 3D: Journey to a Prehistoric World');
    assert.equal(nameOf('Avatar 3D SBS (2009) BluRay 1080p').title, 'Avatar');
  });

  test('"Oficial", "Episódio" e "e" no meio do nome ficam', () => {
    assert.equal(nameOf('O Oficial e o Espião (2019) Dublado').title, 'O Oficial e o Espião');
    assert.equal(nameOf('Deuses e Monstros (1998) Dublado').title, 'Deuses e Monstros');
    assert.equal(nameOf('Star Wars: Episódio I (1999) BluRay').title, 'Star Wars: Episódio I');
  });

  test('ano solto não é ano; número do nome fica', () => {
    assert.deepEqual(nameOf('Blade Runner 2049 Torrent'), { title: 'Blade Runner 2049', year: null });
  });
});

describe('work-name: ano declarado na ficha', () => {
  test('h1 sem parêntese usa o "Lançamento" da ficha (recortes reais)', () => {
    const cores = h1('As Cores do Amor Torrent &#8211; WEB-DL 1080p Dual Áudio')
      + '<b>Título Original</b>: Colors of Love<br /> <strong>Lançamento</strong>: <a href="https://x/2021">2021</a><br />';
    assert.deepEqual(readWorkTitle(cores).year, 2021);
    assert.equal(readWorkTitle(cores).title, 'As Cores do Amor');
    assert.equal(fichaYear('<b>Ano de Lançamento:</b> 2017 (Brasil)<br />'), 2017);
    assert.equal(fichaYear('<b>Lan&ccedil;amento:</b> 1962<br />'), 1962);
  });

  test('o ano declarado que sobra no fim do nome sai; número diferente fica', () => {
    const paradox = h1('Comando Final 3 &#8211; Paradox 2018 Torrent &#8211; Dublado / Dual Áudio BluRay 720p | 1080p &#8211; Download')
      + '<b>Lançamento:</b> 2018<br />';
    assert.deepEqual({ title: readWorkTitle(paradox).title, year: readWorkTitle(paradox).year },
      { title: 'Comando Final 3 Paradox', year: 2018 });
    assert.equal(readWorkTitle(h1('Blade Runner 2049 (2017) Dublado')).title, 'Blade Runner 2049');
    assert.equal(readWorkTitle(h1('1984 (1984) Dublado')).title, '1984', 'o nome que É o ano não some');
  });

  test('parêntese no h1 vence a ficha; sem os dois, ano nulo', () => {
    assert.equal(readWorkTitle(h1('Juno (2007) Dublado') + '<b>Lançamento:</b> 2008').year, 2007);
    assert.equal(readWorkTitle(h1('Sem Ano Torrent')).year, null);
    assert.equal(fichaYear('<p>O lançamento do filme foi adiado.</p>'), null, 'palavra na sinopse não é ficha');
  });
});

describe('work-name: os dois sites usam a MESMA régua', () => {
  test('Comando e TorrentDosFilmes devolvem o mesmo nome para o mesmo `<h1>`', () => {
    const html = h1('Curvas da Vida &#8211; GDRIVE (2012) BluRay 1080p Dual Áudio');
    assert.equal(ctWorkTitleYear(html).title, tdfWorkTitleYear(html).title);
    assert.equal(ctWorkTitleYear(html).year, tdfWorkTitleYear(html).year);
  });
});

// Página de TEMPORADA dos WordPress BR (`season-page.ts`): em que chave cada
// botão nasce. Recortes reais da medição de 2026-09-28.
describe('season-page: temporada do post e locação de cada botão', () => {
  const mk = (title: string, dn?: string) => ({
    title,
    magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}${dn ? `&dn=${encodeURIComponent(dn)}` : ''}`,
    indexer: 'x', tracker: 'X', isBr: true, seeders: 1,
  });
  const loc = (title: string, dn?: string, season: number | null = 4) =>
    seasonPageGroups([mk(title, dn)], { season, title: 'The Boys 4ª Temporada' }).map((g) => [g.season, g.episode]);

  test('temporada do post: h1 primeiro, slug de reserva, nada quando não declara uma só', () => {
    assert.equal(pageSeasonOf('Better Call Saul 4ª Temporada', 'https://x/better-call-saul-4a-temporada-2025/'), 4);
    // TorrentDosFilmes: o h1 às vezes é só "Kingdom"; o slug declara.
    assert.equal(pageSeasonOf('Kingdom', 'https://x/kingdom-1a-temporada-720phdtv-2014-legendado-torrent/'), 1);
    assert.equal(pageSeasonOf('Filme Qualquer', 'https://x/filme-qualquer-2020/'), null);
  });

  test('rótulo "E01" sem temporada é lido com a temporada do post (não vira pack)', () => {
    // ComandoTorrents: o título da release sai "The Boys E01" — sem isso o
    // episódio ia para S4 inteira e aparecia como pack de todo episódio.
    assert.deepEqual(loc('The Boys E01 [1080p WEB-DL DUBLADO]'), [[4, 1]]);
    assert.deepEqual(loc('Lanternas 1ª Temporada E03 [1080p DUBLADO]', undefined, 1), [[1, 3]]);
  });

  test('o dn (conteúdo) vence o rótulo nos dois sentidos', () => {
    assert.deepEqual(loc('The Boys E01 [1080p]', 'The.Boys.S04E05.1080p'), [[4, 5]]);
    // "Minhas Aventuras com o Superman 2ª Temporada E01" com dn de temporada COMPLETA.
    assert.deepEqual(loc('The Boys E01 [1080p]', 'The.Boys.S04.COMPLETE.1080p'), [[4, null]]);
  });

  test('botão sem episódio em lugar nenhum é o pack da temporada, nunca a raiz', () => {
    assert.deepEqual(loc('The Boys [1080p DUBLADO 12 GB]'), [[4, null]]);
  });
});
