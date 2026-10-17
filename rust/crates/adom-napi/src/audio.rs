//! Bindings NAPI do ÁUDIO e da ORIGEM BR a partir do TÍTULO (`adom-core`).
//!
//! Porte da fronteira de `src/utils/audio-quality.ts`, `src/utils/audio-cleanup.ts`
//! e `src/utils/audio-cleanup.ts`×`br-origin.ts`: os classificadores de áudio
//! (`audioFromTitle`, `looksPtBr`, `audioBucket`, `explicitPtAudio`…), os
//! rótulos da coluna estreita (`quality/source/edition/compactAudio`), as
//! guardas de dublagem genérica (`genericDubProvesPt`, `namesForeignDubLanguage`)
//! e a auditoria pelo PATH REAL (`hasPtAudioMark`, `strongEnSceneMark`,
//! `dubbedLieVerdict`). A lógica real vive em `adom-core` (golden contra o TS do
//! `esm`); aqui só se convertem tipos na fronteira.
//!
//! ## Invariante 2 da origem BR
//!
//! As duas listas de idioma estrangeiro continuam SEPARADAS, como no TS:
//! `names_foreign_dub_language` (AMPLA — só nega a vaga BR) e
//! `has_explicit_foreign_audio` (MÍNIMA — a única dos caminhos destrutivos).
//! Nada aqui as unifica.
//!
//! ## Listas calibradas de config
//!
//! `ptMarkers`/`enGroups` (e o `enabled`) vêm por parâmetro, como `cut_tail` em
//! `matches_br_title`: o núcleo é puro, não lê `config.*`.
//!
//! ## Lote
//!
//! Medido em `tmp/g3-measure.mjs` (450 títulos/labels reais do `magnets.db`):
//! só o inventário da conta justifica lote — 1203 itens, 4 sondas por título,
//! 15,2 ms em chamada direta contra 4,7 ms do TS. `audio_signals_many` entrega
//! as 4 sondas numa travessia. Os demais laços ficam em chamada DIRETA, cada um
//! com o número medido no comentário do lote (o piso de 0,5 ms por laço vale no
//! tamanho REAL do laço, não em 450 itens sintéticos).

use napi::{Env, JsString, Result};
use napi_derive::napi;

/// Veredito de `dubbedLieVerdict` na fronteira (o `matchedGroup` só existe
/// quando há mentira provada).
#[napi(object)]
pub struct DubbedLieVerdict {
    /// `true` quando TODOS os vídeos contradizem a promessa PT com sinal EN.
    pub lie: bool,
    /// Grupo de cena EN que provou a contradição (null quando não há).
    pub matched_group: Option<String>,
    /// Quantos paths NÃO vazios entraram — o TS conta o length filtrado.
    pub video_count: u32,
}

// ─── Apresentação do áudio ───────────────────────────────────────────────

/// Corta a cauda de tags de qualidade/fonte que os posts BR colam no título —
/// porte de `stripQualityTagBlob`.
#[napi(catch_unwind)]
pub fn strip_quality_tag_blob(title: String) -> String {
    adom_core::strip_quality_tag_blob(&title).to_string()
}

/// Rótulo de áudio do título (`Dublado`/`Legendado`/`Dual`/`Nacional`/`""`) —
/// porte de `audioFromTitle`.
#[napi(catch_unwind)]
pub fn audio_from_title(title: String) -> String {
    adom_core::audio_from_title(&title).to_string()
}

/// Dublado PT-BR visível no TÍTULO, independente do indexer — porte de
/// `looksPtBr`.
#[napi(catch_unwind)]
pub fn looks_pt_br(title: String) -> bool {
    adom_core::looks_pt_br(&title)
}

/// Prova POSITIVA de áudio PT no título — porte de `explicitPtAudio`.
#[napi(catch_unwind)]
pub fn explicit_pt_audio(title: String) -> bool {
    adom_core::explicit_pt_audio(&title)
}

/// Lista MÍNIMA de idioma estrangeiro, a única dos caminhos DESTRUTIVOS —
/// porte de `hasExplicitForeignAudio`. NÃO uniformize com
/// `names_foreign_dub_language`.
#[napi(catch_unwind)]
pub fn has_explicit_foreign_audio(title: String) -> bool {
    adom_core::has_explicit_foreign_audio(&title)
}

/// Balde de áudio do catálogo (`dub`/`dual`/`pt`/`lixo`) — porte de
/// `audioBucket`.
#[napi(catch_unwind)]
pub fn audio_bucket(title: String) -> String {
    adom_core::audio_bucket(&title).to_string()
}

/// Veredito de estrangeiro do caminho destrutivo (`absolve`/`condena`/
/// `unknown`) — porte de `foreignVerdict`. Ausência de PT nunca condena.
#[napi(catch_unwind)]
pub fn foreign_verdict(
    filename: String,
    video_paths: Vec<String>,
    pt_markers: Vec<String>,
    en_groups: Vec<String>,
) -> String {
    let paths: Vec<&str> = video_paths.iter().map(String::as_str).collect();
    let pt: Vec<&str> = pt_markers.iter().map(String::as_str).collect();
    let en: Vec<&str> = en_groups.iter().map(String::as_str).collect();
    adom_core::foreign_verdict(&filename, &paths, &pt, &en).to_string()
}

// ─── Rótulos da coluna estreita ──────────────────────────────────────────

/// Resolução do título (ou `UNKNOWN_QUALITY`) — porte de `qualityFromTitle`.
///
/// O valor de `UNKNOWN_QUALITY` também é exposto em `unknownQuality` para o
/// lado TS conferir a constante (ele não pode carregar o `.node` no import).
#[napi(catch_unwind)]
pub fn quality_from_title(title: String) -> String {
    adom_core::quality_from_title(&title).to_string()
}

/// Constante `UNKNOWN_QUALITY` do núcleo (`"sem resolução"`), para o lado TS
/// manter a MESMA string sem literal duplicado sem dono.
#[napi(catch_unwind)]
pub fn unknown_quality() -> String {
    adom_core::UNKNOWN_QUALITY.to_string()
}

/// Fonte da release (`BluRay`/`WEB-DL`/`WEBRip`/`HDTV`/`CAM`/`""`) — porte de
/// `sourceFromTitle`.
#[napi(catch_unwind)]
pub fn source_from_title(title: String) -> String {
    adom_core::source_from_title(&title).to_string()
}

/// Corte do filme anunciado na release — porte de `editionFromTitle`.
#[napi(catch_unwind)]
pub fn edition_from_title(title: String) -> String {
    adom_core::edition_from_title(&title).to_string()
}

/// Rótulo curto do áudio (`DUB`/`LEG`/`DUAL`/`NAC`/`""`) — porte de
/// `compactAudio`.
#[napi(catch_unwind)]
pub fn compact_audio(audio: String) -> String {
    adom_core::compact_audio(&audio).to_string()
}

/// Nome da fonte para a coluna estreita — porte de `compactTracker`.
///
/// O corte é em unidades UTF-16 e pode partir um par astral: um `String` do
/// Rust não representa surrogate órfão, então a string do Node é montada
/// direto das unidades (mesmo quirk que o `JsText` do núcleo preserva).
#[napi(catch_unwind)]
pub fn compact_tracker(env: Env, tracker: String) -> Result<JsString> {
    let label = adom_core::compact_tracker(&tracker);
    env.create_string_utf16(label.as_units())
}

// ─── Guardas de dublagem genérica (audio-cleanup.ts) ─────────────────────

/// `DUB`/`DUBBED` genérico só prova PT sem idioma estrangeiro/cirílico/
/// rutracker/`LAT` — porte de `genericDubProvesPt`.
#[napi(catch_unwind)]
pub fn generic_dub_proves_pt(text: String) -> bool {
    adom_core::generic_dub_proves_pt(&text)
}

/// Nomeia idioma que não é português nem inglês (guarda do balde dual) —
/// porte de `foreignLangNamedForBucket`.
#[napi(catch_unwind)]
pub fn foreign_lang_named_for_bucket(text: String) -> bool {
    adom_core::foreign_lang_named_for_bucket(&text)
}

/// Guarda AMPLA de idioma estrangeiro (só NEGA a vaga BR) — porte de
/// `namesForeignDubLanguage`. NÃO é a lista mínima que apaga da conta.
#[napi(catch_unwind)]
pub fn names_foreign_dub_language(text: String) -> bool {
    adom_core::names_foreign_dub_language(&text)
}

// ─── Auditoria pelo path real do arquivo ─────────────────────────────────

/// Marcador de áudio PT no PATH real do arquivo — porte de `hasPtAudioMark`.
#[napi(catch_unwind)]
pub fn has_pt_audio_mark(path: String, pt_markers: Vec<String>) -> bool {
    let pt: Vec<&str> = pt_markers.iter().map(String::as_str).collect();
    adom_core::has_pt_audio_mark(&path, &pt)
}

/// Primeiro grupo/canal de cena EN forte presente no path — porte de
/// `strongEnSceneMark` (`null` quando não há).
#[napi(catch_unwind)]
pub fn strong_en_scene_mark(
    path: String,
    pt_markers: Vec<String>,
    en_groups: Vec<String>,
) -> Option<String> {
    let pt: Vec<&str> = pt_markers.iter().map(String::as_str).collect();
    let en: Vec<&str> = en_groups.iter().map(String::as_str).collect();
    adom_core::strong_en_scene_mark(&path, &pt, &en).map(str::to_owned)
}

/// Mentira provada: TODOS os vídeos contradizem a promessa PT — porte de
/// `dubbedLieVerdict`.
#[napi(catch_unwind)]
pub fn dubbed_lie_verdict(
    video_paths: Vec<String>,
    promised_dubbed: bool,
    enabled: bool,
    pt_markers: Vec<String>,
    en_groups: Vec<String>,
) -> DubbedLieVerdict {
    let paths: Vec<&str> = video_paths.iter().map(String::as_str).collect();
    let pt: Vec<&str> = pt_markers.iter().map(String::as_str).collect();
    let en: Vec<&str> = en_groups.iter().map(String::as_str).collect();
    let verdict = adom_core::dubbed_lie_verdict(&paths, promised_dubbed, enabled, &pt, &en);
    DubbedLieVerdict {
        lie: verdict.lie,
        matched_group: verdict.matched_group,
        video_count: verdict.video_count as u32,
    }
}

/// O `dn=` do magnet contradiz a promessa de dublado — porte de
/// `dnContradictsDubClaim`. REMUX fica de fora; só tira a prioridade.
#[napi(catch_unwind)]
pub fn dn_contradicts_dub_claim(
    dn: String,
    enabled: bool,
    pt_markers: Vec<String>,
    en_groups: Vec<String>,
) -> bool {
    let pt: Vec<&str> = pt_markers.iter().map(String::as_str).collect();
    let en: Vec<&str> = en_groups.iter().map(String::as_str).collect();
    adom_core::dn_contradicts_dub_claim(&dn, enabled, &pt, &en)
}

/// Título de post BR que é o nome de cena EN intacto — porte de
/// `enSceneMirrorTitle`.
#[napi(catch_unwind)]
pub fn en_scene_mirror_title(
    title: String,
    pt_markers: Vec<String>,
    en_groups: Vec<String>,
) -> bool {
    let pt: Vec<&str> = pt_markers.iter().map(String::as_str).collect();
    let en: Vec<&str> = en_groups.iter().map(String::as_str).collect();
    adom_core::en_scene_mirror_title(&title, &pt, &en)
}

// ─── Origem BR (br-origin.ts) ────────────────────────────────────────────
//
// `has_pt_signs` e `br_origin_mark` já vivem em `lib.rs` (`hasPtSigns`/
// `brOriginMark`), expostos desde o G? da ponte: nada a duplicar aqui.

// ─── Lote do inventário da conta ─────────────────────────────────────────
//
// Medição em `tmp/g3-measure.mjs`: por chamada avulsa o napi é ~2,5× o TS
// (travessia de string + passadas de regex). O inventário real da conta tem
// 1203 itens (medido em produção) e o laço de `account.ts` consulta 4 sondas
// por título: 15,2 ms em chamada direta contra 4,7 ms do TS — a maior
// regressão absoluta do G3. Aqui UMA travessia entrega as 4 sondas por título.
//
// O lote devolve SÓ as sondas já portadas; a COMPOSIÇÃO da regra
// (`origemBrSemProvaDeAudio`) continua em `account.ts`. O rótulo e o
// `looksPtBr` saem da mesma passada (`adom_core::audio_signals`) — chamá-los
// separados recalcularia `audio_from_title`, que é a parte caríssima.

/// Sondas de UM título no lote do inventário da conta.
///
/// Todas booleanas de propósito: o chamador compara o rótulo só com
/// `Legendado` (`origemBrSemProvaDeAudio`), e devolver a string por item seria
/// alocação que ninguém lê — a medição do lote é sensível a isso
/// (`tmp/g3-account-lote.mjs`).
#[napi(object)]
pub struct AudioSignals {
    /// `looksPtBr` — dublado PT-BR visível no título (mesma passada do rótulo).
    pub pt_audio: bool,
    /// `hasExplicitForeignAudio` — lista MÍNIMA, dos caminhos destrutivos.
    pub explicit_foreign: bool,
    /// `brOriginMark` — origem BR pelo nome (8.4, o lado que NÃO apaga).
    pub br_origin: bool,
    /// `audioFromTitle(title) === 'Legendado'` — a única comparação de rótulo
    /// que o chamador faz.
    pub legendado: bool,
}

/// Lote de áudio/origem do inventário da conta (uma travessia para N títulos).
#[napi(catch_unwind)]
pub fn audio_signals_many(titles: Vec<String>) -> Vec<AudioSignals> {
    titles
        .iter()
        .map(|title| {
            let signals = adom_core::audio_signals(title);
            AudioSignals {
                pt_audio: signals.looks_pt_br,
                explicit_foreign: adom_core::has_explicit_foreign_audio(title),
                br_origin: adom_core::br_origin_mark(title),
                legendado: signals.audio == "Legendado",
            }
        })
        .collect()
}
