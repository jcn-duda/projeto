//! Régua do <h1> e limpeza de títulos (h1Text, splitParenYear, fichaYear, readWorkTitle, cleanWorkName).
//!
//! Porte fiel de `src/providers/crawl-sites/work-name.ts`.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use crate::shared::{collapse_whitespace, without_noise};
use adom_core::decode_entities;

/// Ano em parênteses, em qualquer posição do título (o site o põe no meio).
pub const YEAR_PAREN_RE: &str = r"[（(]\s*((?:19|20)\d{2})\s*[)）]";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SplitParenYear {
    pub rest: String,
    pub year: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkTitle {
    pub title: String,
    pub year: Option<u32>,
    pub raw: String,
}

/// O que o `<h1>` diz, já decodificado e colapsado (comentário/script fora).
pub fn h1_text(html: &str) -> String {
    let source = without_noise(html);
    static RE_H1: OnceLock<Regex> = OnceLock::new();
    static RE_TAG: OnceLock<Regex> = OnceLock::new();

    let re_h1 = RE_H1.get_or_init(|| Regex::new(r"(?is)<h1[^>]*>(.*?)</h1>").unwrap());
    let re_tag = RE_TAG.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());

    let h1_content = re_h1
        .captures(&source)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
        .unwrap_or("");
    let stripped = re_tag.replace_all(h1_content, " ");
    let decoded = decode_entities(&stripped);
    collapse_whitespace(&decoded)
}

/// O `<h1>` sem o parêntese do ano: o ano e o nome sem ele.
pub fn split_paren_year(raw: &str) -> SplitParenYear {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(YEAR_PAREN_RE).unwrap());
    if let Some(caps) = re.captures(raw) {
        let whole = caps.get(0).unwrap();
        let year = caps.get(1).unwrap().as_str().parse::<u32>().ok();
        let rest = format!("{} {}", &raw[..whole.start()], &raw[whole.end()..]);
        SplitParenYear { rest, year }
    } else {
        SplitParenYear {
            rest: raw.to_string(),
            year: None,
        }
    }
}

/// Ano DECLARADO na ficha da página ("<b>Lançamento:</b> <a>2021</a>", "<b>Ano de Lançamento:</b> 2017 (Brasil)").
pub fn ficha_year(html: &str) -> Option<u32> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        let ficha_tag = r"(?:<\/?(?:b|strong|span|a|em|i)(?-u:\b)[^>]*>\s*)*";
        let pat = format!(
            r"(?i)(?:Ano\s+de\s+)?Lan(?:[çc]|&ccedil;)amento\s*{ficha_tag}:?\s*{ficha_tag}((?:19|20)\d{{2}})(?-u:\b)"
        );
        Regex::new(&pat).unwrap()
    });
    re.captures(html)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u32>().ok())
}

/// Leitura completa do `<h1>`: nome, ano (parêntese; sem ele, a ficha) e o texto cru.
pub fn read_work_title(html: &str) -> WorkTitle {
    let raw = h1_text(html);
    let split = split_paren_year(&raw);
    let year = split.year.or_else(|| ficha_year(html));
    let mut title = clean_work_name(&split.rest);
    if let Some(y) = year {
        let y_str = y.to_string();
        if let Some(pos) = title.rfind(&y_str) {
            if pos + y_str.len() == title.len() && pos > 0 {
                let prefix = &title[..pos];
                if prefix.ends_with(|c: char| c.is_whitespace()) {
                    let trimmed = prefix.trim();
                    if !trimmed.is_empty() {
                        title = trimmed.to_string();
                    }
                }
            }
        }
    }
    WorkTitle { title, year, raw }
}

/// Nome da obra: o texto (já sem o ano) com a vitrine fora.
pub fn clean_work_name(text: &str) -> String {
    let mut title = text.to_string();

    // 1-10. Regras de ruído pré-lookahead (todas compiladas com regex padrão)
    static RE_NOISE_PRE: OnceLock<Vec<Regex>> = OnceLock::new();
    let re_noise_pre = RE_NOISE_PRE.get_or_init(|| {
        let ordinal_marked = r"\d{1,2}\s*[ªºa°]";
        let ordinal = r"\d{1,2}\s*[ªºa°]?";
        let ordinal_sep = r"\s*(?:[,&]\s*)?(?:[-–—]\s*)?(?:(?:até|ate|à|á|a|e)\s+)?";

        let n1 = format!(
            r"(?i)(?-u:\b)(?:(?:(?:{ordinal_marked}{ordinal_sep}(?:{ordinal}{ordinal_sep})*)|\d{{1,2}}\s*[ªºa°]?\s*)temporadas?(?:\s+(?:complet[ao]s?|inteiras?))?|todas\s+(?:as\s+)?temporadas(?:\s+(?:complet[ao]s?|inteiras?))?|temporadas?\s+(?:complet[ao]s?|inteiras?))"
        );
        let n2 = r"(?i)(?-u:\b)mini\s*s{1,2}[ée]ries?(?-u:\b)";
        let n3 = r"\(\s*(?:19|20)\d{2}\s*[-–—]\s*(?:19|20)\d{2}\s*\)";
        let n4 = r"(?i)(?-u:\b)\d{1,3}\s+epis[óo]dios(?-u:\b)";
        let n5 = r"(?i)(?-u:\b)(?:blu[\s-]?ray|bd[\s-]?rip|br[\s-]?rip|web[\s-]?dl|web[\s-]?rip|dvd[\s-]?rip|dvd[\s-]?scr|webcam|hdtv|tv[\s-]?rip|hd[\s-]?rip|hd[\s-]?ts|cam[\s-]?rip|remux)(?-u:\b)";
        let n6 = r"(?i)(?-u:\b)3d\s*[-–]?\s*(?:half[\s-]?)?(?:h[\s-]?sbs|sbs|h?[\s-]?ou|tab)(?-u:\b)";
        let n7 = r"(?i)(?-u:\b)dvd[\s-]?r(?-u:\b)(?:\s+oficial)?";
        let n8 = r"(?i)(?-u:\b)\d[\s.,]?\d?\s*(?:ch|canais?)(?-u:\b)";
        let n9 = r"(?i)(?-u:\b)(?:5\.1|7\.1|7\.2|2\.0|ddp|atmos|dts|x26[45]|h\.?26[45]|hevc)(?-u:\b)";
        let n10 = r"(?i)(?:^|\s)legendas?\s+(?:fixas|embutidas)(?:\s+em\s+portugu[eê]s)?";

        vec![
            Regex::new(&n1).unwrap(),
            Regex::new(n2).unwrap(),
            Regex::new(n3).unwrap(),
            Regex::new(n4).unwrap(),
            Regex::new(n5).unwrap(),
            Regex::new(n6).unwrap(),
            Regex::new(n7).unwrap(),
            Regex::new(n8).unwrap(),
            Regex::new(n9).unwrap(),
            Regex::new(n10).unwrap(),
        ]
    });

    for re in re_noise_pre {
        title = re.replace_all(&title, " ").into_owned();
    }

    // 11. Regra com lookahead positivo para limites de áudio/idioma
    static RE_NOISE_FANCY: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let re_noise_fancy = RE_NOISE_FANCY.get_or_init(|| {
        fancy_regex::Regex::new(
            r"(?i)(?:^|[-\s(\[/|—–])(?:dublad[oa]s?|legendad[oa]s?|dual|multi\s*[aá][uú]dio|[aá][uú]dio|legenda|embutida|nacional)(?=$|[-)\s\]/|—–.,;:!])"
        ).unwrap()
    });
    title = re_noise_fancy.replace_all(&title, " ").into_owned();

    // 12-13. Regras pós-lookahead (vitrine, qualidade, resolução)
    static RE_NOISE_POST: OnceLock<Vec<Regex>> = OnceLock::new();
    let re_noise_post = RE_NOISE_POST.get_or_init(|| {
        let n12 = r"(?i)(?-u:\b)(?:torrents?|download|baixar|gr[aá]tis|online|assistir|completo|completa|mega|gdrive)(?-u:\b)";
        let n13 = r"(?i)(?-u:\b)(?:full\s*hd|ultra\s*hd|\d{3,4}\s*[pi]|4k|8k|hd|sd)(?-u:\b)";
        vec![
            Regex::new(n12).unwrap(),
            Regex::new(n13).unwrap(),
        ]
    });
    for re in re_noise_post {
        title = re.replace_all(&title, " ").into_owned();
    }

    // Ruído sensível à caixa alta (Rip, FULL)
    static RE_CAPS: OnceLock<Vec<Regex>> = OnceLock::new();
    let re_caps = RE_CAPS.get_or_init(|| {
        vec![
            Regex::new(r"(?-u:\b)Rip(?-u:\b)").unwrap(),
            Regex::new(r"(?-u:\b)FULL(?-u:\b)").unwrap(),
        ]
    });
    for re in re_caps {
        title = re.replace_all(&title, " ").into_owned();
    }

    // Separadores órfãos e colapso de espaços
    static RE_ORPHAN_SEP: OnceLock<Regex> = OnceLock::new();
    let re_orphan_sep =
        RE_ORPHAN_SEP.get_or_init(|| Regex::new(r"\s*[-–—/|+]\s*(?:[-–—/|+]\s*)*").unwrap());
    title = re_orphan_sep.replace_all(&title, " ").into_owned();
    title = collapse_whitespace(&title);

    // Conector órfão final (" e")
    static RE_TRAILING: OnceLock<Regex> = OnceLock::new();
    let re_trailing = RE_TRAILING.get_or_init(|| Regex::new(r"(?i)\s+e$").unwrap());
    title = re_trailing.replace(&title, "").into_owned();
    title = title.trim().to_string();

    // Separadores de borda
    static RE_EDGE_SEP: OnceLock<Regex> = OnceLock::new();
    let re_edge_sep =
        RE_EDGE_SEP.get_or_init(|| Regex::new(r"^[–\-—/|:&+\s]+|[–\-—/|:&+\s]+$").unwrap());
    title = re_edge_sep.replace_all(&title, "").into_owned();
    collapse_whitespace(&title)
}

#[allow(non_snake_case)]
pub mod compat {
    pub use super::{
        clean_work_name as cleanWorkName, ficha_year as fichaYear, h1_text as h1Text,
        read_work_title as readWorkTitle, split_paren_year as splitParenYear,
    };
}
pub use compat::*;

#[cfg(test)]
#[path = "work_name_tests.rs"]
mod tests;
