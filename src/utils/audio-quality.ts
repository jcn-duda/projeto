/**
 * audio-quality.ts — áudio, rótulos da coluna estreita e origem BR pelo TÍTULO.
 * A decisão é INTEIRA no núcleo Rust (`rust/crates/adom-napi/src/audio.rs`;
 * lógica em `adom-core::audio_presentation`/`pt_audio_guards`/`release_labels`/
 * `catalog_classify`/`br_origin`, golden contra o TS do `esm`). O corpo TS saiu
 * do branch: aqui só se montam as entradas e se traduzem as saídas.
 *
 * Módulo-folha via `nativeCore` (como `title-normalization.ts`): `requireCore`/
 * `rust-core` importa `config`, e quem nos alimenta não pode fechar ciclo com
 * ele. As duas listas calibradas de `config.audioAudit` entram por PARÂMETRO —
 * o núcleo é puro, como `matchesBrTitle`/`cut_tail`.
 *
 * Invariante 2: a lista AMPLA (`namesForeignDubLanguage`, em audio-cleanup.ts) e
 * a MÍNIMA (`hasExplicitForeignAudio`, aqui) continuam funções separadas também
 * na ponte. Não uniformize.
 *
 * Regra de ouro: NUNCA há reserva TS. Por chamada avulsa o napi é ~2,5× o TS
 * (travessia de string) e lote parecia a resposta — mas medido em
 * `tmp/g3-measure.mjs` (450 títulos/labels reais do `magnets.db`) o lote de
 * sondas é MAIS LENTO (18,4 ms/1203 itens contra 12,2 ms da chamada direta no
 * laço da conta): o custo é o regex em Rust, não a travessia, e a montagem do
 * array de objetos no lado JS ainda cobra a diferença. Chamada direta, SEM lote.
 */
import config from '../config.js';
import { nativeCore } from './native-core.js';

/** Funções de áudio/rótulo no `.node` (camelCase do napi-rs). */
type AudioCore = {
  stripQualityTagBlob(title: string): string;
  audioFromTitle(title: string): string;
  looksPtBr(title: string): boolean;
  explicitPtAudio(title: string): boolean;
  hasExplicitForeignAudio(title: string): boolean;
  audioBucket(title: string): string;
  foreignVerdict(filename: string, videoPaths: string[], ptMarkers: string[], enGroups: string[]): string;
  qualityFromTitle(title: string): string;
  sourceFromTitle(title: string): string;
  editionFromTitle(title: string): string;
  compactAudio(audio: string): string;
  compactTracker(tracker: string): string;
  audioSignalsMany(titles: string[]): AudioSignals[];
};

/** Sondas de UM título no lote do inventário da conta. */
type AudioSignals = {
  /** `looksPtBr` — dublado PT-BR visível no título. */
  ptAudio: boolean;
  /** `hasExplicitForeignAudio` — lista MÍNIMA, dos caminhos destrutivos. */
  explicitForeign: boolean;
  /** `brOriginMark` — origem BR pelo nome (8.4, o lado que NÃO apaga). */
  brOrigin: boolean;
  /** `audioFromTitle(title) === 'Legendado'` — a única comparação de rótulo. */
  legendado: boolean;
};

const audioCore = () => nativeCore<AudioCore>();

/** Listas calibradas do audit de dublagem (ptMarkers/enGroups). */
const ptMarkers = (): string[] => config.audioAudit.ptMarkers as string[];
const enGroups = (): string[] => config.audioAudit.enGroups as string[];

/**
 * Resolução que o título não informa — balde e cota próprios. É dado, não
 * regra: o valor vem de `adom_core::UNKNOWN_QUALITY` e é conferido contra o
 * núcleo em `tmp/g3-paridade.mjs` (`unknownQuality()`); a constante não pode
 * carregar o `.node` no import, e quem só importa o módulo para ler o rótulo
 * não pode depender do binário.
 */
const UNKNOWN_QUALITY = 'sem resolução';

/**
 * Posts de site BR anexam ao FIM do título um blob de tags separadas por
 * vírgula listando TODAS as qualidades do post ("… LEGENDADA 720P 1080p,
 * 2160p, 720p, HD, WEB-DL"). Sem cortar essa cauda, `qualityFromTitle` casa o
 * "2160p" do blob e rotula um botão 720P como 4K — e o rótulo errado alimenta
 * cota de qualidade, reserva BR, autofetch e o índice (que persiste semanas).
 */
function stripQualityTagBlob(title = ''): string {
  return audioCore().stripQualityTagBlob(String(title ?? ''));
}

/**
 * Resolução do título, ou `UNKNOWN_QUALITY` ("não sei" ≠ "é ruim": SD exige
 * marca explícita de baixa qualidade).
 */
function qualityFromTitle(title = ''): string {
  return audioCore().qualityFromTitle(String(title ?? ''));
}

/** Fonte da release (BluRay > WEB-DL > WEBRip > HDTV > família CAM), ou `''`. */
function sourceFromTitle(title = ''): string {
  return audioCore().sourceFromTitle(String(title ?? ''));
}

/** Corte do filme anunciado na release (Alt.End, DC, Extended…), ou `''`. */
function editionFromTitle(title = ''): string {
  return audioCore().editionFromTitle(String(title ?? ''));
}

/** Prova POSITIVA de áudio PT no título (marcador explícito ou DUB genérico). */
function explicitPtAudio(title = ''): boolean {
  return audioCore().explicitPtAudio(String(title ?? ''));
}

/**
 * Áudio é a informação que mais importa neste addon (foco em dublado) e os
 * sites BR a escrevem no título: `Dublado`/`Legendado`/`Dual`/`Nacional`/`''`.
 */
function audioFromTitle(title = ''): string {
  return audioCore().audioFromTitle(String(title ?? ''));
}

/**
 * Marcas estrangeiras explícitas não devem vencer por seeders quando o objetivo
 * é aquecer um pack utilizável. Esta é a lista MÍNIMA (14 idiomas), a ÚNICA dos
 * caminhos destrutivos: condenar aciona `sweepUndubbed`, que APAGA da conta. A
 * guarda ampla (`namesForeignDubLanguage`) é outra função, de propósito.
 */
function hasExplicitForeignAudio(title = ''): boolean {
  return audioCore().hasExplicitForeignAudio(String(title ?? ''));
}

/**
 * Dublado pt-BR visível no TÍTULO, independente do indexer. "Dual" sozinho não
 * basta: só conta com o PT explícito ao lado ou sinal de português (invariante
 * 8.12) — a conjunção vive no núcleo.
 */
function looksPtBr(title = ''): boolean {
  return audioCore().looksPtBr(String(title ?? ''));
}

type AudioBucket = 'dub' | 'dual' | 'pt' | 'lixo';

/**
 * Balde de áudio do catálogo: `dub` (looksPtBr), `dual` (Dual/Multi ambíguo),
 * `pt` (sem áudio, com sinal de PT ou ORIGEM BR — a blindagem 8.4) e `lixo`
 * (legendado, estrangeiro explícito, dual com idioma nomeado, sem marca
 * nenhuma). O cast é de FRONTEIRA: o núcleo devolve exatamente um dos quatro
 * literais (mesma régua portada) e a paridade é medida com o TS do `esm`.
 */
function audioBucket(title = ''): AudioBucket {
  return audioCore().audioBucket(String(title ?? '')) as AudioBucket;
}

/**
 * Veredito de ESTRANGEIRO com a assimetria do `dubbedLieVerdict` invertida para
 * o caminho da deleção: ausência de PT nunca condena. Um único marcador PT em
 * qualquer lugar (título do post OU path real) absolve — falso positivo aqui
 * destrói acervo BR.
 */
type ForeignVerdict = 'absolve' | 'condena' | 'unknown';

function foreignVerdict(filename = '', videoPaths: string[] = []): ForeignVerdict {
  return audioCore().foreignVerdict(
    String(filename ?? ''),
    videoPaths.map((path) => String(path)),
    ptMarkers(),
    enGroups(),
  ) as ForeignVerdict;
}

/** Rótulo curto do áudio para a coluna estreita (`DUB`/`LEG`/`DUAL`/`NAC`). */
function compactAudio(audio = ''): string {
  return audioCore().compactAudio(String(audio ?? ''));
}

/**
 * Nome da fonte para a coluna estreita: o TLD não ajuda a reconhecer o site e,
 * passando de 14 caracteres, o rótulo empurra o seeder para fora. A escada de
 * corte (sufixo "torrent(s)", fronteira/camelCase, corte seco) vive no núcleo —
 * o corte é em unidades UTF-16 e pode partir um par astral.
 */
function compactTracker(tracker = ''): string {
  return audioCore().compactTracker(String(tracker ?? ''));
}

/**
 * Lote de áudio/origem para LISTAS (inventário da conta: 1203 itens medidos em
 * produção). Uma travessia entrega `audioFromTitle`/`looksPtBr`/
 * `hasExplicitForeignAudio`/`brOriginMark` por título; a COMPOSIÇÃO da regra
 * continua no chamador (`origemBrSemProvaDeAudio` em account.ts).
 *
 * Medido em `tmp/g3-measure.mjs`/`g3-account-lote.mjs`: o laço da conta custa
 * 9,0–12,6 ms em chamada direta e 8,1–10,6 ms em lote — a travessia por item é
 * barata (~0,15 µs, medido com `compactAudio`), o grosso é o regex do núcleo;
 * por isso o lote existe SÓ onde o laço é grande de verdade.
 */
function audioSignalsMany(titles: string[]): AudioSignals[] {
  return audioCore().audioSignalsMany(titles.map((title) => String(title ?? '')));
}

export {
  UNKNOWN_QUALITY,
  stripQualityTagBlob,
  qualityFromTitle,
  sourceFromTitle,
  editionFromTitle,
  explicitPtAudio,
  audioFromTitle,
  hasExplicitForeignAudio,
  looksPtBr,
  audioBucket,
  foreignVerdict,
  compactAudio,
  compactTracker,
  audioSignalsMany,
};
export type { AudioBucket, ForeignVerdict, AudioSignals };
// Auditoria pelo path real e guardas de dublagem genérica: a fronteira lê
// `config.audioAudit`, então mora em audio-cleanup.ts e é reexportada daqui
// para os consumidores (e o barrel `format.ts`) não mudarem de import.
export { hasPtAudioMark, strongEnSceneMark, dubbedLieVerdict } from './audio-cleanup.js';
export { hasPtSigns, brOriginMark } from './br-origin.js';
