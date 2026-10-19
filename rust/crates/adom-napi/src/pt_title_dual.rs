//! Fronteira napi da recuperação de DUAL global pelo título pt do TMDB
//! (`ptTitleDual`). A decisão é INTEIRA de `adom_core::pt_title_dual`; aqui só
//! se convertem tipos e se faz o lote numa travessia.
//!
//! O corpo TS saiu de `src/providers/pt-title-dual.ts`: métricas e trace
//! continuam no Node (efeitos), mas "marcar ou não" não tem reserva TS.

use napi_derive::napi;

/// Títulos da obra (`TitlesCtx` do TS). `pt` ausente/vazio nunca marca.
#[napi(object)]
pub struct PtTitleDualTitles {
    pub original: Option<String>,
    pub pt: Option<String>,
    pub en: Option<String>,
}

/// Item cru reduzido ao que a régua lê (`title || Title`, origem e mentira).
/// `lied` cobre `item.lied || item._lied` no chamador.
#[napi(object)]
pub struct PtTitleDualItem {
    pub title: Option<String>,
    pub title_pascal: Option<String>,
    pub is_br: bool,
    pub lied: bool,
}

/// Lote: `true` em cada posição que recebe `ptTitleDual`.
///
/// A ordem de saída é a de entrada (o chamador marca por índice); sem `titles`
/// ou sem `pt`, devolve tudo `false` sem tocar nas strings.
#[napi(catch_unwind)]
pub fn pt_title_dual_marks(
    items: Vec<PtTitleDualItem>,
    titles: Option<PtTitleDualTitles>,
) -> Vec<bool> {
    let titles = titles.map(|t| adom_core::PtTitleDualTitles {
        original: t.original,
        pt: t.pt,
        en: t.en,
    });
    let inputs: Vec<adom_core::PtTitleDualItem<'_>> = items
        .iter()
        .map(|item| adom_core::PtTitleDualItem {
            title: item.title.as_deref(),
            title_pascal: item.title_pascal.as_deref(),
            is_br: item.is_br,
            lied: item.lied,
        })
        .collect();
    adom_core::pt_title_dual_marks(&inputs, titles.as_ref())
}
