// Régua do NOME DA OBRA compartilhada pelo TorrentDosFilmes e pelo
// ComandoTorrents (`work-name.ts`). Cada caso é um `<h1>` REAL da raspagem de
// 2026-09-28 que ia para `no-work` por sobra de vitrine no nome — e os casos
// de guarda são nomes que a régua NÃO pode comer.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanWorkName, h1Text, splitParenYear } from '../src/providers/crawl-sites/work-name.js';
import { workTitleYear as ctWorkTitleYear } from '../src/providers/crawl-sites/comandotorrents-discovery.js';
import { workTitleYear as tdfWorkTitleYear } from '../src/providers/crawl-sites/torrentdosfilmes-discovery.js';

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

describe('work-name: os dois sites usam a MESMA régua', () => {
  test('Comando e TorrentDosFilmes devolvem o mesmo nome para o mesmo `<h1>`', () => {
    const html = h1('Curvas da Vida &#8211; GDRIVE (2012) BluRay 1080p Dual Áudio');
    assert.equal(ctWorkTitleYear(html).title, tdfWorkTitleYear(html).title);
    assert.equal(ctWorkTitleYear(html).year, tdfWorkTitleYear(html).year);
  });
});
