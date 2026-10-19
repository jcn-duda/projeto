//! Porte fiel de `applyPtTitleDual` (`src/providers/pt-title-dual.ts`): a
//! recuperação de DUAL em tracker GLOBAL cujo título COMEÇA com o nome pt-BR
//! do TMDB.
//!
//! Sem acento nem marca PT (`Lanternas…DUAL`, `A.Rocha…DUAL`), `looksPtBr`
//! falha: Dual sozinho é ambíguo (EN+qualquer idioma). O contexto da obra —
//! título pt distinto do original/en — é a prova de origem BR que o acento não
//! trouxe. `MULTI` sozinho NÃO entra: é faixa multiidioma de cena, não dublagem
//! BR.
//!
//! Guardas que NÃO podem ser relaxadas (o TS do `esm` é o oráculo):
//! - two-sided (`minTokens = 3`): título E pt perdem o determinante juntos;
//!   `"A Rocha"` (2 tokens) não pode virar `"rocha"` contra
//!   `"Na Rocha Queimada"`;
//! - legacy (`minTokens = 2`, só o pt perde o determinante): `"O Corvo"` →
//!   `"corvo"` casa `"Corvo 1994 … DUAL"`;
//! - ambas as classes (artigos ∪ contrações) valem nas duas guardas;
//! - depois do prefixo pt, o próximo token tem que ser ano/episódio/marca de
//!   release — prefixo sem fronteira herda homônimo;
//! - `LEGENDADO`/`LEG` sem PT explícito derruba (o botão anunciado é legenda);
//! - `MULTI`/`LAT`/`ESP`/VF… (lista ampla) negam; `PT` explícito absolve;
//! - `isBr` já provou origem e `lied`/`_lied` é mentira comprovada.
//!
//! Regras de paridade com o JS (sem a flag `u`):
//! - `\b` é ASCII (`(?-u:\b)`), como em `pt_audio_guards`/`audio_lang`;
//! - `\d` vira `[0-9]` (o `\d` do crate aceita dígitos de outros scripts);
//! - `AFTER_PT_OK_RE` NÃO tem `/i`: a entrada é o `normalizeTitle` minúsculo.

use std::sync::OnceLock;

use regex::Regex;

use crate::audio_lang::names_foreign_dub_language;
use crate::audio_presentation::{audio_from_title, looks_pt_br};
use crate::matching_vocabulary::leading_articles;
use crate::pt_audio_guards::{explicit_pt_audio, has_explicit_foreign_audio};
use crate::title_normalization::normalize_title;

/// `/\\bDUAL\\b|DUAL[- ]?AUDIO|AUDIO[- ]?DUPLO/i`.
fn dual_literal_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?-u:\b)DUAL(?-u:\b)|DUAL[- ]?AUDIO|AUDIO[- ]?DUPLO")
            .expect("marcador DUAL compila")
    })
}

/// `/\b(LEGENDAD[OA]|LEGENDAS?|LEG[-.]?PT[-.]?BR|SUB[-.]?PT[-.]?BR|SOFT[- ]?SUB)\b/i`.
fn legendado_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?-u:\b)(?:LEGENDAD[OA]|LEGENDAS?|LEG[-.]?PT[-.]?BR|SUB[-.]?PT[-.]?BR|SOFT[- ]?SUB)(?-u:\b)",
        )
        .expect("marcador LEGENDADO compila")
    })
}

/// `/^(?:\d{4}|s\d{1,2}(?:e\d{1,3})?|\d{3,4}p|dual|…)$/` (sem `/i`).
fn after_pt_ok_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^(?:[0-9]{4}|s[0-9]{1,2}(?:e[0-9]{1,3})?|[0-9]{3,4}p|dual|audio|duplo|bluray|bdrip|webdl|web|hdtv|hdrip|remux|proper|repack|extended|complete|uhd|hdr|x264|x265|h264|h265|hevc|avc|aac|dts|atmos|truehd|ac3|eac3)$",
        )
        .expect("fronteira pós-prefixo compila")
    })
}

/// Contração inicial pt-BR do TMDB ("Na Hora da Zona Morta", "Da Colina
/// Vermelha"): o post BR costuma escrever o mesmo nome com OUTRO determinante
/// ("A Hora Da Zona Morta") e, sem tirar a primeira palavra dos DOIS lados, os
/// prefixos nunca coincidem.
const LEADING_CONTRACTIONS: &[&str] = &[
    "na", "no", "nas", "nos", "da", "do", "das", "dos", "em", "pela", "pelo",
];

/// Títulos da obra no contexto (o `TitlesCtx` do TS). `pt` vazio/ausente nunca
/// marca; `original`/`en` ausentes viram `''` (pt não-vazio e distinto "difere"
/// dos dois, como no JS).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PtTitleDualTitles {
    pub original: Option<String>,
    pub pt: Option<String>,
    pub en: Option<String>,
}

/// Item cru reduzido ao que a régua lê (`title || Title || ''`, origem e
/// mentira). `lied` cobre `item.lied || item._lied` do TS na fronteira.
#[derive(Debug, Clone, Copy, Default)]
pub struct PtTitleDualItem<'a> {
    pub title: Option<&'a str>,
    pub title_pascal: Option<&'a str>,
    pub is_br: bool,
    pub lied: bool,
}

impl PtTitleDualItem<'_> {
    /// `String(item.title || item.Title || '')` — vazio cai no `Title`.
    fn title_text(&self) -> &str {
        self.title
            .filter(|t| !t.is_empty())
            .or_else(|| self.title_pascal.filter(|t| !t.is_empty()))
            .unwrap_or("")
    }
}

/// A guarda de tokens é PARAMETRIZADA pelo caminho que chama, porque o risco
/// de mutilar o NOME é diferente em cada um:
/// - legado (default 2): só o pt do TMDB perde o determinante;
/// - dois lados (3): o TÍTULO também é mutilado; com 2 tokens, `"A Rocha"` →
///   `"rocha"` herdaria `"Na Rocha Queimada Dual"` pelo prefixo.
///
/// As DUAS classes (artigos ∪ contrações) valem nas DUAS guardas.
fn strip_leading_article(norm: &str, min_tokens: usize) -> String {
    let tokens: Vec<&str> = norm.split(' ').filter(|t| !t.is_empty()).collect();
    if tokens.len() >= min_tokens && is_leading_determiner(tokens[0]) {
        return tokens[1..].join(" ");
    }
    norm.to_string()
}

fn is_leading_determiner(token: &str) -> bool {
    leading_articles().contains(token) || LEADING_CONTRACTIONS.contains(&token)
}

/// `prefixThenRelease`: igual ao prefixo ou prefixo + token de release.
fn prefix_then_release(norm_title: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return false;
    }
    if norm_title == prefix {
        return true;
    }
    let Some(rest) = norm_title
        .strip_prefix(prefix)
        .and_then(|r| r.strip_prefix(' '))
    else {
        return false;
    };
    let first = rest.split(' ').next().unwrap_or("");
    after_pt_ok_re().is_match(first)
}

fn title_matches_pt(norm_title: &str, norm_pt: &str) -> bool {
    if prefix_then_release(norm_title, norm_pt) {
        return true;
    }
    // Caminho legado: o post OMITE o determinante do pt do TMDB
    // ("Grande Truque (2006) …" para "O Grande Truque").
    let without_article = strip_leading_article(norm_pt, 2);
    if without_article != norm_pt && prefix_then_release(norm_title, &without_article) {
        return true;
    }
    // Determinantes DIFERENTES nas duas pontas ("Na Hora da Zona Morta" do
    // TMDB × "A Hora Da Zona Morta" do post): só tirando o primeiro token dos
    // DOIS lados os prefixos coincidem. Guarda de 3 tokens — MAIOR que a do
    // legado — porque o título também é mutilado.
    let stripped_title = strip_leading_article(norm_title, 3);
    let stripped_pt = strip_leading_article(norm_pt, 3);
    stripped_title != norm_title
        && stripped_pt != norm_pt
        && prefix_then_release(&stripped_title, &stripped_pt)
}

fn foreign_dub_title(title: &str) -> bool {
    // Mínima OR ampla: VF/SUBITA/NL não podem regredir; LAT/ESP/MULTI/cirílico
    // também negam. PT explícito absolve nos dois lados.
    has_explicit_foreign_audio(title)
        || (!explicit_pt_audio(title) && names_foreign_dub_language(title))
}

/// A decisão pura de UM item (`shouldMark` do TS).
pub fn should_mark_pt_title_dual(
    item: &PtTitleDualItem<'_>,
    titles: Option<&PtTitleDualTitles>,
) -> bool {
    let Some(titles) = titles else {
        return false;
    };
    let Some(pt) = titles.pt.as_deref().filter(|t| !t.is_empty()) else {
        return false;
    };
    if item.is_br || item.lied {
        return false;
    }

    let title = item.title_text();
    // `_` é separador de fato nos posts BR ("… x264 DUAL_Misso"): é caractere de
    // palavra para o `\b`, então o marcador colado nele morre. O probe troca por
    // espaço; o casamento por prefixo usa `normalize_title`, que já trata `_`.
    let probe = title.replace('_', " ");
    if title.is_empty() || looks_pt_br(&probe) {
        return false;
    }
    if !dual_literal_re().is_match(&probe) {
        return false;
    }
    if audio_from_title(&probe) == "Legendado" {
        return false;
    }
    if legendado_re().is_match(&probe) && !explicit_pt_audio(&probe) {
        return false;
    }
    if foreign_dub_title(&probe) {
        return false;
    }

    let norm_pt = normalize_title(pt);
    if norm_pt.is_empty() {
        return false;
    }
    // original/en ausentes viram '' — pt não-vazio e distinto "difere" dos dois.
    let norm_original = normalize_title(titles.original.as_deref().unwrap_or(""));
    let norm_en = normalize_title(titles.en.as_deref().unwrap_or(""));
    if norm_pt == norm_original || norm_pt == norm_en {
        return false;
    }

    title_matches_pt(&normalize_title(title), &norm_pt)
}

/// Lote: mesma decisão por item, numa travessia. `true` marca `ptTitleDual`.
///
/// O lote existe para a fronteira napi (uma travessia de string por item, como
/// o `filter_relevant_raw`) e para o build in-process; a régua é a mesma de
/// [`should_mark_pt_title_dual`].
pub fn pt_title_dual_marks(
    items: &[PtTitleDualItem<'_>],
    titles: Option<&PtTitleDualTitles>,
) -> Vec<bool> {
    items
        .iter()
        .map(|item| should_mark_pt_title_dual(item, titles))
        .collect()
}

#[cfg(test)]
#[path = "pt_title_dual_tests.rs"]
mod tests;
