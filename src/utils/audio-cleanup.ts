/**
 * audio-cleanup.ts — guardas da promessa GENÉRICA de dublagem e o caminho do
 * path real de arquivo. A decisão é INTEIRA no núcleo Rust
 * (`rust/crates/adom-napi/src/audio.rs`; lógica em
 * `adom-core::audio_cleanup_verdicts`/`audio_lang`, golden contra o TS do
 * `esm`). O corpo TS saiu do branch: aqui só se montam as entradas e se
 * traduzem as saídas.
 *
 * - `genericDubProvesPt` — `DUB`/`DUBBED` genérico só prova PT sem idioma
 *   estrangeiro nomeado, cirílico, assinatura do rutracker ou `LAT`; marca PT
 *   explícita continua absolvendo pelas regras próprias dos chamadores;
 * - `namesForeignDubLanguage` — guarda AMPLA (só nega a vaga BR); pode ser
 *   generosa porque não apaga da conta. `hasExplicitForeignAudio`
 *   (audio-quality.ts) é a lista MÍNIMA dos caminhos destrutivos (invariante 2:
 *   duas funções, nunca uma);
 * - `foreignLangNamedForBucket` — o MESMO núcleo da ampla, sem o token `MULTI`:
 *   nomeia um idioma que não é o português;
 * - `hasPtAudioMark` / `strongEnSceneMark` / `dubbedLieVerdict` — a auditoria de
 *   dublagem sobre o path real dos arquivos.
 *
 * As listas calibradas de `config.audioAudit` (`ptMarkers`, `enGroups`) e o
 * kill-switch `enabled` entram por PARÂMETRO — o núcleo é puro, como
 * `matchesBrTitle`/`cut_tail`. Medição do laço em `tmp/g3-measure.mjs`: chamada
 * direta, SEM lote (o lote de sondas perde — ver audio-quality.ts).
 */
import config from '../config.js';
import { nativeCore } from './native-core.js';

/** Funções de auditoria no `.node` (camelCase do napi-rs). */
type AudioCleanupCore = {
  genericDubProvesPt(text: string): boolean;
  foreignLangNamedForBucket(text: string): boolean;
  namesForeignDubLanguage(text: string): boolean;
  hasPtAudioMark(path: string, ptMarkers: string[]): boolean;
  strongEnSceneMark(path: string, ptMarkers: string[], enGroups: string[]): string | null;
  dubbedLieVerdict(
    videoPaths: string[],
    promisedDubbed: boolean,
    enabled: boolean,
    ptMarkers: string[],
    enGroups: string[],
  ): { lie: boolean; matchedGroup: string | null; videoCount: number };
  dnContradictsDubClaim(dn: string, enabled: boolean, ptMarkers: string[], enGroups: string[]): boolean;
  enSceneMirrorTitle(title: string, ptMarkers: string[], enGroups: string[]): boolean;
};

const cleanupCore = () => nativeCore<AudioCleanupCore>();

const ptMarkers = (): string[] => config.audioAudit.ptMarkers as string[];
const enGroups = (): string[] => config.audioAudit.enGroups as string[];

/**
 * Guarda compartilhada da dublagem GENÉRICA (título e path usam o mesmo
 * intento). O PT explícito ao lado continua vencendo FORA deste predicado, nas
 * regras próprias de cada chamador.
 */
function genericDubProvesPt(text: string): boolean {
  return cleanupCore().genericDubProvesPt(String(text ?? ''));
}

/**
 * Núcleo da guarda ampla SEM o token `MULTI` e SEM `ENGLISH|ENG`: nome de
 * idioma estrangeiro, script cirílico ou grafia de cena não-BR (`LAT`/`ESP`/
 * VFF…) — tudo que NOMEIA uma língua que não é o português e não é o inglês.
 */
function foreignLangNamedForBucket(text: string): boolean {
  return cleanupCore().foreignLangNamedForBucket(String(text ?? ''));
}

/**
 * Idioma estrangeiro / cena não-BR no título — guarda AMPLA. Quem chama OR-a
 * com `hasExplicitForeignAudio` para não regredir a condenação mínima. Só entra
 * onde negar BR é barato.
 */
function namesForeignDubLanguage(text: string): boolean {
  return cleanupCore().namesForeignDubLanguage(String(text ?? ''));
}

/**
 * Marcador de áudio PT no path real do arquivo, não no título do post. Marcador
 * genérico (`dub`/`dual`) cede a idioma estrangeiro/cirílico/rutracker; marcador
 * explícito segue valendo.
 */
function hasPtAudioMark(path = ''): boolean {
  return cleanupCore().hasPtAudioMark(String(path ?? ''), ptMarkers());
}

/** Grupo/canal de cena EN forte. Nome sem marca continua ambíguo e passa. */
function strongEnSceneMark(path = ''): string | null {
  return cleanupCore().strongEnSceneMark(String(path ?? ''), ptMarkers(), enGroups());
}

/**
 * Mentira só é provada quando TODOS os vídeos contradizem uma promessa PT com
 * sinal EN forte. Um único marcador PT preserva o item: falso negativo é pior.
 * O formato de saída é o do TS (`matchedGroup` AUSENTE quando não há mentira).
 */
function dubbedLieVerdict(videoPaths: string[] = [], promisedDubbed = false) {
  const verdict = cleanupCore().dubbedLieVerdict(
    videoPaths.map((path) => String(path)),
    promisedDubbed,
    config.audioAudit.enabled,
    ptMarkers(),
    enGroups(),
  );
  return verdict.matchedGroup
    ? { lie: verdict.lie, matchedGroup: verdict.matchedGroup, videoCount: verdict.videoCount }
    : { lie: verdict.lie, videoCount: verdict.videoCount };
}

/**
 * O `dn=` do magnet é o nome do PRÓPRIO torrent: nome de cena EN contradiz a
 * promessa de dublado já na listagem — só tira a prioridade (`_dubClaim`),
 * nunca remove nem condena. REMUX fica de fora (copia todas as faixas).
 */
function dnContradictsDubClaim(dn = ''): boolean {
  return cleanupCore().dnContradictsDubClaim(String(dn ?? ''), config.audioAudit.enabled, ptMarkers(), enGroups());
}

/**
 * Título de post BR que é o nome de cena EN intacto: o agregador republicou o
 * magnet gringo. Nega só a ORIGEM que o flag do indexer dava.
 */
function enSceneMirrorTitle(title = ''): boolean {
  return cleanupCore().enSceneMirrorTitle(String(title ?? ''), ptMarkers(), enGroups());
}

export {
  dnContradictsDubClaim,
  enSceneMirrorTitle,
  genericDubProvesPt,
  foreignLangNamedForBucket,
  namesForeignDubLanguage,
  hasPtAudioMark,
  strongEnSceneMark,
  dubbedLieVerdict,
};
