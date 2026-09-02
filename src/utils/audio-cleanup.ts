/**
 * audio-cleanup.ts — guardas da promessa GENÉRICA de dublagem e o caminho do
 * path real de arquivo (extraído de audio-quality.ts no split do teto de 400):
 *
 * - `FOREIGN_DUB_LANG_RE` / `CYRILLIC_RE` / `genericDubProvesPt` — só derrubam
 *   a prova GENÉRICA (`DUB`/`DUBBED`); marca PT explícita continua absolvendo
 *   pelas regras próprias dos chamadores, fora deste predicado;
 * - `hasPtAudioMark` / `strongEnSceneMark` / `dubbedLieVerdict` — a auditoria
 *   de dublagem sobre o path real dos arquivos.
 *
 * Deliberadamente NÃO mora aqui `hasExplicitForeignAudio` nem `foreignVerdict`
 * (ficam em audio-quality.ts): são os lados que CONDENAM e apagam da conta, e
 * a assimetria entre guarda (generosa: só deixa de absolver) e condenação
 * (mínima: destrói) é travada por test/audio-cleanup-classifiers.test.ts.
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
 * casa dentro de nome de grupo e condenaria release BR por acidente.
 */
const FOREIGN_DUB_LANG_RE = new RegExp(
  '\\b(HINDI|TAMIL|TELUGU|MALAYALAM|KANNADA|BENGALI|PUNJABI|MARATHI'
  + '|UKR|UKRAINIAN|RUS|RUSSIAN|POLISH|CZECH|SLOVAK|HUNGARIAN|ROMANIAN|BULGARIAN'
  + '|GREEK|HEBREW|ARABIC|PERSIAN|TURKISH|THAI|VIETNAMESE'
  + '|KOREAN|JAPANESE|CHINESE|MANDARIN|CANTONESE'
  + '|GERMAN|FRENCH|TRUEFRENCH|ITALIAN|ITA|SPANISH|ESPANOL|CASTELLANO|LATINO'
  + '|DUTCH|SWEDISH|NORWEGIAN|DANISH|FINNISH)\\b',
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
 * Guarda compartilhada da dublagem GENÉRICA (título e path usam o mesmo
 * intento). Marcador genérico de DUB/DUBBED NÃO prova áudio PT quando o
 * texto nomeia um idioma estrangeiro ou está escrito em cirílico. O PT
 * explícito ao lado (`HINDI… DUB PT-BR`, `Во все тяжкие … [DUB] PT-BR`)
 * continua vencendo FORA deste predicado, nas regras próprias de cada
 * chamador.
 */
function genericDubProvesPt(text: string): boolean {
  const t = String(text || '').toUpperCase();
  return !CYRILLIC_RE.test(t)
    && !FOREIGN_DUB_LANG_RE.test(t)
    && (/\bDUBBED\b/.test(t) || /\[\s*DUB\s*\]|\(\s*DUB\s*\)|\bDUB\b/.test(t));
}

// Lado marcador do mesmo intento, para o path: um marker de
// AUDIO_AUDIT_PT_MARKERS é genérico quando normaliza para exatamente
// 'dub'/'dubbed' — só ele sofre a guarda do HINDI/cirílico. Marcador
// explícito ('dublado', 'dual', 'pt br'…) não prova menos por causa de
// HINDI nem de cirílico. Limitação honesta: marcador genérico CUSTOMIZADO
// novo (ex.: 'dubs') é tratado como explícito e escapa da guarda — o
// fechamento cobre as formas genéricas conhecidas, não qualquer vocabulário
// futuro.
const GENERIC_DUB_MARKER_RE = /^dub(?:bed)?$/;

/** Marcador de áudio PT no path real do arquivo, não no título do post. */
function hasPtAudioMark(path = '') {
  const tokens = normalizeTitle(path).split(' ').filter(Boolean);
  const joined = ` ${tokens.join(' ')} `;
  // Mesma regra do explicitPtAudio (FOREIGN_DUB_LANG_RE + CYRILLIC_RE):
  // marcador genérico de dublagem não prova PT quando o path nomeia idioma
  // estrangeiro ou está escrito em cirílico. Marcador explícito segue
  // valendo — o idioma/script só desmente a promessa GENÉRICA.
  const raw = String(path);
  const hasForeignLang = FOREIGN_DUB_LANG_RE.test(raw.toUpperCase()) || CYRILLIC_RE.test(raw);
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

export { genericDubProvesPt, hasPtAudioMark, strongEnSceneMark, dubbedLieVerdict };
