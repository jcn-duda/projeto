//! Bindings NAPI-RS do `adom-core`.
//!
//! Este módulo expõe funções Rust críticas para o Node via NAPI. Cada função
//! pública é anotada com `#[napi]` para gerar automaticamente o binding C-ABI
//! e o `.d.ts` correspondente.
//!
//! ## Funções expostas
//!
//! | NAPI                      | `adom-core`                | Propósito                           |
//! |---------------------------|----------------------------|-------------------------------------|
//! | `normalizeTitle`          | `normalize_title`          | Normalização de títulos             |
//! | `signResolve`             | `sign_resolve`             | Assina URLs de /resolve             |
//! | `verifyResolve`           | `verify_resolve`           | Verifica assinaturas de /resolve    |
//! | `matchesBrTitle`          | `matches_br_title`         | Filtro estrito BR de título         |
//! | `parseTitleSeasonEpisode` | `parse_title_season_episode`| Parse de S/E do título da release  |
//! | `matchesName`             | `matches_name`             | Portão de cobertura de nome         |
//! | `sanitizeMagnet`          | `sanitize_magnet`          | Valida/limpa URI magnet             |
//! | `defaultMagnet`           | `default_magnet`           | Magnet padrão com trackers do piso  |
//! | `extractInfoHash`         | `extract_info_hash`        | Extrai infoHash (hex/base32/btih)   |
//! | `magnetDisplayName`       | `magnet_display_name`      | Nome da release no dn= do magnet    |
//! | `brOriginMark`            | `br_origin_mark`           | Origem BR (site/PT/filme)           |
//! | `decodeEntities`          | `decode_entities`          | Entidades HTML                      |
//! | `bytesToSize`             | `bytes_to_size`            | Tamanho legível                     |
//! | `stripDiacritics`         | `strip_diacritics`         | Diacríticos fora, caixa preservada  |
//! | `collapseAcronyms`        | `collapse_acronyms`        | Sigla pontuada vira palavra         |
//! | `dedupeNames`             | `dedupe_names`             | Dedupe de nomes por forma normal    |
//! | `hasPtSigns`              | `has_pt_signs`             | Sinais de português no título       |
//! | `limitByIndexer`          | `limit_by_indexer`         | Cota por indexador                  |
//! | `pickFile`                | `pick_file`                | Seletor de arquivo do debrid        |
//! | `debridCacheVerdict`      | `debrid_cache_verdict`     | Veredito known/unusable do cache    |
//! | `debridCacheCheckHonest`  | `debrid_cache_check_honest`| Flag cacheCheck do adaptador        |
//! | `debridRdNextHit`         | `debrid_rd_next_hit`       | Próximo estado do ledger RD         |
//! | `debridMayDelete`         | `may_delete`               | Pode apagar este hash da conta      |
//! | `cacheQuotaFor`           | `cache_quotas::quota_for`  | Cota de um namespace do cache       |
//! | `cacheNamespaceFor`       | `cache_quotas::namespace_for`| Namespace de uma chave            |
//! | `cacheQuotasDump`         | `cache_quotas` (tabela)    | Contrato inteiro das cotas em JSON  |
//! | `releaseIndexMediaMerge`  | `merge_media_source`       | Fonte de mídia do índice            |
//! | `evaluateAutofetchCandidates` | módulos `autofetch_*`  | Lote da seleção de candidatos       |
//!
//! ## Responsabilidade
//!
//! Este crate SÓ faz wrapping. Lógica real vive em `adom-core`. Funções que
//! dependem de segredo (sign/verify) recebem o segredo como parâmetro — o
//! lado Node é responsável por fornecê-lo via `config`/`runtime`.

use std::collections::{HashMap, HashSet};

use napi_derive::napi;

mod audio;
mod autofetch;
// Fim da busca, via do banco, saída do play e corte final: decisões puras que
// o TS deixou de decidir (as cascas chamam estas pontes).
mod bank;
mod cache;
mod catalog;
mod idx_store;
pub use idx_store::{BankRowInput, IdxStore, RecordOptionsInput};
mod crawl;
mod debrid;
mod debrid_cache;
mod debrid_clean;
mod debrid_rd;
mod episode_filter;
mod episode_matching;
mod episode_size;
mod finish;
mod play;
mod stream_final;
// Pré-resolve do protetor BR em lote: fronteira de `jackett-resolve.ts`.
mod pre_resolve;
// Recuperação de DUAL global pelo título pt do TMDB (`ptTitleDual`): o TS só
// transporta; a régua mora no `adom-core`.
mod pt_title_dual;
mod quotas;
mod ranking;
mod release_index_media;
mod relevance;
// Orquestração pura de busca: plano do Jackett, orçamento da coleta e cobertura
// por pool (espelha `search-plan` / `collection-budget` / `search-pool-coverage`).
mod search;
mod text;
// Casamento de títulos: fronteira fina de release-title-rules/name-matching/
// matching-tokens/matching-vocabulary/multiwork-pack/franchise-base/tmdb-br-aliases.
mod title_matching;

// Lote do autofetch (Chupim): reexporta para o `#[napi]` não ser marcado morto.
pub use autofetch::*;
// Decisões que o TS só transporta: fim da busca, via do banco, play e corte final.
pub use bank::*;
pub use catalog::*;
pub use finish::*;
pub use play::*;
pub use stream_final::*;
// Áudio e origem BR pelo título: fronteira de `audio-quality`/`audio-cleanup`.
pub use audio::*;
pub use cache::*;
pub use crawl::*;
// Reexporta o seletor: sem isto o clippy marca `#[napi]` do módulo privado como morto.
pub use debrid::*;
pub use debrid_cache::*;
pub use debrid_clean::*;
pub use debrid_rd::*;
// Filtro de episódio/temporada em lote: só índices saem pela fronteira.
pub use episode_filter::*;
// Matching de episódio/pack: fronteira fina de `episode-matching.ts`.
pub use episode_matching::*;
// Ranking de streams e anotação de tamanho: lote da Parte 7 da migração.
pub use episode_size::*;
// Pré-resolve do protetor BR em lote: só índices aprovados saem pela fronteira.
pub use pre_resolve::*;
pub use pt_title_dual::*;
pub use ranking::*;
// Filtro de relevância inteiro no núcleo: só índices saem pela fronteira.
pub use release_index_media::*;
pub use relevance::*;
// Plano/orçamento/cobertura: a casca TS só transporta.
pub use search::*;
// Texto de magnet e título: fronteira fina de `title-normalization.ts`.
pub use text::*;
// Casamento de títulos: fronteira fina do `src/utils/release-*matching|title-rules`.
pub use title_matching::*;

// ---------------------------------------------------------------------------
// Structs de saída (espelham os tipos do adom-core com campos NAPI-compatible)
// ---------------------------------------------------------------------------

/// Resultado do parse de temporada/episódio no título da release.
///
/// Espelha `adom_core::ParsedSeasonEpisode` com tipos compatíveis com NAPI.
/// O `#[napi(object)]` gera a interface TypeScript automaticamente.
#[napi(object)]
pub struct ParsedSeasonEpisode {
    /// Temporadas encontradas (ex: `[1, 2]` para "S01-S02").
    pub seasons: Vec<i64>,
    /// Episódios encontrados (ex: `[1, 2, 3]` para "E01-E03").
    pub episodes: Vec<i64>,
    /// `true` quando o título indica série completa ("todas as temporadas").
    pub complete: bool,
    /// `true` quando é pack de temporada ("temporada completa").
    pub season_pack: bool,
}

// ---------------------------------------------------------------------------
// Wrappers NAPI — delegam ao adom-core, convertendo tipos na fronteira.
// ---------------------------------------------------------------------------

/// Normaliza um título de obra (paridade com o TS `normalizeTitle`).
///
/// Expõe `adom_core::normalize_title` para o Node. A função Rust já tem todos
/// os testes de paridade com o golden, então o wrapper só repassa.
///
/// # Exemplo (Node)
///
/// ```js
/// import { normalizeTitle } from '../rust/adom-napi/index.js';
/// const normalized = normalizeTitle('Star Wars: The Clone Wars');
/// ```
#[napi(catch_unwind)]
pub fn normalize_title(title: String) -> String {
    adom_core::normalize_title(&title)
}

/// Assina uma URL de /resolve com HMAC-SHA256.
///
/// Delega ao `adom_core::sign_resolve` — a lógica criptográfica (payload,
/// ordem de chaves, chave vazia) vive lá, com golden e testes de paridade.
///
/// ## Parâmetros
///
/// - `secret`: segredo HMAC (vem de `config.debrid.resolveSecret` ou
///   `opts().debridApiKey`).
/// - `info_hash`: hash do torrent (ID público do indexer).
/// - `ep`: episódio (string vazia se não aplicável).
/// - `hint`: dica de obra em JSON (string vazia se não houver).
///
/// ## Retorno
///
/// Hex do HMAC-SHA256. String vazia se `secret` for vazio.
#[napi(catch_unwind)]
pub fn sign_resolve(secret: String, info_hash: String, ep: String, hint: String) -> String {
    adom_core::sign_resolve(&info_hash, &ep, &hint, &secret)
}

/// Verifica uma assinatura de /resolve em tempo constante.
///
/// Delega ao `adom_core::verify_resolve` — a comparação constant-time e as
/// guardas (chave vazia, sig ausente, uppercase) vivem lá.
///
/// ## Parâmetros
///
/// - `secret`: segredo HMAC (mesmo de `sign_resolve`).
/// - `info_hash`: hash do torrent.
/// - `ep`: episódio.
/// - `sig`: assinatura a verificar (hex).
/// - `hint`: dica de obra (mesma de `sign_resolve`).
///
/// ## Retorno
///
/// `true` se a assinatura for válida. `false` otherwise.
#[napi(catch_unwind)]
pub fn verify_resolve(
    secret: String,
    info_hash: String,
    ep: String,
    sig: String,
    hint: String,
) -> bool {
    adom_core::verify_resolve(&info_hash, &ep, Some(&sig), &hint, &secret)
}

/// Filtro estrito de título para releases BR.
///
/// Delega ao `adom_core::matches_br_title`. Três portões: cobertura do nome
/// (60% dos tokens), precisão de título (piso 0.70/0.65) e estrutura (prefixo,
/// sequência, ano).
///
/// ## Parâmetros
///
/// - `title`: título da release (normalizado pelo caller ou cru).
/// - `name`: nome da obra procurada.
/// - `year`: ano da obra (string vazia quando não há).
/// - `is_series`: `true` para série, `false` para filme.
/// - `all_names`: todos os nomes da obra (`None` pula precisão).
/// - `tokens`: tokens do título já calculados (`None` recalcula).
/// - `universe_tokens`: tokens do universo de nomes (`None` recalcula).
/// - `cut_tail`: espelha `config.search.titlePrecisionTailCut`.
// A binding espelha 1:1 o contrato portado do core (8 parâmetros); agrupá-los
// mudaria a assinatura exposta ao Node. O lint não vê o porquê.
#[allow(clippy::too_many_arguments)]
#[napi(catch_unwind)]
pub fn matches_br_title(
    title: String,
    name: String,
    year: String,
    is_series: bool,
    all_names: Option<Vec<String>>,
    tokens: Option<Vec<String>>,
    universe_tokens: Option<Vec<String>>,
    cut_tail: bool,
) -> bool {
    adom_core::matches_br_title(
        &title,
        &name,
        &year,
        is_series,
        all_names.as_deref(),
        tokens.as_deref(),
        universe_tokens.as_deref(),
        cut_tail,
    )
}

/// Extrai temporada e episódio do título da release.
///
/// Delega ao `adom_core::parse_title_season_episode`. Cobre padrões como
/// "S01E04", "1x04", "T01E004" (BR), ordinais por extenso, faixas e packs.
///
/// ## Retorno
///
/// Objeto `ParsedSeasonEpisode` com `seasons`, `episodes`, `complete` e
/// `season_pack`.
#[napi(catch_unwind)]
pub fn parse_title_season_episode(title: String) -> ParsedSeasonEpisode {
    let core = adom_core::parse_title_season_episode(&title);
    ParsedSeasonEpisode {
        seasons: core.seasons,
        episodes: core.episodes,
        complete: core.complete,
        season_pack: core.season_pack,
    }
}

/// Portão de cobertura de nome: 60% dos tokens do nome no título.
///
/// Delega ao `adom_core::matches_name`. `tokens` é o conjunto já calculado
/// (quando o chamador tem); `None` recalcula a partir do título.
#[napi(catch_unwind)]
pub fn matches_name(title: String, name: String, tokens: Option<Vec<String>>) -> bool {
    adom_core::matches_name(&title, &name, tokens.as_deref())
}

/// Valida e limpa uma URI magnet, devolvendo `None` quando é inválida ou
/// equivalente ao magnet padrão.
///
/// Delega ao `adom_core::sanitize_magnet`. Remove trackers com credencial,
/// deduplica e respeita o teto de 2048 bytes.
///
/// ## Parâmetros
///
/// - `uri`: URI magnet crua (`None` ou vazia → `None`).
/// - `info_hash`: hash esperado do torrent.
#[napi(catch_unwind)]
pub fn sanitize_magnet(uri: Option<String>, info_hash: String) -> Option<String> {
    adom_core::sanitize_magnet(uri.as_deref(), &info_hash)
}

/// Magnet padrão para um infoHash, com os trackers do piso.
///
/// Delega ao `adom_core::default_magnet`.
#[napi(catch_unwind)]
pub fn default_magnet(info_hash: String) -> String {
    adom_core::default_magnet(&info_hash)
}

/// Extrai o infoHash (hex minúsculo) de uma string.
///
/// Delega ao `adom_core::extract_info_hash`. Aceita hex (40), base32 (32) ou
/// trecho `btih:<hash>`. Devolve `None` quando não reconhece.
#[napi(catch_unwind)]
pub fn extract_info_hash(input: String) -> Option<String> {
    adom_core::extract_info_hash(&input)
}

/// Origem BR pelo nome: marca de site, palavra "filme(s)" ou sinais de PT.
///
/// Delega ao `adom_core::br_origin_mark`. Usado para NÃO apagar acervo BR
/// na limpeza da conta.
#[napi(catch_unwind)]
pub fn br_origin_mark(title: String) -> bool {
    adom_core::br_origin_mark(&title)
}

/// Sinais de português no título (acentos, vocabulário, preposições, marca BR).
///
/// Delega ao `adom_core::has_pt_signs`.
#[napi(catch_unwind)]
pub fn has_pt_signs(title: String) -> bool {
    adom_core::has_pt_signs(&title)
}

/// Cota por indexador: devolve os índices que passam na cota.
///
/// Delega ao `adom_core::limit_by_indexer`. Converte tipos na fronteira:
/// - `indexers`: `Vec<Option<String>>` → `&[Option<&str>]`
/// - `exempt`: `Vec<u32>` → `HashSet<usize>`
/// - retorno: `Vec<usize>` → `Vec<u32>`
///
/// ## Parâmetros
///
/// - `indexers`: nome do indexador de cada stream (None = sem indexador).
/// - `max_per_indexer`: cota global (`0` = sem limite).
/// - `exempt`: índices de vagas reservadas BR (passam mesmo acima da cota).
/// - `indexer_limits`: cota específica por indexador (chave em minúsculas).
#[napi(catch_unwind)]
pub fn limit_by_indexer(
    indexers: Vec<Option<String>>,
    max_per_indexer: f64,
    exempt: Vec<u32>,
    indexer_limits: HashMap<String, f64>,
) -> Vec<u32> {
    let refs: Vec<Option<&str>> = indexers.iter().map(|opt| opt.as_deref()).collect();
    let exempt_set: HashSet<usize> = exempt.iter().map(|&i| i as usize).collect();
    adom_core::limit_by_indexer(&refs, max_per_indexer, &exempt_set, &indexer_limits)
        .into_iter()
        .map(|i| i as u32)
        .collect()
}
