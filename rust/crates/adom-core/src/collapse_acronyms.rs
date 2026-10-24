//! Colapso de sigla pontuada, porte de `collapseAcronyms`.
//!
//! Delega a `collapse_dotted_acronyms`: a paridade com o Node, inclusive o
//! `charAt` de surrogate (letra astral não gruda), já foi medida no
//! `normalize_title`. Não há segunda implementação.

/// Colapsa sigla com ponto ("G.O.R.A.", "S.W.A.T.") numa palavra só.
pub fn collapse_acronyms(input: &str) -> String {
    crate::title_normalization::collapse_dotted_acronyms(input)
}
