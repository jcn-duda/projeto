//! Regra pura de elegibilidade para preencher buscas de uma temporada.
//!
//! Duas metades, ambas sem I/O:
//!
//! - o PREENCHIMENTO só vale para o buraco **declarado** pela obra. Temporada
//!   ausente (`None`) nunca vira S1: adivinhar a temporada faz o Chupim baixar
//!   o pack errado e, pior, invalidar buscas de outra temporada;
//! - o ÍNDICE LRU (`autofetch-season-index.ts`) de buscas por temporada que o
//!   pack pronto invalida. É índice de PROCESSO (rebuild no boot), sem
//!   persistência própria — por isso ele mora aqui e não no `NativeKv`.

use adom_core::is_season_pack_fill_eligible;

pub fn season_fill_eligible(title: &str, season: Option<i64>, is_pack: bool) -> bool {
    is_pack && is_season_pack_fill_eligible(title, season)
}

/// O buraco que a obra DECLAROU. `None` = nada declarado (filme, ou série sem
/// S/E na abertura) — e nada declarado não é S1.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SeasonGap {
    pub season: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeasonFillSkip {
    /// Toggle do Season Pack Fill desligado.
    Disabled,
    /// O release não é pack de temporada.
    NotPack,
    /// A obra não declarou temporada: NUNCA vira S1.
    NoDeclaredSeason,
    /// O pack não prova conter a temporada declarada.
    UndeclaredSeason,
    /// Sem título não há match de pack — não inventa.
    TitleUnproven,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeasonFill {
    Fill { season: i64 },
    Skip(SeasonFillSkip),
}

/// Decide se o pack preenche a busca. A ordem importa: o toggle e o tipo de
/// release vêm antes, e a temporada declarada vem antes do match de título —
/// sem buraco declarado não há o que preencher, por mais completo que o pack
/// pareça (o caso "Temporada Completa" sem número).
pub fn season_fill_decision(
    enabled: bool,
    title: &str,
    gap: SeasonGap,
    is_pack: bool,
) -> SeasonFill {
    if !enabled {
        return SeasonFill::Skip(SeasonFillSkip::Disabled);
    }
    if !is_pack {
        return SeasonFill::Skip(SeasonFillSkip::NotPack);
    }
    let Some(season) = gap.season else {
        return SeasonFill::Skip(SeasonFillSkip::NoDeclaredSeason);
    };
    if title.trim().is_empty() {
        return SeasonFill::Skip(SeasonFillSkip::TitleUnproven);
    }
    if !season_fill_eligible(title, Some(season), true) {
        return SeasonFill::Skip(SeasonFillSkip::UndeclaredSeason);
    }
    SeasonFill::Fill { season }
}

/// Índice LRU de buscas por temporada (`seasonSearchKeys` do Node).
///
/// A ordem do vetor É a ordem de inserção (LRU por temporada): registrar de
/// novo move a entrada para o fim, e o excesso sai pela frente.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SeasonIndex {
    entries: Vec<(String, Vec<String>)>,
}

impl SeasonIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// `seasonIndexKey(adapterId, account, imdbId, season)`.
    pub fn key(adapter_id: &str, account: &str, imdb_id: &str, season: i64) -> String {
        format!("{adapter_id}:{account}:{imdb_id}:{season}")
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Buscas registradas para a temporada, da mais antiga para a mais nova.
    pub fn keys_of(&self, key: &str) -> Option<&[String]> {
        self.entries
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, keys)| keys.as_slice())
    }

    /// `registerSeasonSearchKey` sem config/relógio: os limites vêm por
    /// parâmetro. Devolve `false` quando o registro nem aconteceu (toggle
    /// desligado ou teto de temporadas zero), para o chamador não anunciar
    /// invalidação que não existe.
    #[allow(clippy::too_many_arguments)]
    pub fn register(
        &mut self,
        enabled: bool,
        adapter_id: &str,
        account: &str,
        imdb_id: &str,
        season: i64,
        search_key: &str,
        max_seasons: usize,
        max_keys: usize,
    ) -> bool {
        if !enabled || max_seasons == 0 {
            return false;
        }
        let key = Self::key(adapter_id, account, imdb_id, season);
        let mut keys = match self
            .entries
            .iter()
            .position(|(existing, _)| existing == &key)
        {
            Some(index) => self.entries.remove(index).1,
            None => Vec::new(),
        };
        // Teto de buscas por temporada: sem o `check`, o mesmo par cheio
        // empurraria a mais antiga para fora antes de saber se ela já estava lá.
        let already = keys.iter().any(|existing| existing == search_key);
        if !already && keys.len() >= max_keys && !keys.is_empty() {
            keys.remove(0);
        }
        if !already {
            keys.push(search_key.to_string());
        }
        // Reinserção no fim = LRU por temporada (`Map` do Node preserva ordem).
        self.entries.push((key, keys));
        while self.entries.len() > max_seasons {
            self.entries.remove(0);
        }
        true
    }

    /// Invalidação do pack pronto: devolve e remove as buscas da temporada.
    pub fn take(&mut self, key: &str) -> Vec<String> {
        match self
            .entries
            .iter()
            .position(|(existing, _)| existing == key)
        {
            Some(index) => self.entries.remove(index).1,
            None => Vec::new(),
        }
    }
}

#[cfg(test)]
#[path = "season_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "season_index_tests.rs"]
mod index_tests;
