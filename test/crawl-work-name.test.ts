// Régua do NOME DA OBRA compartilhada pelo TorrentDosFilmes e pelo
// ComandoTorrents (`work-name.ts`). Cada caso é um `<h1>` REAL da raspagem de
// 2026-09-28 que ia para `no-work` por sobra de vitrine no nome — e os casos
// de guarda são nomes que a régua NÃO pode comer.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanWorkName, fichaYear, h1Text, readWorkTitle, splitParenYear } from '../src/providers/crawl-sites/work-name.js';
import { normalizeTitle } from '../src/utils/title-normalization.js';
import { workTitleYear as ctWorkTitleYear } from '../src/providers/crawl-sites/comandotorrents-discovery.js';
import { workTitleYear as tdfWorkTitleYear } from '../src/providers/crawl-sites/torrentdosfilmes-discovery.js';
import { pageSeasonOf, seasonPageGroups, seriesRowGroups } from '../src/providers/crawl-sites/season-page.js';

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
    // Ordinal com o sinal de GRAU: o "9°" ficava no nome e o TMDB não achava.
    ['The Big Bang Theory 9° Temporada Torrent (2015) HDTV Legendado', 'The Big Bang Theory', 2015],
  ];
  for (const [raw, title, year] of cases) {
    test(`"${raw}" → "${title}"`, () => {
      assert.deepEqual(nameOf(raw), { title, year });
    });
  }
});

describe('work-name: o que a régua NÃO pode comer', () => {
  test('"Temporada" sem ordinal é nome de filme; só sai como "Temporada Completa"', () => {
    // "Temporada de Caça" (2006) virava "de Caça" e ficava sem obra.
    assert.equal(nameOf('Temporada de Caça (2006) Dublado').title, 'Temporada de Caça');
    assert.equal(nameOf('Temporada de Caça 2 (2008) Dublado').title, 'Temporada de Caça 2');
    assert.equal(nameOf('Temporada de Patos (2004) Legendado').title, 'Temporada de Patos');
    // Com ordinal, ou como "Completa"/"Todas as", continua saindo inteiro.
    assert.equal(nameOf('Pit Stop Temporada Completa (2021)').title, 'Pit Stop');
    assert.equal(nameOf('The Office Todas as Temporadas Completas').title, 'The Office');
    assert.equal(nameOf('O Caçador 1ª Temporada Completa Mini Série (2014) Dublado').title, 'O Caçador');
  });

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

describe('work-name: a lista de ordinais do post que AGREGA temporadas', () => {
  // Recortes reais de 2026-09-29 (RedeTorrent, `/series/`): o post lista as
  // temporadas todas no `<h1>` e a régua anterior apagava UM ordinal, deixando a
  // lista no nome — que o TMDB não resolve. Com a lista inteira fora, a página
  // identifica a série e é essa identificação que faz a página entrar no motor.
  const cases: Array<[string, string, number | null]> = [
    ['Superman &amp; Lois 1ª e 2ª Temporada Torrent (2021)', 'Superman & Lois', 2021],
    ['Carmen Sandiego 1ª 2ª 3ª 4ª Temporada (2019)', 'Carmen Sandiego', 2019],
    ['The Sinner 1ª, 2ª e 3ª Temporada (2017)', 'The Sinner', 2017],
    ['Community (2009) 1ª 2ª 3ª 4ª 5ª 6ª Temporada', 'Community', 2009],
    // O hífen do "Nine-Nine" é separador órfão há muito (regra antiga, fora do
    // escopo aqui): a lista de ordinais é o que este caso fixa, e o
    // `normalizeTitle` da identificação reduz "Nine-Nine" e "Nine Nine" ao
    // mesmo token, então a busca no TMDB não muda.
    ['Brooklyn Nine-Nine 1ª 2ª 3ª 4ª 5ª 6ª 7ª 8ª Temporada (2013)', 'Brooklyn Nine Nine', 2013],
    ['Seven 1ª 2ª 3ª Temporada Completa (1995)', 'Seven', 1995],
    // `°` (sinal de grau) e a forma sem ordinal não podem regredir.
    ['Gravity Falls 7° Temporada (2012)', 'Gravity Falls', 2012],
    ['Lanternas Verdes 1ª Temporada (2021)', 'Lanternas Verdes', 2021],
    // FAIXA, e não lista: é como a página que publica a série INTEIRA escreve
    // (medido ao vivo em 2026-09-29). Sem a faixa, sobrava "1ª à" no nome e o
    // TMDB devolvia zero para "The Walking Dead" e "Os Simpsons".
    ['The Walking Dead 1ª à 11ª Temporada (2021)', 'The Walking Dead', 2021],
    ['Os Simpsons 1ª à 33ª Temporada (2021)', 'Os Simpsons', 2021],
    ['Vikings 1ª a 6ª Temporada (2013)', 'Vikings', 2013],
    // Número que é do NOME e não da lista: "85" é a referência do episódio,
    // "007" é o nome do agente.
    ['Stranger Things: Histórias de 85 1ª e 2ª Temporada (2026)', 'Stranger Things: Histórias de 85', 2026],
    ['Agente 007 1ª Temporada (2015)', 'Agente 007', 2015],
  ];
  for (const [raw, title, year] of cases) {
    test(`"${raw}" → "${title}"`, () => {
      assert.deepEqual(nameOf(raw), { title, year });
    });
  }

  test('o "&" é nome de obra, não conector de vitrine — e a borda ainda limpa o órfão', () => {
    assert.equal(nameOf('Batman &amp; Robin 1080p Dublado').title, 'Batman & Robin');
    assert.equal(nameOf('Fast &amp; Furious 7 Múltiplos Torrent (2015) BluRay 1080p Dual Áudio').title, 'Fast & Furious 7 Múltiplos');
    // O "&" que É resíduo de vitrine continua saindo pela borda.
    assert.equal(nameOf('Plano de fuga Dublado &amp; Legendado 1080p').title, 'Plano de fuga');
    assert.equal(nameOf('Filme Qualquer 720p &amp; 1080p Dublado').title, 'Filme Qualquer');
    // E a busca no TMDB não muda: `normalizeTitle` reduz "&" e espaço ao mesmo token.
    assert.equal(normalizeTitle('Fast & Furious'), normalizeTitle('Fast Furious'));
  });

  test('a borda com um separador ÚNICO cercado de espaço continua limpa (o "+" do grupo)', () => {
    // O `+` no grupo de repetição do `ORPHAN_SEP_RE` foi corrigido justamente
    // para esta forma, que é a DOMINANTE do site: mexer na classe não pode
    // ressuscitar o "– Rip" nem o "/ FULL" no nome.
    assert.equal(nameOf('Deadpool – Rip').title, 'Deadpool');
    assert.equal(nameOf('Noturno / FULL').title, 'Noturno');
    assert.equal(nameOf('Introspectum Motel e').title, 'Introspectum Motel', 'conector final');
    assert.equal(nameOf('Deuses e Monstros').title, 'Deuses e Monstros', '"e" no meio nunca é tocado');
    // O `:` é separador de NOME e segue FORA de propósito.
    assert.equal(nameOf('Sea Rex 3D: Journey to a Prehistoric World').title, 'Sea Rex 3D: Journey to a Prehistoric World');
    assert.equal(nameOf('Chainsaw Man – O Filme: Arco da Reze').title, 'Chainsaw Man O Filme: Arco da Reze');
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

// Página que AGREGA temporadas (RedeTorrent): a locação sai da LINHA, e o
// `releaseWorkTargets` NÃO participa — o título da release carrega a lista de
// ordinais do `<h1>` (o profile a copia do post cru) e ele leria isso como
// "série multi-temporada", empurrando as linhas para a raiz.
describe('season-page: série que AGREGA temporadas (sérieRowGroups)', () => {
  const mk = (dn: string, h = 'a') => ({
    title: 'Superman & Lois 1ª e 2ª Temporada',
    magnet: `magnet:?xt=urn:btih:${h.repeat(40)}${dn ? `&dn=${encodeURIComponent(dn)}` : ''}`,
    indexer: 'x', tracker: 'X', isBr: true, seeders: 1,
  });
  const at = (rows: Array<{ release: ReturnType<typeof mk>; rowSeason: number | null }>) =>
    seriesRowGroups(rows).map((g) => [g.season, g.episode, g.releases.length]);

  test('pack da S1 e episódios da S2 na mesma página, sem cair na raiz', () => {
    const rows = [
      { release: mk('Superman.and.Lois.S01.COMPLETE.1080p'), rowSeason: 1 },
      ...Array.from({ length: 8 }, (_, i) => ({
        release: mk(`Superman.and.Lois.S02E0${i + 1}.1080p`, String(i + 1)),
        rowSeason: null,
      })),
    ];
    const groups = at(rows);
    assert.equal(groups[0][0], 1);
    assert.equal(groups[0][1], null, 'o pack da S1 é chave de TEMPORADA');
    assert.deepEqual(groups.slice(1), Array.from({ length: 8 }, (_, i) => [2, i + 1, 1]));
    assert.ok(!groups.some(([s]) => s == null), 'nada na raiz');
  });

  test('linha sem dn e sem S0N é DESCARTADA (a raiz é palpite, não leitura)', () => {
    assert.deepEqual(
      at([
        { release: mk('Community.S01.COMPLETE.1080p'), rowSeason: null },
        { release: mk('Qualquer.Coisa.1080p', 'b'), rowSeason: null },
        { release: mk('Community.S03E02.1080p', 'c'), rowSeason: null },
      ]),
      [[1, null, 1], [3, 2, 1]],
    );
  });

  test('a coluna S0N é a reserva do dn silencioso, e o dn vence quando contradiz', () => {
    assert.deepEqual(at([{ release: mk('', 'a'), rowSeason: 4 }]), [[4, null, 1]]);
    assert.deepEqual(
      at([{ release: mk('The.Sinner.S03E05.1080p', 'b'), rowSeason: 1 }]),
      [[3, 5, 1]],
      'conteúdo (dn) acima de página (coluna do post)',
    );
  });

  test('uma linha por grupo, na ordem Determinística (temporada, depois episódio)', () => {
    // O `groupSeriesReleases` ordena por especificidade e a raiz por último; o
    // mesmo hash pode aparecer em dois grupos sem duplicar no acervo, porque o
    // índice faz merge por hash e o banco dedupe por hash.
    assert.deepEqual(
      at([
        { release: mk('Show.S02.1080p', 'b'), rowSeason: 2 },
        { release: mk('Show.S01.1080p'), rowSeason: 1 },
      ]),
      [[1, null, 1], [2, null, 1]],
    );
  });
});
