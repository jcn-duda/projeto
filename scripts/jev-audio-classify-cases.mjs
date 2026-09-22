/**
 * Corpus do probe Jev audio-classify (ETAPA 3) — replay mensurável da
 * classificação SÓ DE TÍTULO que já protege o addon: `audioFromTitle` /
 * `looksPtBr` (src/utils/audio-quality.ts). Enquanto o probe dub-lie
 * audita "post × arquivos" (evidência pós-debrid), este audita a MESMA
 * pergunta que a busca faz na hora de reservar vaga BR: o título sozinho
 * anuncia dublagem pt-BR de verdade, ou é uma guarda das que já foram
 * medidas em produção (HINDI, [Ukr Dub], rutracker transliterado,
 * cirílico, ENGLISH) que precisam desmentir o DUB genérico?
 *
 * FORA DO CAMINHO CRÍTICO: nenhum arquivo daqui é importado por `src/`.
 * `expectPtBr` NÃO é "verdade absoluta" — é o veredito ATUAL do código
 * determinístico (`looksPtBr`), extraído rodando a função real sobre cada
 * título (não à mão). O probe mede ACORDO entre o Noul e a regra viva;
 * divergência aqui é candidato a caso não coberto, não prova de bug.
 *
 * Formato do caso:
 *   id          identificador estável (faz parte do fingerprint)
 *   group       família (mesmas famílias do probe dub-lie, quando aplicável)
 *   expectPtBr  veredito atual de looksPtBr(title)
 *   title       título do post (única entrada — sem indexer, sem arquivos)
 * Nenhum caso carrega magnet, hash, config, conta ou credencial.
 */

export const CASES = [
  // ================= HONESTOS: pt-BR genuíno =================
  {
    id: 'ok-dublado-explicit',
    group: 'pt-context',
    expectPtBr: true,
    title: 'Coringa (2019) Dublado 1080p BluRay',
  },
  {
    id: 'ok-dual-audio-br',
    group: 'pt-context',
    expectPtBr: true,
    title: 'Se Beber, Não Case! (2009) 5.1 BluRay Dual Áudio 1080p',
  },
  {
    id: 'ok-ptbr-mark',
    group: 'pt-context',
    expectPtBr: true,
    title: 'Fallout 1ª Temporada (2024) Dual Áudio PT-BR 1080p',
  },
  {
    id: 'ok-generic-dub-bracket',
    group: 'pt-context',
    expectPtBr: true,
    title: 'Some.Movie.2024.[DUB]',
  },
  {
    id: 'ok-web-dl-dublado',
    group: 'pt-context',
    expectPtBr: true,
    title: 'The Bear 3ª Temporada Dublado 720p',
  },
  {
    id: 'ok-1a-temporada-direto',
    group: 'pack',
    expectPtBr: true,
    title: 'Shogun 1ª Temporada (2024) Dublada 1080p',
  },
  {
    id: 'ok-dubbed-nu',
    group: 'pt-context',
    expectPtBr: true,
    title: 'Filme.2024.1080p.WEB-DL.DUBBED.mkv',
  },
  // ========= HONESTOS: sem claim pt-BR (não é dub, não é mentira) =========
  {
    id: 'ok-legendado-honest',
    group: 'legenda',
    expectPtBr: false,
    title: 'Dune Part Two (2024) LEGENDADO 1080p',
  },
  {
    id: 'ok-yts-en-honest',
    group: 'cena-en',
    expectPtBr: false,
    title: 'Oppenheimer 2023 1080p BluRay YTS',
  },
  {
    id: 'ok-rutracker-no-claim',
    group: 'rutracker',
    expectPtBr: false,
    title: 'Brat 2 (2000) 1080p BluRay',
  },
  {
    id: 'ok-cyrillic-no-claim',
    group: 'cirilico-rus',
    expectPtBr: false,
    title: 'Брат (1997) 1080p BluRay',
  },
  {
    id: 'ok-hindi-explicit-no-pt',
    group: 'idioma-nomeado',
    expectPtBr: false,
    title: 'Pathaan (2023) Dual Audio Hindi English 1080p',
  },
  // === GUARDAS: DUB genérico desmentido por idioma/script estrangeiro ===
  // Medido em produção (ver test/audio-cleanup-dub-guards.test.ts para o
  // caso e a fonte de cada medição citada nos comentários originais).
  {
    id: 'guard-hindi-dub',
    group: 'idioma-nomeado',
    expectPtBr: false,
    title: 'HINDI.HQ.DUB',
  },
  {
    id: 'guard-hindi-dubbed',
    group: 'idioma-nomeado',
    expectPtBr: false,
    title: 'HINDI.DUBBED',
  },
  {
    id: 'guard-ukr-dub',
    group: 'idioma-nomeado',
    expectPtBr: false,
    // powermovie.net, 2026-08-30, tt22084616 (ver AGENTS.md/PROJECT.md).
    title: 'Spider-Man: Brand New Day 2026 1080p TELESYNC HEVC [Ukr Dub]',
  },
  {
    id: 'guard-rus-dub',
    group: 'idioma-nomeado',
    expectPtBr: false,
    title: 'Movie 2024 [Rus Dub]',
  },
  {
    id: 'guard-polish-dubbed',
    group: 'idioma-nomeado',
    expectPtBr: false,
    title: 'Movie 2024 POLISH DUBBED',
  },
  {
    id: 'guard-turkish-dub',
    group: 'idioma-nomeado',
    expectPtBr: false,
    title: 'Movie 2024 [Turkish Dub]',
  },
  {
    id: 'guard-rutracker-transliterated',
    group: 'rutracker',
    expectPtBr: false,
    // Medido em produção (2026-09-21, tt0200550 Coyote Ugly, kickasstorrents.to).
    title: 'Coyote Ugly [2000, USA, drama, melodrama, comedy, music, BDRip] Dub',
  },
  {
    id: 'guard-rutracker-zhivov',
    group: 'rutracker',
    expectPtBr: false,
    title: 'Coyote Ugly [2000, USA, drama, melodrama, comedy, music, BDRip] Dub + (Zhivov)',
  },
  {
    id: 'guard-cyrillic-dub',
    group: 'cirilico-rus',
    expectPtBr: false,
    // Medido pelo /stream-trace.json ao vivo (2026-09-01).
    title: 'Во все тяжкие / Breaking Bad / … [BDRip 720p] [DUB] [Selena/Телеканал Че]',
  },
  {
    id: 'guard-english-dubbed',
    group: 'cena-en',
    expectPtBr: false,
    // Medido ao vivo (2026-09-02, tt0245429).
    title: '[TorrentCounter.to].Spirited.Away.2001.English.Dubbed.1080p.BluRay.x264.[1.8GB].mp4',
  },
  {
    id: 'guard-english-dub-anime',
    group: 'cena-en',
    expectPtBr: false,
    title: 'Some.Anime.English.Dub.1080p',
  },
  {
    id: 'guard-eng-dubbed',
    group: 'cena-en',
    expectPtBr: false,
    title: 'Some.Anime.ENG.DUBBED.720p',
  },
  {
    id: 'guard-eng-dub',
    group: 'cena-en',
    expectPtBr: false,
    title: 'Movie.2024.Eng.Dub.1080p',
  },
  // ==== GUARDAS: PT explícito ao lado do idioma estrangeiro VENCE ====
  {
    id: 'guard-ukr-dub-with-dublado',
    group: 'idioma-nomeado',
    expectPtBr: true,
    title: 'Movie 2024 [Ukr Dub] DUBLADO',
  },
  {
    id: 'guard-hindi-dub-with-ptbr',
    group: 'idioma-nomeado',
    expectPtBr: true,
    title: 'HINDI.HQ.DUB PT-BR',
  },
  {
    id: 'guard-rutracker-with-dublado',
    group: 'rutracker',
    expectPtBr: true,
    title: 'Coyote Ugly [2000, USA, drama, melodrama, comedy, music, BDRip] Dub DUBLADO',
  },
  {
    id: 'guard-cyrillic-with-dublado',
    group: 'cirilico-rus',
    expectPtBr: true,
    title: 'Во все тяжкие … [DUB] [Телеканал Че] DUBLADO',
  },
  {
    id: 'guard-english-with-dublado',
    group: 'cena-en',
    expectPtBr: true,
    title: 'Spirited Away 2001 English Dub DUBLADO 1080p',
  },
];
