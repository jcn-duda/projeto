//! Fatos da limpeza AllDebrid que moram no processo, para o `adom-search`
//! in-process (`DEBRID_AL_HOLDS`).
//!
//! O hold volátil do autofetch e o snapshot `knownBefore` eram lidos por uma
//! rota Node (`POST /internal/debrid/holds`), que saiu: quem calcula os fatos
//! agora é o próprio gateway (`adom-server::al_cleanup_facts`, a partir do KV
//! nativo e do inventário). Este módulo guarda só o que o seam e o `verdict`
//! precisam: [`HoldsFacts`] (com a regra fail-closed de cobertura), a flag
//! `DEBRID_AL_HOLDS` e o helper de conjuntos.
//!
//! `holds_complete` sozinho não é prova: [`HoldsFacts::covers`] exige que a
//! lista `evaluated` cubra TODOS os hashes do lote (e a conta bata com
//! `account_scope` da chave no seam). O `verdict` confere isso de novo antes de
//! montar o `CheckOpts`.
//!
//! Com a flag OFF não há feed: a limpeza nativa segue read-only.

use std::collections::HashSet;

/// Liga o feed in-process. Default do código OFF (o corte sobe ON): OFF é o
/// rollback de uma linha e a nativa segue read-only.
pub const ENV: &str = "DEBRID_AL_HOLDS";

/// Fatos da limpeza que o processo calcula para o lote desta busca.
///
/// `account` é o `sha256` da chave (mesma `accountScope` do Node) e `evaluated`
/// são os hashes do lote que a auditoria realmente avaliou por
/// `isHeld || isDurablyProtected`. Sem os dois, `holds_complete` não vale.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HoldsFacts {
    pub account: String,
    pub inventory_loaded: bool,
    pub known_before: Vec<String>,
    pub held: Vec<String>,
    pub evaluated: Vec<String>,
    pub holds_complete: bool,
    /// `None` = sem fato; vale o default do ambiente (como antes).
    pub drop_ready: Option<bool>,
    pub drop_uncached: Option<bool>,
}

impl HoldsFacts {
    /// O lote está COBERTO? Fail-closed: exige `holds_complete`, conta
    /// identificada e cada hash do lote presente em `evaluated`. Hash vazio no
    /// lote derruba a prova (não houve avaliação possível) e lote vazio não
    /// prova nada.
    pub fn covers(&self, hashes: &[String]) -> bool {
        if !self.holds_complete || self.account.trim().is_empty() {
            return false;
        }
        let evaluated: HashSet<String> = self
            .evaluated
            .iter()
            .map(|hash| hash.trim().to_lowercase())
            .collect();
        let mut seen = 0usize;
        for raw in hashes {
            let hash = raw.trim().to_lowercase();
            if hash.is_empty() || !evaluated.contains(&hash) {
                return false;
            }
            seen += 1;
        }
        seen > 0
    }

    /// Conjunto do inventário (`knownBefore`) em minúsculas, como o `CheckOpts`.
    pub fn known_before_set(&self) -> HashSet<String> {
        lower_set(&self.known_before)
    }

    /// Hashes protegidos pelo hold/`adprot` em minúsculas.
    pub fn held_set(&self) -> HashSet<String> {
        lower_set(&self.held)
    }
}

fn lower_set(items: &[String]) -> HashSet<String> {
    items
        .iter()
        .map(|item| item.trim().to_lowercase())
        .filter(|item| !item.is_empty())
        .collect()
}

/// `DEBRID_AL_HOLDS` (default do código OFF; o corte sobe ON). Mesmos apelidos
/// de `DEBRID_AL_CLEANUP`.
pub fn holds_feed_enabled() -> bool {
    std::env::var(ENV)
        .ok()
        .as_deref()
        .map(|raw| {
            matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "on" | "1" | "true" | "yes" | "rust"
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
#[path = "holds_feed_tests.rs"]
mod holds_feed_tests;
