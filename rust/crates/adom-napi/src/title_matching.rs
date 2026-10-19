//! Ponte NAPI do casamento de títulos: as funções puras que `release-title-rules.ts`,
//! `release-name-matching.ts`, `matching-tokens.ts`, `matching-vocabulary.ts`,
//! `multiwork-pack.ts`, `franchise-base.ts` e `tmdb-br-aliases.ts` expunham.
//!
//! A lógica é toda `adom-core` (com golden contra o TS do `esm`); aqui só há
//! conversão de tipos. Segue o padrão de `relevance.rs`: camelCase na fronteira
//! e `Option` → `undefined` (ausente), nunca sentinela.
//!
//! `matchesBrTitle` e `matchesName` NÃO estão aqui: já são exportados por
//! `lib.rs` desde as fatias anteriores e os módulos TS continuam chamando-os.
//!
//! Config fica do lado Node: `titlePrecisionTailCut` chega como `cutTail` em
//! cada função que mede precisão (`matchesBrTitle`, `matchesEpisodeWorkIdentity`,
//! `matchesGlobalSeriesNoMarker`, `titlePrecision`), como no core.

use adom_core::{
    adaptation_identity_contradicts, admits_multi_work_pack, collection_root,
    collection_root_tokens, contains_token_run, covers_year, ends_with_sequence_marker,
    episode_work_tokens, extract_sequence_markers, filter_br_aliases, first_significant_token,
    first_unmarked_token, first_work_token, franchise_base_contradicts,
    franchise_extension_contradicts, franchise_root, is_multi_work_collection, is_non_latin_token,
    is_non_naming_token, live_action_year_contradicts, matches_episode_work_identity,
    matches_global_series_no_marker, matches_short_name_identity, matches_title_structure,
    name_coverage_tokens, named_sequel_contradicts, normalized_title_tokens, pack_year_source,
    short_name_identity, title_precision, title_tokens, year_contradicts, Marker,
    ShortNameIdentity,
};
use napi_derive::napi;

/// Decisão de identidade de nome curto, com os três estados do TS:
/// `{kind:'skip'}`, `{kind:'no-token'}` e `{kind:'prefix', want, run}`.
///
/// `want`/`run` só existem em `prefix`; nos outros dois vêm `undefined`, que é
/// o "ausente" do contrato napi (mesma escolha de `relevance.rs`).
#[napi(object)]
pub struct ShortNameIdentityNapi {
    /// `'skip'`, `'no-token'` ou `'prefix'`.
    pub kind: String,
    /// Primeiro token latino que nomeia a obra (só em `prefix`).
    pub want: Option<String>,
    /// Sequência dos tokens que NOMEIAM a obra, na ordem do nome (só em `prefix`).
    pub run: Option<Vec<String>>,
    /// O nome numérico carrega `%` ("3%"): `percent` pode substituir o símbolo
    /// na posição do run. Ausente em todo nome sem símbolo.
    pub percent_spelling: Option<bool>,
}

/// `shortNameIdentity`: a decisão é do NOME e não muda entre itens.
#[napi(catch_unwind)]
pub fn short_name_identity_napi(name: String) -> ShortNameIdentityNapi {
    from_identity(short_name_identity(&name))
}

/// `matchesShortNameIdentity`: com base curta, a release precisa nomear a obra.
///
/// `check` é a decisão serializada por `shortNameIdentity` (quem filtra em lote
/// calcula uma vez por nome); `tokens` é o título já normalizado quando o
/// chamador o tem, e `dn` é o nome real do torrent (evidência alternativa).
#[napi(catch_unwind)]
pub fn matches_short_name_identity_napi(
    title: String,
    check: ShortNameIdentityNapi,
    tokens: Option<Vec<String>>,
    dn: String,
) -> bool {
    matches_short_name_identity(&title, &to_identity(check), tokens.as_deref(), &dn)
}

/// Traduz o objeto napi para o enum do core. `kind` desconhecido cai em `skip`
/// (o portão se cala), nunca em `prefix` — fail-open é o contrato do TS.
fn to_identity(value: ShortNameIdentityNapi) -> ShortNameIdentity {
    match value.kind.as_str() {
        "prefix" => ShortNameIdentity::Prefix {
            want: value.want.unwrap_or_default(),
            run: value.run.unwrap_or_default(),
            percent_spelling: value.percent_spelling.unwrap_or(false),
        },
        "no-token" => ShortNameIdentity::NoToken,
        _ => ShortNameIdentity::Skip,
    }
}

/// Traduz o enum do core para o objeto napi (só `prefix` carrega campos).
fn from_identity(value: ShortNameIdentity) -> ShortNameIdentityNapi {
    match value {
        ShortNameIdentity::Skip => ShortNameIdentityNapi {
            kind: "skip".to_string(),
            want: None,
            run: None,
            percent_spelling: None,
        },
        ShortNameIdentity::NoToken => ShortNameIdentityNapi {
            kind: "no-token".to_string(),
            want: None,
            run: None,
            percent_spelling: None,
        },
        ShortNameIdentity::Prefix {
            want,
            run,
            percent_spelling,
        } => ShortNameIdentityNapi {
            kind: "prefix".to_string(),
            want: Some(want),
            run: Some(run),
            percent_spelling: percent_spelling.then_some(true),
        },
    }
}

/// `matchesTitleStructure`: prefixo, sequência e ano. `year` vazio = sem ano.
#[napi(catch_unwind)]
pub fn matches_title_structure_napi(
    title: String,
    name: String,
    year: String,
    is_series: bool,
    tokens: Option<Vec<String>>,
) -> bool {
    matches_title_structure(&title, &name, &year, is_series, tokens.as_deref())
}

/// `matchesEpisodeWorkIdentity`: o trecho que o SxxEyy delimita pertence à obra.
#[napi(catch_unwind)]
pub fn matches_episode_work_identity_napi(
    title: String,
    all_names: Option<Vec<String>>,
    tokens: Option<Vec<String>>,
    universe_tokens: Option<Vec<String>>,
    cut_tail: bool,
) -> bool {
    matches_episode_work_identity(
        &title,
        all_names.as_deref(),
        tokens.as_deref(),
        universe_tokens.as_deref(),
        cut_tail,
    )
}

/// `matchesGlobalSeriesNoMarker`: filme/spin-off da franquia sem SxxEyy.
#[napi(catch_unwind)]
pub fn matches_global_series_no_marker_napi(
    title: String,
    tokens: Vec<String>,
    universe: Vec<String>,
    cut_tail: bool,
) -> bool {
    matches_global_series_no_marker(&title, &tokens, &universe, cut_tail)
}

// ---------------------------------------------------------------------------
// release-name-matching.ts
// ---------------------------------------------------------------------------

/// `nameCoverageTokens`: base da cobertura do nome (artigo e 1–2 letras fora
/// quando sobram dois tokens longos).
#[napi(catch_unwind)]
pub fn name_coverage_tokens_napi(name: String) -> Vec<String> {
    name_coverage_tokens(&name)
}

/// `isMultiWorkCollection`: pack de coleção (palavra forte, ou fraca + faixa).
#[napi(catch_unwind)]
pub fn is_multi_work_collection_napi(title: String) -> bool {
    is_multi_work_collection(&title)
}

/// `franchiseRoot`: raiz da franquia, sem subtítulo nem marcador de sequência.
#[napi(catch_unwind)]
pub fn franchise_root_napi(title: String) -> String {
    franchise_root(&title)
}

/// `endsWithSequenceMarker`: o título termina em "Parte II" / "2" / "III"?
#[napi(catch_unwind)]
pub fn ends_with_sequence_marker_napi(title: String) -> bool {
    ends_with_sequence_marker(&title)
}

/// `containsTokenRun`: a raiz aparece como sequência contígua de tokens.
#[napi(catch_unwind)]
pub fn contains_token_run_napi(title: String, normalized_root: String) -> bool {
    contains_token_run(&title, &normalized_root)
}

// ---------------------------------------------------------------------------
// matching-vocabulary.ts
// ---------------------------------------------------------------------------

/// `titleTokens`: tokens normalizados e não vazios de um título.
#[napi(catch_unwind)]
pub fn title_tokens_napi(text: String) -> Vec<String> {
    title_tokens(&text)
}

/// `normalizedTitleTokens`: tokens de um texto JÁ normalizado.
#[napi(catch_unwind)]
pub fn normalized_title_tokens_napi(normalized: String) -> Vec<String> {
    normalized_title_tokens(&normalized)
}

// ---------------------------------------------------------------------------
// matching-tokens.ts
// ---------------------------------------------------------------------------

/// `extractSequenceMarkers`: marcadores como texto (`"2"`, `"ressurge"`); o
/// lado Node reconstrói o `Set<number|string>` do TS.
#[napi(catch_unwind)]
pub fn extract_sequence_markers_napi(text: String) -> Vec<String> {
    extract_sequence_markers(&text)
        .iter()
        .map(Marker::as_text)
        .collect()
}

/// `titlePrecision`: quanto do título do candidato está DENTRO da busca.
#[napi(catch_unwind)]
pub fn title_precision_napi(tokens: Vec<String>, wanted: Vec<String>, cut_tail: bool) -> f64 {
    title_precision(&tokens, &wanted, cut_tail)
}

/// `episodeWorkTokens`: trecho que nomeia a obra; `undefined` sem SxxEyy.
#[napi(catch_unwind)]
pub fn episode_work_tokens_napi(tokens: Vec<String>) -> Option<Vec<String>> {
    episode_work_tokens(&tokens)
}

/// `yearContradicts`: o ano do título contradiz o do catálogo?
#[napi(catch_unwind)]
pub fn year_contradicts_napi(tokens: Vec<String>, year: String, is_series: bool) -> bool {
    year_contradicts(&tokens, &year, is_series)
}

/// `namedSequelContradicts`: sequela nomeada com ano exato diferente.
#[napi(catch_unwind)]
pub fn named_sequel_contradicts_napi(
    tokens: Vec<String>,
    universe: Vec<String>,
    catalog_year: String,
) -> bool {
    named_sequel_contradicts(&tokens, &universe, &catalog_year)
}

/// `liveActionYearContradicts`: "live action" + ano longe da estreia.
#[napi(catch_unwind)]
pub fn live_action_year_contradicts_napi(text: String, premiere_year: String) -> bool {
    live_action_year_contradicts(&text, &premiere_year)
}

/// `adaptationIdentityContradicts`: só série (`season` presente) e com as duas
/// provas de live action. `seasonPresent` é `request.season != null` no TS.
#[napi(catch_unwind)]
pub fn adaptation_identity_contradicts_napi(
    season_present: bool,
    text: String,
    year: String,
) -> bool {
    adaptation_identity_contradicts(season_present, &text, &year)
}

/// `firstSignificantToken`: primeiro token relevante (cai no `arr[0]`).
#[napi(catch_unwind)]
pub fn first_significant_token_napi(tokens: Vec<String>) -> Option<String> {
    first_significant_token(&tokens).map(str::to_owned)
}

/// `isNonNamingToken`: rótulo ou estrutura — não nomeia a obra.
#[napi(catch_unwind)]
pub fn is_non_naming_token_napi(token: String) -> bool {
    is_non_naming_token(&token)
}

/// `isNonLatinToken`: sem letra latina — título localizado ou outra marca.
#[napi(catch_unwind)]
pub fn is_non_latin_token_napi(token: String) -> bool {
    is_non_latin_token(&token)
}

/// `firstUnmarkedToken`: primeiro token que nomeia, em qualquer script.
#[napi(catch_unwind)]
pub fn first_unmarked_token_napi(tokens: Vec<String>) -> Option<String> {
    first_unmarked_token(&tokens).map(str::to_owned)
}

/// `firstWorkToken`: primeiro token LATINO que nomeia a obra.
#[napi(catch_unwind)]
pub fn first_work_token_napi(tokens: Vec<String>) -> Option<String> {
    first_work_token(&tokens).map(str::to_owned)
}

// ---------------------------------------------------------------------------
// franchise-base.ts
// ---------------------------------------------------------------------------

/// `franchiseBaseContradicts`: obra-base de continuação nomeada por subtítulo.
#[napi(catch_unwind)]
pub fn franchise_base_contradicts_napi(
    title: String,
    own: Option<Vec<String>>,
    name: String,
    catalog_year: String,
) -> bool {
    franchise_base_contradicts(&title, own.as_deref(), &name, &catalog_year)
}

/// `franchiseExtensionContradicts`: nome nu + subtítulo de outra obra, sem ano.
#[napi(catch_unwind)]
pub fn franchise_extension_contradicts_napi(
    title: String,
    own: Option<Vec<String>>,
    name: String,
    all_names: Vec<String>,
    catalog_year: String,
) -> bool {
    franchise_extension_contradicts(&title, own.as_deref(), &name, &all_names, &catalog_year)
}

// ---------------------------------------------------------------------------
// multiwork-pack.ts
// ---------------------------------------------------------------------------

/// `collectionRootTokens`: tokens da raiz da coleção (vazio = sem franquia).
#[napi(catch_unwind)]
pub fn collection_root_tokens_napi(name: String) -> Vec<String> {
    collection_root_tokens(&name)
}

/// `collectionRoot`: raiz da coleção como string normalizada, ou `""`.
#[napi(catch_unwind)]
pub fn collection_root_napi(name: String) -> String {
    collection_root(&name)
}

/// `coversYear`: o texto DECLARA cobertura do ano (faixa exata, avulso ±2).
#[napi(catch_unwind)]
pub fn covers_year_napi(text: String, catalog_year: String) -> bool {
    covers_year(&text, &catalog_year)
}

/// `packYearSource`: título + `dn=` decodificado quando o magnet é real.
#[napi(catch_unwind)]
pub fn pack_year_source_napi(title: String, magnet: String) -> String {
    pack_year_source(&title, &magnet)
}

/// `admitsMultiWorkPack`: as condições sem rede da admissão do pack multiobra.
#[napi(catch_unwind)]
pub fn admits_multi_work_pack_napi(
    title: String,
    magnet: String,
    multi_work_root: Option<String>,
    year: String,
    is_series: bool,
    names: Vec<String>,
) -> bool {
    admits_multi_work_pack(
        &title,
        &magnet,
        multi_work_root.as_deref(),
        &year,
        is_series,
        &names,
    )
}

// ---------------------------------------------------------------------------
// tmdb-br-aliases.ts
// ---------------------------------------------------------------------------

/// `filterBrAliases`: aliases BR que CONTÊM as palavras de um nome canônico.
#[napi(catch_unwind)]
pub fn filter_br_aliases_napi(
    candidates: Vec<Option<String>>,
    canonical: Vec<Option<String>>,
) -> Vec<String> {
    let candidates_ref: Vec<Option<&str>> = candidates.iter().map(|c| c.as_deref()).collect();
    let canonical_ref: Vec<Option<&str>> = canonical.iter().map(|c| c.as_deref()).collect();
    filter_br_aliases(&candidates_ref, &canonical_ref)
}

#[cfg(test)]
#[path = "title_matching_tests.rs"]
mod tests;
