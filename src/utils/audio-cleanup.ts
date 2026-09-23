/**
 * audio-cleanup.ts — guardas da promessa GENÉRICA de dublagem e o caminho do
 * path real de arquivo (extraído de audio-quality.ts no split do teto de 400):
 *
 * - `FOREIGN_DUB_LANG_RE` / `CYRILLIC_RE` / `RUTRACKER_TRANSLIT_RE` /
 *   `genericDubProvesPt` — só derrubam a prova GENÉRICA (`DUB`/`DUBBED`);
 *   marca PT explícita continua absolvendo pelas regras próprias dos
 *   chamadores, fora deste predicado;
 * - `namesForeignDubLanguage` — guarda AMPLA usada onde a decisão SÓ nega a
 *   vaga BR (herança no dedupe + classificação pt-title-dual). Pode ser
 *   generosa porque não apaga da conta; `hasExplicitForeignAudio` permanece
 *   a lista MÍNIMA dos caminhos destrutivos (sweep/limpeza);
 * - `foreignLangNamedForBucket` — o MESMO núcleo da ampla, sem o token `MULTI`:
 *   nomeia um idioma que não é o português. É o predicado que rebaixa
 *   Dual+idioma estrangeiro no balde do catálogo;
 * - `hasPtAudioMark` / `strongEnSceneMark` / `dubbedLieVerdict` — a auditoria
 *   de dublagem sobre o path real dos arquivos.
 *
 * Deliberadamente NÃO mora aqui `hasExplicitForeignAudio` nem `foreignVerdict`
 * (ficam em audio-quality.ts): são os lados que CONDENAM e apagam da conta, e
 * a assimetria entre guarda (generosa: só deixa de absolver / negar BR) e
 * condenação (mínima: destrói) é travada por test/audio-cleanup-classifiers.test.ts.
 */
import config from '../config.js';
import { normalizeTitle } from './title-normalization.js';

/**
 * Idiomas que desmentem a promessa GENÉRICA de dublagem. `[Ukr Dub]`,
 * `HINDI.HQ.DUB` e `Rus Dubbed` dizem dublado PARA aquele idioma — nenhum
 * deles é pt-BR, e o `\bDUB\b` sozinho não sabe distinguir.
 *
 * HINDI foi o primeiro caso medido; a construção `<idioma> Dub` é a mesma para
 * todos, então a lista generaliza o predicado em vez de caçar um idioma por
 * vez. Medido em produção (2026-08-30, `tt22084616`): as TRÊS primeiras vagas
 * eram `Spider-Man: Brand New Day 2026 … [Ukr Dub]` rotuladas DUB BR, ocupando
 * as três vagas reservadas de BR — quem clicava no topo ouvia ucraniano.
 *
 * Presença em qualquer posição basta, como já valia para HINDI: exigir
 * adjacência ao DUB deixaria passar `Ukr HQ Dub`. O custo é um título que
 * LISTA faixas (`Multi DUB Eng/Rus/Por`) perder a prova genérica — mas marca
 * PT explícita ao lado continua absolvendo pelas OUTRAS alternativas de
 * explicitPtAudio, que correm fora deste predicado.
 *
 * Só formas inequívocas entram: `POLISH` sim, `POL` não — token de três letras
 * casa dentro de nome de grupo e condenaria release BR por acidente. `ENG` de
 * três letras é a EXCEÇÃO medida (2026-09-02): `English Dubbed` em anime sai
 * como a dublagem EN dominante e ocupava vaga reservada BR (Spirited Away no
 * tt0245429); `\bENG\b` não casa dentro de nome de grupo (`-ENGiNE`,
 * `x264-ENG0` não batem na fronteira) e `Eng Dub` é a grafia que o padrão de
 * anime usa.
 */
const FOREIGN_DUB_LANG_RE = new RegExp(
  '\\b(HINDI|TAMIL|TELUGU|MALAYALAM|KANNADA|BENGALI|PUNJABI|MARATHI'
  + '|UKR|UKRAINIAN|RUS|RUSSIAN|POLISH|CZECH|SLOVAK|HUNGARIAN|ROMANIAN|BULGARIAN'
  + '|GREEK|HEBREW|ARABIC|PERSIAN|TURKISH|THAI|VIETNAMESE'
  + '|KOREAN|JAPANESE|CHINESE|MANDARIN|CANTONESE'
  + '|GERMAN|FRENCH|TRUEFRENCH|ITALIAN|ITA|SPANISH|ESPANOL|CASTELLANO|LATINO'
  + '|DUTCH|SWEDISH|NORWEGIAN|DANISH|FINNISH|ENGLISH|ENG)\\b',
);

/**
 * O SCRIPT cirílico desmente a promessa GENÉRICA de dublagem DUB/DUBBED
 * exatamente como o nome de idioma acima desmente: `[DUB]` num título
 * escrito em russo/ucraniano/bielorrusso é dublagem daquele idioma, não
 * pt-BR. Medido pelo /stream-trace.json ao vivo (2026-09-01): 826 títulos
 * únicos no índice, 50 com cirílico, 11 classificados looksPtBr=true +
 * audio='Dublado' via DUB genérico — todos disputavam vaga reservada de BR
 * anunciando dublagem pt-BR ('Во все тяжкие / Breaking Bad / … [BDRip 720p]
 * [DUB] [Selena/Телеканал Че]'; Телеканал Че é canal russo). É a mesma classe
 * do conserto HINDI (streams:v7): lá `DUB` genérico exigiu ausência de HINDI;
 * aqui exige ausência de cirílico. Por SCRIPT em vez de nome de idioma: cobre
 * qualquer idioma escrito em cirílico sem caçar token um por um — a faixa
 * `а-я` + `ё` cobre o russo, e `і ї є ґ ў` cobre as variantes ucraniana e
 * bielorrussa fora da faixa.
 *
 * Só derruba a prova GENÉRICA: marca PT explícita ao lado ('PT-BR',
 * 'DUBLADO') continua vencendo pelas regras próprias dos chamadores — release
 * BR pode citar canal/fonte em cirílico. E o cirílico NÃO entra em
 * hasExplicitForeignAudio: script não é prova positiva de idioma (não
 * condena; no foreignVerdict o título cirílico sem marca nenhuma fica
 * 'unknown'), este conserto é só de ranking/promessa de dublagem.
 */
const CYRILLIC_RE = /[а-яёіїєґў]/i;

/**
 * Assinaturas do rutracker transliteradas em ASCII — sem cirílico e sem
 * nome de idioma, então FOREIGN_DUB_LANG_RE / CYRILLIC_RE não pegam.
 * Medido em produção (2026-09-21, tt0200550 Coyote Ugly, kickasstorrents.to):
 * as 4 primeiras vagas (reserva BR) eram `DUB BR · kickass` com títulos
 * `Coyote Ugly [2000, USA, drama, …, BDRip] Dub + (Zhivov)` — "Dub" ali é
 * Дублированный russo. Duas formas inequívocas: o bloco de metadados
 * `[AAAA, País, gêneros…, Fonte]` (ano + vírgula + palavra dentro do
 * colchete; release BR/cena não usa essa forma) e os tipos de tradução
 * russa AVO/MVO/DVO/SVO (voice-over autoral/multi/duplo/simples). Só
 * derruba a prova GENÉRICA; DUBLADO/PT-BR explícito ao lado continua
 * vencendo nos chamadores. NÃO entra em hasExplicitForeignAudio (lista
 * mínima que condena/apaga — assimetria travada).
 *
 * O bloco também admite FAIXA de anos (`[1999-2003, …]`, `[1999 - 2003, …]`,
 * `[1979–1997, …]`), que a primeira versão da regex deixava escapar: medido no
 * corpus do container (2026-09-22, cache.db, raw:v1 × idx:v10) — `The Matrix:
 * Trilogy [1999-2003, USA, sci-fi, …, WEBRip] [Open Matte] Dub` chegava como
 * `DUB BR · kickass` e ocupava vaga reservada. A faixa é OPCIONAL após o ano e
 * aceita hífen, en-dash e em-dash (com ou sem espaços). O site BR NÃO usa essa
 * forma: escreve `(2009-2013)` ENTRE PARÊNTESES, sem vírgula + palavra depois —
 * dos 9.119 títulos únicos do corpus, só 1 mudou de classificação e nenhum era
 * de site BR. `magnets.db` guarda `is_br` OR-aderente e sem versão, então o
 * rótulo antigo persiste lá (só pesa no fallback do acervo).
 */
const RUTRACKER_TRANSLIT_RE = /\[\s*(?:19|20)\d{2}(?:\s*[-–—]\s*(?:19|20)\d{2})?\s*,\s*[A-Z]|\b(?:AVO|MVO|DVO|SVO)\b/i;

/**
 * Guarda compartilhada da dublagem GENÉRICA (título e path usam o mesmo
 * intento). Marcador genérico de DUB/DUBBED NÃO prova áudio PT quando o
 * texto nomeia um idioma estrangeiro, está escrito em cirílico ou carrega
 * assinatura transliterada do rutracker. O PT explícito ao lado
 * (`HINDI… DUB PT-BR`, `Во все тяжкие … [DUB] PT-BR`) continua vencendo
 * FORA deste predicado, nas regras próprias de cada chamador.
 */
function genericDubProvesPt(text: string): boolean {
  const t = String(text || '').toUpperCase();
  return !CYRILLIC_RE.test(t)
    && !FOREIGN_DUB_LANG_RE.test(t)
    && !RUTRACKER_TRANSLIT_RE.test(t)
    && (/\bDUBBED\b/.test(t) || /\[\s*DUB\s*\]|\(\s*DUB\s*\)|\bDUB\b/.test(t));
}

/**
 * Núcleo da guarda ampla SEM o token `MULTI` e SEM `ENGLISH|ENG`: nome de
 * idioma estrangeiro, script cirílico ou grafia de cena não-BR (`LAT`/`ESP`/
 * VFF…) — tudo que NOMEIA uma língua que não é o português e não é o inglês.
 * `MULTI` fica de fora porque é rótulo de «faixas múltiplas», não afirmação
 * de idioma: carrega a faixa original e pode muito bem incluir o PT-BR — é o
 * contrato documentado em `audioFromTitle`, que o joga no balde ambíguo
 * `dual`. `ENGLISH|ENG` ficam de fora porque em torrents BR "Dual Audio
 * English" = PT+EN (o caso comum), não "só inglês" — o Hindi/Tamil/etc é que
 * são os falsos duals (o áudio é daquele idioma, não PT+Hindi).
 */
const FOREIGN_LANG_FOR_BUCKET_RE = new RegExp(
  '\\b(HINDI|TAMIL|TELUGU|MALAYALAM|KANNADA|BENGALI|PUNJABI|MARATHI'
  + '|UKR|UKRAINIAN|RUS|RUSSIAN|POLISH|CZECH|SLOVAK|HUNGARIAN|ROMANIAN|BULGARIAN'
  + '|GREEK|HEBREW|ARABIC|PERSIAN|TURKISH|THAI|VIETNAMESE'
  + '|KOREAN|JAPANESE|CHINESE|MANDARIN|CANTONESE'
  + '|GERMAN|FRENCH|TRUEFRENCH|ITALIAN|ITA|SPANISH|SPA|ESPANOL|CASTELLANO|LATINO'
  + '|DUTCH|SWEDISH|NORWEGIAN|DANISH|FINNISH)\\b',
);

function foreignLangNamedForBucket(text: string): boolean {
  const raw = String(text || '');
  const t = raw.toUpperCase();
  return FOREIGN_LANG_FOR_BUCKET_RE.test(t)
    || CYRILLIC_RE.test(raw)
    || RUTRACKER_TRANSLIT_RE.test(raw)
    || /\b(LAT|ESP)\b/.test(t)
    || /VFF|VF2|VFQ|VOSTFR|HDLIGHT/i.test(raw);
}

/**
 * Idioma estrangeiro / cena não-BR no título — guarda AMPLA. Reusa a lista
 * que desmente DUB genérico + cirílico, e acrescenta grafias que a lista
 * mínima ainda não mede ou que só negam BR (`LAT`, `ESP`, `MULTI`, VFF…).
 * Quem chama OR-a com `hasExplicitForeignAudio` (VF/SUBITA/NL…) para não
 * regressar a condenação mínima. Só entra onde negar BR é barato.
 */
function namesForeignDubLanguage(text: string): boolean {
  return foreignLangNamedForBucket(text) || /\bMULTI\b/.test(String(text || '').toUpperCase());
}

// Lado marcador do mesmo intento, para o path: um marker de
// AUDIO_AUDIT_PT_MARKERS é genérico quando normaliza para exatamente
// 'dub'/'dubbed'/'dual'/'dual audio' — só ele sofre a guarda do HINDI/cirílico.
// `dual`/`dual audio` entraram na mesma guarda do `dub`: em release
// internacional DUAL anuncia as faixas ORIGINAL + estrangeira, e o idioma
// nomeado ao lado desmente a promessa exatamente como desmente um `DUB`. Medido
// no painel de limpeza: `Serenity … [Dual Audio] [Hindi DD 5.1]` era ABSOLVIDO
// pelo marcador `dual`, então `foreignProof` ficava vazio e nem a Limpeza BR nem
// o sweep enxergavam o item. Os demais marcadores ('dublado', 'pt br'…)
// afirmam o português e não provam menos por causa de HINDI nem de cirílico.
// Limitação honesta: marcador genérico CUSTOMIZADO novo (ex.: 'dubs') é tratado
// como explícito e escapa da guarda — o fechamento cobre as formas genéricas
// conhecidas, não qualquer vocabulário futuro.
const GENERIC_DUB_MARKER_RE = /^(?:dub(?:bed)?|dual(?: audio)?)$/;

/** Marcador de áudio PT no path real do arquivo, não no título do post. */
function hasPtAudioMark(path = '') {
  const tokens = normalizeTitle(path).split(' ').filter(Boolean);
  const joined = ` ${tokens.join(' ')} `;
  // Mesma regra do explicitPtAudio (FOREIGN_DUB_LANG_RE + CYRILLIC_RE +
  // RUTRACKER_TRANSLIT_RE): marcador genérico de dublagem não prova PT quando
  // o path nomeia idioma estrangeiro, está escrito em cirílico ou carrega
  // assinatura transliterada do rutracker. Marcador explícito segue valendo
  // — o idioma/script/formato só desmente a promessa GENÉRICA.
  const raw = String(path);
  const hasForeignLang = FOREIGN_DUB_LANG_RE.test(raw.toUpperCase())
    || CYRILLIC_RE.test(raw)
    || RUTRACKER_TRANSLIT_RE.test(raw);
  return config.audioAudit.ptMarkers.some((marker: string) => {
    const normalized = normalizeTitle(marker);
    if (!normalized) return false;
    if (hasForeignLang && GENERIC_DUB_MARKER_RE.test(normalized)) return false;
    return joined.includes(` ${normalized} `);
  });
}

/** Grupo/canal de cena EN forte. Nome sem marca continua ambíguo e passa. */
function strongEnSceneMark(path = '') {
  if (hasPtAudioMark(path)) return null;
  const tokens = new Set(normalizeTitle(path).split(' ').filter(Boolean));
  return config.audioAudit.enGroups.find((group: string) => tokens.has(normalizeTitle(group))) || null;
}

/**
 * Mentira só é provada quando TODOS os vídeos contradizem uma promessa PT com
 * sinal EN forte. Um único marcador PT preserva o item: falso negativo é pior.
 */
function dubbedLieVerdict(videoPaths: string[] = [], promisedDubbed = false) {
  const paths = videoPaths.map(String).filter(Boolean);
  if (!config.audioAudit.enabled || !promisedDubbed || paths.length === 0) {
    return { lie: false, videoCount: paths.length };
  }
  if (paths.some((path) => hasPtAudioMark(path))) return { lie: false, videoCount: paths.length };
  const matchedGroup = paths.map(strongEnSceneMark).find(Boolean);
  return matchedGroup
    ? { lie: true, matchedGroup, videoCount: paths.length }
    : { lie: false, videoCount: paths.length };
}

export {
  genericDubProvesPt,
  foreignLangNamedForBucket,
  namesForeignDubLanguage,
  hasPtAudioMark,
  strongEnSceneMark,
  dubbedLieVerdict,
};
