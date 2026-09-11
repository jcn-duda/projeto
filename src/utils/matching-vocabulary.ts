import { normalizeTitle } from './title-normalization.js';

// Vocabulário fechado de tokens e marcas usados pelo matching de releases. É a
// base que `release-matching.ts` (precisão/estrutura) e os filtros em lote
// compartilham; `audio-quality.ts` e `search-names.ts` consomem partes daqui
// exatamente como consumiam do antigo release-matching — o vocabulário é um só,
// não uma cópia por módulo.

// Palavras que descrevem o EMPACOTAMENTO, não a obra. Um pack legítimo é
// "Coleção Guerra nas Estrelas" ou "Game of Thrones Todas as Temporadas": elas
// não podem contar nem como primeiro token nem contra a precisão.
const PACK_WORDS = new Set(
  'colecao coletanea trilogia saga duologia quadrilogia pentalogia antologia serie series temporada temporadas todas todos completa completo integral filmes collection complete movies films'.split(' '),
);

// Ruído de release: o que todo indexer BR carimba no título e não diz nada
// sobre QUAL obra é. Fora daqui, "Torrent (2019) Legendado WEB DL 720p" faria
// qualquer título parecer distante da busca.
// Ruído TÉCNICO: marca onde o nome da obra acabou e começou a descrição da
// release. `extractSequenceMarkers` usa isto como parada, por isso as palavras
// de ligação ficam à parte — parar em "e" cortaria "Velozes e Furiosos 5"
// antes do número que interessa.
const TECH_NOISE = ('web dl webdl bluray blu ray webrip bdrip brrip hdtv hdrip rip remux hybrid ' +
  'x264 x265 h264 h265 avc hevc av1 xvid divx 10bit 8bit hdr hdr10 dv sdr imax ' +
  'dts aac ac3 eac3 ddp ddp5 ddp2 dd atmos truehd opus mp3 dual audio nacional multi ' +
  'hmax amzn dsnp atvp pcok crav hulu h ' +
  'us uk ca au nz jp tv ' +
  'torrent torrents download baixar assistir online gratis ' +
  'dublado dublada dublagem legendado legendada legenda opcao opcoes versao estendida extendida ' +
  'mkv mp4 avi gb mb kb ' +
  '480p 540p 576p 720p 1080p 1440p 2160p 4k uhd sd hd fullhd').split(' ');

// Ligação: não diz nada sobre a obra e também não marca fim do título.
const LINK_WORDS = 'de do da das dos e a o os as um uma em no na para por com sobre ate'.split(' ');

// A SIGLA do idioma faltava ao lado do nome por extenso, e a falta cortava
// justamente a release que mais interessa: "pt-BR" normaliza para os tokens
// `pt` e `br`, nenhum dos dois era ruído, e os dois contavam como conteúdo
// ESTRANHO na precisão do `matchesBrTitle`. Medido ao vivo (tt0245429): "A
// Viagem de Chihiro (2001) DVDRip MP4 Dublado pt-BR" caía a 0,40 e morria no
// title-filter, enquanto a irmã "Dual Audio" em inglês sobrevivia — a marca
// que PROVA o áudio português era o que derrubava a release. O mesmo título
// sem o "pt-BR" já passava, o que isola a causa nos dois tokens.
//
// `ptbr` entra na mesma linha porque a grafia sem separador normaliza para um
// token só. Nenhum deles pode virar primeiro token significativo por outro
// caminho: `firstSignificantToken` já descarta palavra de até 2 letras.
const LANG_NOISE = ('portugues portuguesa portugueses brasil brasileiro brasileira '
  + 'pt br ptbr').split(' ');

// Marca de copyright: press do encoder ou dominio do tracker no titulo,
// como "derew" ou "www.algo.com". Nao e conteudo e nao deve contar na
// precisao. Sem isto, "Zumbilandia BDRip derew 720p" caia a 0.50 e perdia
// a vaga BR reservada; e o mesmo para "Zumbilandia (www ThePirateFilms.com)".
// A franquia "Atire Duas Vezes" continua sendo outra obra: suas palavras
// seguem medidas fora desta lista.
const WATERMARK_NOISE = new Set(
  'derew www thepiratefilmes'.split(' '),
);

const RELEASE_NOISE = new Set([...TECH_NOISE, ...LINK_WORDS, ...LANG_NOISE, ...WATERMARK_NOISE]);

// O alias do catálogo e o nome publicado pelo indexer podem divergir só no
// artigo inicial ("Hulk" / "The Hulk"). Ignoramos apenas determinantes — não
// todas as palavras de ligação — para "Para Sempre" não virar "Sempre".
const LEADING_ARTICLES = new Set(
  ('o a os as um uma uns umas the an el la los las un una unos unas le les une ' +
    'des il lo gli uno der die das den dem ein eine einen het een').split(' '),
);

const STOP_AT = new Set([...TECH_NOISE, ...PACK_WORDS]);

// Sequência marcada por PALAVRA, não por número. `NUMERAL_CANON` cobre
// "Rocky II" e "Duna Parte Dois", mas a continuação brasileira costuma vir
// batizada: medido ao vivo em tt0468569, "Batman: O Cavaleiro Das Trevas
// RESSURGE 720p Dublado" (que é tt1345836, de 2012) entrava na lista do filme
// de 2008 — cobre todos os tokens da busca, não tem número de sequência, e o
// título da release não traz ano para `yearContradicts` condenar. A precisão
// também não salva: um token estranho num título de quatro significativos dá
// 0,75, acima do piso de 0,65.
//
// A regra é a MESMA dos números em `extractSequenceMarkers`: o marcador só
// condena quando está no candidato e NÃO está na busca. Por isso um filme cujo
// nome já contém a palavra continua passando — "A Origem" procurado traz
// `origem` dos dois lados, e "Batman Begins" procurado traz `begins`.
//
// Lista fechada e curta de propósito: só palavras que, sozinhas, anunciam
// continuação. Nada de "legado", "capitulo" ou "parte" — aparecem em título
// base legítimo com frequência demais, e "parte" já é redundante porque o
// número que a acompanha cai no caminho do NUMERAL_CANON.
const SEQUENCE_WORDS = new Set(
  ('ressurge ressurgimento renasce renascimento recomeco retorno revanche despertar '
    + 'ascensao origens continuacao '
    + 'rises returns reborn rebirth awakens awakening resurrection resurgence revenge '
    + 'begins origins uprising reloaded revolutions').split(' '),
);

// Numeral por extenso/romano → dígito, para "Duna Parte Dois" e "Rocky II"
// casarem com "Duna Parte 2". "i" e "x" ficam de fora de propósito: sozinhos
// são artigo em inglês ("I Am Legend") e marca de resolução/multiplicação,
// não número de sequência.
const NUMERAL_CANON: Record<string, number> = {
  ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9,
  um: 1, dois: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

// Marcador de episódio/temporada ("s01e01", "e07", "1x04", ordinal "1a"):
// estrutura, não conteúdo. Contá-lo como palavra estranha derrubava a precisão
// de release legítima do redetorrent ("S02E01 A Casa do Dragão S02E01 x264
// DUAL", "1A TEMPORADA COMPLETA House of the Dragon S01").
const EPISODE_TOKEN = /^(?:s\d{1,2}(?:e\d{1,3})?|t\d{1,2}(?:e\d{1,3})?|e\d{1,3}|\d{1,2}x\d{1,3}|\d{1,2}a)$/;

// Faixa de anos descreve COLEÇÃO multi-obra: "Todos os filmes 1979-2016".
// Testada no título cru: a normalização transforma o hífen em espaço e
// separaria os dois anos.
//
// O separador aceita hífen/travessão, vírgula, palavra ("de 1979 a 2016") ou
// só espaço: o MESMO pack aparece como "1979-2016" no thepiratebay e
// "1979 2016" no 1337x, e sem isso o mesmo hash era pack num tracker e filme
// comum no outro — com o play caindo no caminho permissivo justamente lá.
const YEAR_RANGE = /\b(?:19|20)\d{2}(?:\s*[-–—,]\s*|\s+(?:de|a|ate|até)\s+|\s+)(?:19|20)\d{2}\b/i;

// Palavras que sozinhas já significam "mais de uma obra". Cobre pt-BR E inglês,
// medido em 2.551 títulos reais: pegam os packs que a faixa de anos não pega,
// com zero falso positivo — "trilogy" tem 30 ocorrências no corpus, todas packs,
// e "quadrilogy" 1, também pack.
//
// Revalidado sobre os 1203 títulos prontos de uma conta real de debrid:
// "filmografia" aparece 1 vez e é pack; "trilogia" 3, todas packs. `saga`
// segue FORA (3 ocorrências, 2 delas filme comum — "The Twilight Saga
// Breaking Dawn Part 1", "[Saga Crepúsculo]") e `completa` segue fraca
// (11 ocorrências, quase todas "Temporada Completa").
const STRONG_PACK_WORDS = new Set(
  'trilogia duologia quadrilogia pentalogia colecao coletanea antologia filmografia filmography trilogy quadrilogy duology tetralogy anthology boxset'.split(' '),
);

/** Tokens normalizados e não vazios de um texto de título. */
function titleTokens(text: string): string[] {
  return normalizeTitle(text).split(' ').filter(Boolean);
}

export {
  PACK_WORDS,
  TECH_NOISE,
  LINK_WORDS,
  LANG_NOISE,
  WATERMARK_NOISE,
  RELEASE_NOISE,
  LEADING_ARTICLES,
  STOP_AT,
  NUMERAL_CANON,
  SEQUENCE_WORDS,
  EPISODE_TOKEN,
  YEAR_RANGE,
  STRONG_PACK_WORDS,
  titleTokens,
};
