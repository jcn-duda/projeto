/**
 * Corpus do probe Jev dub-lie (ETAPA 2) — replay mensurável da hipótese
 * "post prometeu dublado BR × arquivos entregam outra coisa".
 *
 * FORA DO CAMINHO CRÍTICO: nenhum arquivo daqui é importado por `src/`.
 * O corpus é ASSIMÉTRICO de propósito, com viés honesto (~58% honest /
 * ~42% lie): na produção o post mentiroso é minoria, e o erro CARO do
 * veredito é o falso positivo — denunciar post honesto rebaixa release
 * boa (o mesmo princípio do banco de magnets: falso negativo de
 * condenação é o pior caso). Os pares gêmeos (lie-promo-only ×
 * ok-promo-with-real-dub, lie-crow-wrong-year × ok-corvo-1994-certo)
 * separam o sinal do ruído dentro da MESMA família.
 *
 * Formato do caso — EXATAMENTE o que o audit do Adom vê no play:
 *   id         identificador estável (faz parte do fingerprint)
 *   group      família discriminada (matrix por família no relatório)
 *   expectLie  ground truth: true = post mente o áudio; false = honesto
 *   post       título do post (a promessa)
 *   indexer    indexador de origem
 *   files      nomes/paths reais listados pelo debrid (a evidência)
 * Nenhum caso carrega magnet, hash, config, conta ou credencial — o
 * payload é allowlist (ver jev-dub-lie-payload.mjs).
 */

export const CASES = [
  // ============ LIES — casos reais documentados (AGENTS.md + e2e) ============
  {
    id: 'lie-td-rarbg',
    group: 'cena-en',
    expectLie: true,
    post: 'True Detective 4ª Temporada (2024) DUBLADO 1080p',
    indexer: 'nerdfilmes',
    files: ['True.Detective.S03E04.1080p.WEBRip.x264.DD5.1-RARBG.mkv'],
  },
  {
    id: 'lie-td-killers',
    group: 'cena-en',
    expectLie: true,
    post: 'True Detective 4ª Temporada Completa Dublado Dual Áudio',
    indexer: 'comandotorrents',
    files: ['True.Detective.S03E01.1080p.BluRay.x264-KILLERS.mkv'],
  },
  {
    id: 'lie-td-afm72',
    group: 'cena-en',
    expectLie: true,
    post: '[WWW.BLUDV.TV] True Detective 4ª Temporada DUBLADO',
    indexer: 'bludv',
    files: ['True.Detective.2014.S03E06.720p.HDTV.x264-afm72.mkv'],
  },
  {
    id: 'lie-td-tovar',
    group: 'cena-en',
    expectLie: true,
    post: 'True Detective S04 Dublado 1080p WEB-DL',
    indexer: 'redetorrent-cardigann',
    files: ['True.Detective.S03E03.1080p.WEB.h264-ToVaR.mkv'],
  },
  {
    id: 'lie-metcon',
    group: 'cena-en',
    expectLie: true,
    // Claim EXPLÍCITO de áudio: o " BR" solto do protótipo era ambíguo
    // (podia ser região/lote, não promessa de dublagem).
    post: 'True Detective S03E03 Dublado 1080p WEB-DL',
    indexer: 'redetorrent-cardigann',
    files: ['True.Detective.S03E03.1080p.WEB.H264-METCON.mkv'],
  },
  {
    id: 'lie-crow-wrong-year',
    group: 'ano',
    expectLie: true,
    post: 'O Corvo (2024) Dublado Dual Áudio 1080p',
    indexer: 'hdrtorrent-cardigann',
    files: ['The.Crow.1994.1080p.BluRay.x264.DTS-FGT.mkv'],
  },
  {
    id: 'lie-yify-under-br-post',
    group: 'cena-en',
    expectLie: true,
    post: 'Fallout 1ª Temporada Dublada e Dual 1080p',
    indexer: 'nerdfilmes',
    files: ['Fallout.S01E01.1080p.WEB.h264-ETHEL.mkv', 'Fallout.S01E02.1080p.WEB.h264-ETHEL.mkv'],
  },
  {
    id: 'lie-promo-only',
    group: 'promo',
    expectLie: true,
    post: 'House of the Dragon S01E01 DUBLADO 1080p',
    indexer: 'comandotorrents',
    files: [
      'House.of.the.Dragon.S01E01.1080p.FULL.WEB-DL.DUAL.5.1/1XBET.COM_promo_SHREK.mp4',
      'House.of.the.Dragon.S01E01.1080p.FULL.WEB-DL.x264-FLUX.mkv',
    ],
  },
  {
    id: 'lie-english-scene-pack',
    group: 'pack',
    expectLie: true,
    post: 'Goliath 3ª Temporada Completa Dublado',
    indexer: 'torrentdosfilmesv2',
    files: ['Goliath.S02E01.1080p.WEB.x264-ION10.mkv'],
  },
  {
    id: 'lie-sparks',
    group: 'cena-en',
    expectLie: true,
    post: 'Oppenheimer (2023) Dublado 2160p',
    indexer: 'vacatorrent',
    files: ['Oppenheimer.2023.2160p.MA.WEB-DL.DDP5.1.Atmos.H265-SPARKS.mkv'],
  },
  // ==== LIES — famílias ambíguas novas (idioma nomeado, rus, legenda) ====
  {
    id: 'lie-dual-hindi',
    group: 'idioma-nomeado',
    expectLie: true,
    post: 'Projeto Gemini (2019) Dual Áudio Dublado 1080p',
    indexer: 'comandotorrents',
    files: ['Gemini.Man.2019.1080p.WEB-DL.Hindi.English.DD5.1.x264.mkv'],
  },
  {
    id: 'lie-dual-tamil',
    group: 'idioma-nomeado',
    expectLie: true,
    post: 'Vikram (2022) Dual Áudio Dublado 1080p BluRay',
    indexer: 'bludv',
    files: ['Vikram.2022.Tamil.1080p.WEB-DL.AAC2.0.H.264-Telly.mkv'],
  },
  {
    id: 'lie-rutracker-dub-claim',
    group: 'cirilico-rus',
    expectLie: true,
    post: 'Supernatural 1ª Temporada Dublado 1080p',
    indexer: 'rutor',
    files: ['Supernatural.S01.1080p.WEB-DL.Rus.Eng.x264-HDRezka.mkv'],
  },
  {
    id: 'lie-cyrillic-files',
    group: 'cirilico-rus',
    expectLie: true,
    post: 'Interestelar (2014) Dublado 1080p',
    indexer: 'rutor',
    files: ['Интерстеллар.2014.1080p.BluRay.x264.Rus.mkv'],
  },
  {
    id: 'lie-multi-french-claim',
    group: 'idioma-nomeado',
    expectLie: true,
    post: 'Titanic (1997) Dublado Dual Áudio 1080p BluRay',
    indexer: 'nerdfilmes',
    files: ['Titanic.1997.MULTI.VFF.1080p.BluRay.x264-ZONE.mkv'],
  },
  {
    id: 'lie-legenda-not-dub',
    group: 'legenda',
    expectLie: true,
    post: 'Duna Parte Dois (2024) Dublado 1080p',
    indexer: 'comandotorrents',
    files: ['Dune.Part.Two.2024.1080p.WEB-DL.x264-ETREL.mkv', 'Dune.Part.Two.2024.1080p.WEB-DL.pt-BR.srt'],
  },

  // =================== HONESTOS — includes os gêmeos ===================
  {
    id: 'ok-dual-audio-br',
    group: 'pt-context',
    expectLie: false,
    post: 'Trilogia - Se Beber, Não Case! (2009-2013) 5.1 BluRay Dual Áudio 1080p',
    indexer: 'bludv',
    files: ['Se.Beber.Nao.Case.1.2009.1080p.BluRay.Dual.Audio.BR.mkv'],
  },
  {
    id: 'ok-dublado-explicit',
    group: 'pt-context',
    expectLie: false,
    post: 'Coringa (2019) Dublado 1080p BluRay',
    indexer: 'nerdfilmes',
    files: ['Coringa.2019.1080p.BluRay.Dublado.BR.mkv'],
  },
  {
    id: 'ok-ptbr-mark',
    group: 'pt-context',
    expectLie: false,
    post: 'Fallout 1ª Temporada (2024) Dual Áudio 1080p',
    indexer: 'comandotorrents',
    files: ['Fallout.S01E01.1080p.WEB-DL.Dual.Audio.PT-BR.mkv'],
  },
  {
    id: 'ok-nacional',
    group: 'pt-context',
    expectLie: false,
    post: 'Cidade de Deus (2002) Dual Áudio 1080p',
    indexer: 'bludv',
    files: ['Cidade.de.Deus.2002.1080p.BluRay.Dual.Audio.mkv'],
  },
  {
    id: 'ok-legendado-honest',
    group: 'legenda',
    expectLie: false,
    post: 'Dune Part Two (2024) LEGENDADO 1080p',
    indexer: 'thepiratebay',
    files: ['Dune.Part.Two.2024.1080p.WEB.h264-ETHEL.mkv'],
  },
  {
    id: 'ok-yts-en-honest',
    group: 'cena-en',
    expectLie: false,
    post: 'Oppenheimer 2023 1080p BluRay YTS',
    indexer: 'yts',
    files: ['Oppenheimer.2023.1080p.BluRay.x264.YTS.mkv'],
  },
  {
    id: 'ok-dual-5.1-br',
    group: 'pt-context',
    expectLie: false,
    post: 'House of the Dragon 1ª Temporada Dual 5.1 1080p',
    indexer: 'comandotorrents',
    files: ['House.of.the.Dragon.S01E01.1080p.WEB-DL.DUAL.5.1.BR.mkv'],
  },
  {
    id: 'ok-web-dl-dublado',
    group: 'pt-context',
    expectLie: false,
    post: 'The Bear 3ª Temporada Dublado 720p',
    indexer: 'redetorrent-cardigann',
    files: ['The.Bear.S03E01.720p.WEB-DL.Dublado.mkv'],
  },
  {
    id: 'ok-pack-same-season',
    group: 'pack',
    expectLie: false,
    post: 'Fallout 1ª Temporada Completa Dual Áudio 1080p',
    indexer: 'nerdfilmes',
    files: [
      'Fallout.S01E01.1080p.WEB-DL.Dual.Audio.mkv',
      'Fallout.S01E02.1080p.WEB-DL.Dual.Audio.mkv',
    ],
  },
  {
    id: 'ok-pt-title-dual',
    group: 'pt-context',
    expectLie: false,
    post: 'Lanternas Verdes (2011) Dual Áudio 1080p',
    indexer: 'hdrtorrent-cardigann',
    files: ['Lanternas.Verdes.2011.1080p.BluRay.Dual.Audio.mkv'],
  },
  // ==== HONESTOS — ambíguos novos: sem promessa PT, nunca é mentira ====
  {
    id: 'ok-rutracker-no-claim',
    group: 'cirilico-rus',
    expectLie: false,
    post: 'Brat 2 (2000) 1080p BluRay',
    indexer: 'rutor',
    files: ['Brat.2.2000.1080p.BluRay.x264.Rus.mkv'],
  },
  {
    id: 'ok-cyrillic-no-claim',
    group: 'cirilico-rus',
    expectLie: false,
    post: 'Брат (1997) 1080p BluRay',
    indexer: 'rutor',
    files: ['Брат.1997.1080p.BluRay.x264.mkv'],
  },
  {
    id: 'ok-hindi-explicit-no-pt',
    group: 'idioma-nomeado',
    expectLie: false,
    post: 'Pathaan (2023) Dual Audio Hindi English 1080p',
    indexer: 'thepiratebay',
    files: ['Pathaan.2023.1080p.WEB-DL.Hindi.English.DD5.1.x264.mkv'],
  },
  {
    id: 'ok-tamil-explicit-no-pt',
    group: 'idioma-nomeado',
    expectLie: false,
    post: 'Jailer (2023) Tamil Dual Audio 1080p WEB-DL',
    indexer: 'thepiratebay',
    files: ['Jailer.2023.Tamil.1080p.WEB-DL.AAC.5.1.x264.mkv'],
  },
  {
    id: 'ok-multi-french-no-pt',
    group: 'idioma-nomeado',
    expectLie: false,
    post: 'Le Samouraï (1967) MULTI 1080p BluRay',
    indexer: 'thepiratebay',
    files: ['Le.Samourai.1967.MULTI.VF.1080p.BluRay.x264.mkv'],
  },
  // ==== HONESTOS — gêmeos dos lies + marcas PT em nome hostil ====
  {
    id: 'ok-promo-with-real-dub',
    group: 'promo',
    expectLie: false,
    post: 'House of the Dragon S01E01 DUBLADO 1080p',
    indexer: 'comandotorrents',
    files: [
      'House.of.the.Dragon.S01E01.1080p.FULL.WEB-DL.DUAL.5.1/1XBET.COM_promo_SHREK.mp4',
      'House.of.the.Dragon.S01E01.1080p.FULL.WEB-DL.DUAL.5.1/House.of.the.Dragon.S01E01.DUAL.5.1.mkv',
    ],
  },
  {
    id: 'ok-legenda-sub-plus-dub-file',
    group: 'legenda',
    expectLie: false,
    post: 'The Last of Us 1ª Temporada Dublado 1080p',
    indexer: 'nerdfilmes',
    files: ['The.Last.of.Us.S01E01.1080p.WEB-DL.x264-ETHEL.DUBLADO.PT-BR.mkv'],
  },
  {
    id: 'ok-pack-plural-temporadas',
    group: 'pack',
    expectLie: false,
    post: 'Vikings 1ª 2ª 3ª Temporadas Dubladas 1080p',
    indexer: 'comandotorrents',
    files: [
      'Vikings.S01E01.1080p.WEB-DL.Dual.Audio.mkv',
      'Vikings.S02E01.1080p.WEB-DL.Dual.Audio.mkv',
      'Vikings.S03E01.1080p.WEB-DL.Dual.Audio.mkv',
    ],
  },
  {
    id: 'ok-1a-temporada-direto',
    group: 'pack',
    expectLie: false,
    post: 'Shogun 1ª Temporada (2024) Dublada 1080p',
    indexer: 'nerdfilmes',
    files: ['Shogun.S01E01.1080p.WEB-DL.DUBLADO.mkv'],
  },
  {
    id: 'ok-corvo-1994-certo',
    group: 'ano',
    expectLie: false,
    post: 'O Corvo (1994) Dublado Dual Áudio 1080p',
    indexer: 'hdrtorrent-cardigann',
    files: ['The.Crow.1994.1080p.BluRay.Dual.Audio.mkv'],
  },
  {
    id: 'ok-pttitle-dual-plain',
    group: 'pt-context',
    expectLie: false,
    post: 'Um Sonho de Liberdade (1994) DUAL 1080p',
    indexer: 'hdrtorrent-cardigann',
    files: ['The.Shawshank.Redemption.1994.1080p.BluRay.DUAL.mkv'],
  },
  {
    id: 'ok-rargb-com-dublado',
    group: 'cena-en',
    expectLie: false,
    post: 'Matrix (1999) Dublado 1080p BluRay',
    indexer: 'bludv',
    files: ['Matrix.1999.1080p.BluRay.x264.DUBLADO.PT-BR-RARBG.mkv'],
  },
];
