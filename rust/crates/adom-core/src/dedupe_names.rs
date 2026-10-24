//! Porte de `dedupeNames` (`src/utils/title-normalization.ts`).
//!
//! Deduplica nomes de obra pela forma de `normalize_title`, preservando a
//! ordem e a primeira grafia. `None` é null/undefined do JS.

use std::collections::HashSet;

/// Nomes únicos pela forma normalizada, na ordem da primeira grafia.
///
/// Nome que normaliza para vazio (título só de pontuação) não entra no
/// conjunto de vistos: apagá-lo poderia esvaziar `names` e desligar o filtro
/// de título. Quem decide "sem nome" é o gate, não a deduplicação — o texto
/// original continua na lista, e uma repetição dele também.
pub fn dedupe_names(names: &[Option<&str>]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for name in names {
        // null/undefined e "" não são nome; o restante preserva a grafia.
        let Some(name) = *name else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let norm = crate::normalize_title(name);
        if !norm.is_empty() && seen.contains(&norm) {
            continue;
        }
        // Vazio não marca visto: "..." repetido permanece as duas vezes.
        if !norm.is_empty() {
            seen.insert(norm);
        }
        out.push(name.to_string());
    }
    out
}
