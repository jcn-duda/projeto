//! Porte de `catalogYearOf` e `catalogAltYearOf` (`src/utils/catalog-year.ts`).
//!
//! Cinemeta e TMDB às vezes divergem no ano do filme. Acima de 2 anos de
//! diferença, o TMDB (estreia mundial) vence; o ano descartado volta como
//! alternativo, porque as releases usam os dois. Os argumentos são texto ou
//! `None` (null/undefined); o JS trata `""` como falsy, e aqui também.

use crate::matching_decisions::first_year_in;

/// Ano escolhido entre Cinemeta (`meta`) e TMDB (`tmdb`). Devolve o próprio
/// texto de quem venceu, como o JS devolve o valor original.
pub fn catalog_year_of<'a>(meta: Option<&'a str>, tmdb: Option<&'a str>) -> Option<&'a str> {
    let m = first_year_in(meta.unwrap_or(""));
    let t = first_year_in(tmdb.unwrap_or(""));
    if m != 0 && t != 0 && (m - t).abs() > 2 {
        return tmdb;
    }
    truthy(meta).or_else(|| truthy(tmdb))
}

/// O ano que `catalog_year_of` descartou, quando as duas fontes divergem por
/// mais de 2 anos. `None` quando não há divergência ou falta um dos anos.
pub fn catalog_alt_year_of(meta: Option<&str>, tmdb: Option<&str>) -> Option<i64> {
    let chosen = catalog_year_of(meta, tmdb);
    // `chosen === tmdb` no JS: o outro ano é o que não foi escolhido.
    let other = if chosen == tmdb { meta } else { tmdb };
    let a = first_year_in(chosen.unwrap_or(""));
    let b = first_year_in(other.unwrap_or(""));
    (a != 0 && b != 0 && (a - b).abs() > 2).then_some(b)
}

/// Equivalente a `valor || ...` do JS: string vazia não conta como verdade.
fn truthy(v: Option<&str>) -> Option<&str> {
    v.filter(|s| !s.is_empty())
}
