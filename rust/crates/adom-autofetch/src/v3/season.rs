//! Regra pura de elegibilidade para preencher buscas de uma temporada.

use adom_core::is_season_pack_fill_eligible;

pub fn season_fill_eligible(title: &str, season: Option<i64>, is_pack: bool) -> bool {
    is_pack && is_season_pack_fill_eligible(title, season)
}

#[cfg(test)]
#[path = "season_tests.rs"]
mod tests;
