//! Porte de `matchesBrTitle` de `src/utils/release-title-rules.ts`.
//!
//! `matchesBrTitle` é o filtro estrito de título para releases BR: os sites BR
//! são buscadores WordPress que devolvem posts "parecidos" para query curta, e
//! esta função é o portão que impede "Missão: Impossível – Efeito Fallout" de
//! ocupar a vaga do "Fallout" real.
//!
//! Depende de `matchesName` (portado em `release_name_matching`), `titlePrecision`
//! (em `matching_decisions`), `episodeWorkTokens` (em `matching_tokens`),
//! `matchesTitleStructure` (em `release_title_rules`) e `nameCoverageTokens`
//! (em `franchise`). A config `titlePrecisionTailCut` entra como parâmetro
//! (`cut_tail`), não como leitura de config global.
//!
//! Os pisos de precisão são constantes: `TITLE_PRECISION_MIN` (0.70 com
//! cutTail, 0.65 sem) e `SERIES_TITLE_PRECISION_MIN` (0.70 sempre). O TS
//! deriva `TITLE_PRECISION_MIN` de `config.search.titlePrecisionTailCut`; o
//! Rust recebe `cut_tail` do chamador e aplica a mesma regra.

use crate::matching_decisions::title_precision;
use crate::matching_tokens::episode_work_tokens;
use crate::matching_vocabulary::title_tokens;
use crate::release_name_matching::matches_name;
use crate::release_title_rules::matches_title_structure;

/// Piso de precisão para filme com `cut_tail=true` (default).
/// No TS: `config.search.titlePrecisionTailCut !== false ? 0.70 : 0.65`.
const TITLE_PRECISION_MIN_CUT: f64 = 0.70;

/// Piso de precisão para filme com `cut_tail=false`.
const TITLE_PRECISION_MIN_NO_CUT: f64 = 0.65;

/// Piso de precisão para série (independente de `cut_tail`).
/// No TS: `SERIES_TITLE_PRECISION_MIN = 0.70`.
const SERIES_TITLE_PRECISION_MIN: f64 = 0.70;

/// `matchesBrTitle`: filtro estrito de título para releases BR.
///
/// Três portões por cima do `matchesName`:
/// 1. **Prefixo**: o primeiro token relevante do título tem que ser o do nome
///    procurado (via `matchesName`, que exige 60% de cobertura dos tokens do
///    nome no título).
/// 2. **Precisão**: com `allNames`, mede quanto do título do candidato está
///    DENTRO do universo de nomes da obra. Release por episódio usa só o
///    trecho antes do SxxEyy (`episodeWorkTokens`). Série tem piso 0.70;
///    filme tem 0.70 com corte de cauda (default) ou 0.65 sem.
/// 3. **Estrutura**: prefixo, sequência e ano (`matchesTitleStructure`).
///
/// `year` é `""` quando o TS recebe `null`/`undefined`. `all_names` é `None`
/// quando o TS recebe `null`; lista vazia (`Some(&[])`) pula a checagem de
/// precisão (sem nomes para medir). `cut_tail` espelha
/// `config.search.titlePrecisionTailCut` (default `true`).
// Assinatura de 8 parâmetros é o contrato portado do TS (`title`, `name`,
// `year`, `isSeries`, `allNames`, `tokens`, `universeTokens`, `cutTail`):
// agrupá-los mudaria a chamada e a paridade do golden. O lint não vê o porquê.
#[allow(clippy::too_many_arguments)]
pub fn matches_br_title(
    title: &str,
    name: &str,
    year: &str,
    is_series: bool,
    all_names: Option<&[String]>,
    tokens: Option<&[String]>,
    universe_tokens: Option<&[String]>,
    cut_tail: bool,
) -> bool {
    // Portão 1: cobertura do nome (60% dos tokens do nome no título).
    if !matches_name(title, name, tokens) {
        return false;
    }

    let own: Vec<String> = match tokens {
        Some(t) => t.to_vec(),
        None => title_tokens(title),
    };

    // Portão 2: precisão de título. Só roda com `allNames` não vazio — a
    // release legítima carrega os DOIS nomes ("Coleção Guerra nas Estrelas
    // [Star Wars]"), e medir contra um só condenaria o outro como conteúdo
    // estranho. Sem a lista completa, quem chama não tem a informação.
    //
    // Release por episódio (SxxEyy explícito) usa só o trecho que nomeia a
    // obra (`episodeWorkTokens`): o nome do episódio depois do marcador não
    // pode contar como conteúdo estranho.
    if let Some(names) = all_names {
        if !names.is_empty() {
            let universe: Vec<String> = match universe_tokens {
                Some(u) => u.to_vec(),
                None => names
                    .iter()
                    .flat_map(|n| title_tokens(n))
                    .filter(|t| !t.is_empty())
                    .collect(),
            };
            let measured = episode_work_tokens(&own).unwrap_or(own.clone());
            let precision_min = if is_series {
                SERIES_TITLE_PRECISION_MIN
            } else if cut_tail {
                TITLE_PRECISION_MIN_CUT
            } else {
                TITLE_PRECISION_MIN_NO_CUT
            };
            if title_precision(&measured, &universe, cut_tail) < precision_min {
                return false;
            }
        }
    }

    // Portão 3: estrutura (prefixo, sequência, ano).
    matches_title_structure(title, name, year, is_series, Some(&own))
}
