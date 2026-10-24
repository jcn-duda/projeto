//! Porte das guardas de franquia de `src/utils/franchise-base.ts`
//! (`franchiseBaseContradicts` e `franchiseExtensionContradicts`) e dos dois
//! helpers de `src/utils/release-name-matching.ts` que elas usam
//! (`nameCoverageTokens` e `isMultiWorkCollection`). As outras funções de
//! release-name-matching (`matchesName`, `franchiseRoot`, …) ficam para fatias
//! próprias.
//!
//! `own` é `None` quando o TS recebe `null`. Lista vazia é verdade em JS, então
//! `Some(&[])` é usada, e não cai no título.

use std::collections::HashSet;

use crate::matching_decisions::first_year_in;
use crate::matching_tokens::is_year_token;
use crate::matching_vocabulary::{
    leading_articles, pack_words, release_noise, strong_pack_words, title_tokens, year_range_test,
};

/// `EDITION_WORDS` de franchise-base.ts: palavras de edição do mesmo filme.
const EDITION_WORDS: &str =
    "unrated uncut remastered remaster directors director cut edition editions \
    theatrical anniversary criterion proper repack limited special final internal restored redux \
    colorized colorizado ultimate netflix";

/// `nameCoverageTokens`: tokens do nome sem duplicata. Descarta artigo e palavra
/// de até 2 unidades UTF-16, desde que sobrem 2 tokens longos; senão mantém
/// todos.
pub fn name_coverage_tokens(name: &str) -> Vec<String> {
    let all = title_tokens(name);
    let long: Vec<String> = all
        .iter()
        .filter(|w| w.encode_utf16().count() > 2 && !leading_articles().contains(w.as_str()))
        .cloned()
        .collect();
    let base = if long.len() >= 2 { long } else { all };
    let mut seen = HashSet::new();
    base.into_iter()
        .filter(|w| seen.insert(w.clone()))
        .collect()
}

/// `isMultiWorkCollection`: pack de coleção. Palavra forte basta; palavra
/// fraca só conta com faixa de anos no título cru.
pub fn is_multi_work_collection(title: &str) -> bool {
    let tokens = title_tokens(title);
    if tokens
        .iter()
        .any(|t| strong_pack_words().contains(t.as_str()))
    {
        return true;
    }
    if !year_range_test(title) {
        return false;
    }
    tokens.iter().any(|t| pack_words().contains(t.as_str()))
}

/// Tokens do título, ou os já calculados (`own`) quando o chamador os tem.
fn tokens_of(title: &str, own: Option<&[String]>) -> Vec<String> {
    match own {
        Some(tokens) => tokens.to_vec(),
        None => title_tokens(title),
    }
}

/// `franchiseBaseContradicts`: a obra-base de uma continuação nomeada por
/// subtítulo. Pede duas provas juntas: token do subtítulo ausente e um único
/// ano de release diferente do catálogo.
pub fn franchise_base_contradicts(
    title: &str,
    own: Option<&[String]>,
    name: &str,
    catalog_year: &str,
) -> bool {
    let catalog = first_year_in(catalog_year);
    if catalog == 0 {
        return false;
    }
    let tokens = tokens_of(title, own);
    let years: Vec<i64> = tokens
        .iter()
        .filter(|t| is_year_token(t))
        .filter_map(|t| t.parse().ok())
        .collect();
    if years.len() != 1 || years[0] == catalog {
        return false;
    }
    // Ano que é token do NOME ("Blade Runner 2049") não é ano de release.
    let wanted: Vec<String> = name_coverage_tokens(name)
        .into_iter()
        .filter(|w| !is_year_token(w))
        .collect();
    if !wanted.iter().any(|w| !tokens.contains(w)) {
        return false;
    }
    !is_multi_work_collection(title)
}

/// `franchiseExtensionContradicts`: a busca é pelo nome nu e a release traz um
/// subtítulo logo depois do nome, sem ano. Travas: título sem ano, palavra
/// seguinte de cara de subtítulo (3+ letras minúsculas ASCII), fora de ruído,
/// pack, edição e outros nomes da obra.
pub fn franchise_extension_contradicts(
    title: &str,
    own: Option<&[String]>,
    name: &str,
    all_names: &[String],
    catalog_year: &str,
) -> bool {
    if first_year_in(catalog_year) == 0 {
        return false;
    }
    let tokens = tokens_of(title, own);
    if tokens.iter().any(|t| is_year_token(t)) {
        return false;
    }
    let wanted = title_tokens(name);
    if wanted.is_empty() {
        return false;
    }
    let found = (0..tokens.len()).find(|&i| {
        wanted
            .iter()
            .enumerate()
            .all(|(j, w)| tokens.get(i + j) == Some(w))
    });
    let Some(at) = found else {
        return false;
    };
    let Some(next) = tokens.get(at + wanted.len()) else {
        return false;
    };
    let subtitle_like = next.len() >= 3 && next.bytes().all(|b| b.is_ascii_lowercase());
    if !subtitle_like {
        return false;
    }
    let edition: HashSet<&str> = EDITION_WORDS.split(' ').collect();
    if release_noise().contains(next.as_str())
        || pack_words().contains(next.as_str())
        || edition.contains(next.as_str())
    {
        return false;
    }
    if all_names
        .iter()
        .any(|n| title_tokens(n).iter().any(|t| t == next))
    {
        return false;
    }
    !is_multi_work_collection(title)
}
