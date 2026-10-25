//! Structs NAPI de entrada/saída do lote de autofetch.
//!
//! Separadas do `decide` para manter cada arquivo dentro do teto de linhas e
//! isolar o contrato de fronteira (o que cruza entre Node e Rust).
//!
//! Convenção de vazio: `None`/`""` chegam como ausentes, espelhando o `falsy`
//! do JS. Campos numéricos entram como `f64` (o `number` do JS) e são
//! truncados/validados na conversão (ver `super::convert`).

use napi_derive::napi;

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/// Um stream normalizado. `None`/`""` = campo ausente (o `falsy` do JS).
#[napi(object)]
pub struct AutofetchStreamIn {
    pub info_hash: Option<String>,
    pub title: Option<String>,
    pub name: Option<String>,
    /// `_quality` — resolução já resolvida; vazia cai no título.
    pub quality: Option<String>,
    /// `_seeders` — número puro; `None` vira 0 (br/any) ou cai no `👤` (seeds).
    pub seeders: Option<f64>,
    /// `_size` — tamanho do download em bytes.
    pub size_bytes: Option<f64>,
    /// `_packBytes` — tamanho total do pack.
    pub pack_bytes: Option<f64>,
    pub is_br: bool,
    pub is_dubbed: bool,
    pub is_dub_claim: bool,
    pub is_bank_dub: bool,
    pub is_lied: bool,
    /// Hash já toca no cache do debrid (alimenta só o diagnóstico, não os picks).
    pub is_cached: bool,
    pub from_fallback: bool,
    pub fallback_fetchable: bool,
    /// `isViableForEnqueue` pré-avaliado (o waiver do piso de seeders).
    pub viable: bool,
}

/// Opções dos pools + toggles do autofetch.
#[napi(object)]
pub struct PoolOptionsIn {
    pub season: Option<f64>,
    pub min_seeders: f64,
    pub pt_first: bool,
    pub auto_fetch_max: f64,
    pub queue_depth: f64,
    pub top_seeds_max: f64,
    pub rare_max: f64,
    pub rare_threshold: f64,
    pub rare_max_seeders: f64,
    /// Toggle do operador (`autoFetchBr`).
    pub auto_fetch_br: bool,
    /// `adapter.cacheCheck` já resolvido.
    pub adapter_cache_check: bool,
    /// `adapter.autofetchSource` já resolvido.
    pub adapter_autofetch_source: bool,
    pub any_dubbed: bool,
    pub top_seeds: bool,
    /// `seedsSelectionBlock(...) != null` pré-computado no Node (dubbed-only /
    /// lista P2P tocável / br-probe-pending): bloqueia o pool seeds PRIMÁRIO e
    /// o fallback seeds.
    pub seeds_blocked: bool,
}

/// Política do pool seeds (dubbedOnly / teto de tamanho / faixa máxima).
#[napi(object)]
pub struct SeedsPolicyIn {
    pub dubbed_only: bool,
    pub cached_only: bool,
    pub max_size_gb: f64,
    pub seeds_max_gb: f64,
    pub seeds_max_quality: String,
}

/// Estado dos 9 portões do enqueue (fatos medidos pelo runner).
#[napi(object)]
pub struct EnqueueGatesIn {
    pub is_paused: bool,
    pub is_dead: bool,
    pub is_cached: bool,
    pub marker_active: bool,
    pub lock_acquired: bool,
    pub slot_acquired: bool,
    pub obra_cap_granted: bool,
    pub account_blocked: bool,
    pub budget_granted: bool,
}

/// Entrada durável do registro da obra.
#[napi(object)]
pub struct ObraRecordIn {
    pub hash: String,
    pub pool: String,
    pub accepted_at: f64,
    pub title: Option<String>,
    pub br: bool,
    pub dubbed: bool,
    pub id: Option<String>,
    pub quality: Option<String>,
    pub overflow: bool,
}

/// Reserva volátil pendente (não persistida).
#[napi(object)]
pub struct PendingIn {
    pub id: String,
    pub pool: String,
    pub rare: bool,
    pub at: f64,
    pub hash: String,
    pub quality: Option<String>,
    pub overflow: bool,
}

/// Entrada completa do lote.
#[napi(object)]
pub struct AutofetchInput {
    pub streams: Vec<AutofetchStreamIn>,
    pub options: PoolOptionsIn,
    pub seeds_policy: SeedsPolicyIn,
    pub gates: EnqueueGatesIn,
    pub obra_entries: Vec<ObraRecordIn>,
    pub pending_reservations: Vec<PendingIn>,
}

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

/// Candidato do pool para enqueue imediato.
#[napi(object)]
pub struct AutofetchCandidateOut {
    pub info_hash: String,
    pub pool: String,
    pub rare: bool,
    pub slot_limit: Option<i64>,
}

/// Candidato da fila persistente.
#[napi(object)]
pub struct QueueCandidateOut {
    pub info_hash: String,
    pub pool: String,
    pub rare: bool,
    pub slot_limit: Option<i64>,
}

/// Desistência de um imediato: motivo + o que o rollback precisa liberar.
#[napi(object)]
pub struct SkipOut {
    pub reason: String,
    pub rollback: Vec<String>,
    pub info_hash: String,
}

/// Resultado bruto do `pick_seeds_pool`.
#[napi(object)]
pub struct SeedsResultOut {
    pub candidates: Vec<i64>,
    pub immediate_limit: i64,
    pub rare_used: bool,
}

/// Estado combinado do teto por obra (registro + reservas vivas).
#[napi(object)]
pub struct ObraStatusOut {
    pub br: i64,
    pub any: i64,
    pub seeds: i64,
    pub total: i64,
    pub view_len: i64,
}

/// Rastreio resumido da decisão.
#[napi(object)]
pub struct TraceOut {
    pub pool: String,
    pub seeds_count: i64,
    pub immediate_count: i64,
    pub queue_count: i64,
    pub skip_count: i64,
    pub disabled: bool,
    pub labels: Vec<String>,
}

/// Decisão completa do lote.
#[napi(object)]
pub struct AutofetchDecision {
    pub immediates: Vec<AutofetchCandidateOut>,
    pub queue: Vec<QueueCandidateOut>,
    pub skips: Vec<SkipOut>,
    pub seeds_result: SeedsResultOut,
    pub obra_status: ObraStatusOut,
    pub trace: TraceOut,
}

// ---------------------------------------------------------------------------
// Regras puras AVULSAS (bindings de `super::rules`)
// ---------------------------------------------------------------------------
//
// Cada uma espelha um tipo do `adom-core` que a régua avulsa lê ou devolve.
// Ficam aqui pela mesma razão do lote: fronteira num arquivo só, longe da
// decisão.

/// Registro da obra visto pelo overflow do teto (só `pool`/`quality`/`overflow`).
#[napi(object)]
pub struct ObraOverflowEntryIn {
    pub pool: String,
    pub quality: String,
    pub overflow: bool,
}

/// Fatos medidos do `expired-unready` (a guarda de posse decide sobre eles).
#[napi(object)]
pub struct ExpiredFactsIn {
    pub hash_empty: bool,
    pub is_cleanup_protected: bool,
    pub adapter_is_alldebrid: bool,
    pub has_marker: bool,
    pub has_adsub: bool,
    pub has_snapshot: bool,
    pub in_snapshot: bool,
}

/// Lote de progresso de UM adapter+conta.
#[napi(object)]
pub struct ProgressLotIn {
    pub adapter_id: String,
    pub account: String,
    pub hashes: Vec<String>,
    /// `autoFetchStallStreak`; `<= 0` desliga a derivação.
    pub threshold: f64,
}

/// Progresso medido de uma transferência.
#[napi(object)]
pub struct TorrentProgressIn {
    pub bytes: f64,
    pub total: f64,
    pub speed: f64,
    pub seeders: f64,
}

/// Status de UM hash na passagem (`id` chega como `string | number` no TS; a
/// casca normaliza para texto antes da fronteira).
#[napi(object)]
pub struct TorrentStatusIn {
    pub state: String,
    pub id: Option<String>,
    pub progress: Option<TorrentProgressIn>,
}

/// Um par `hash -> status` — o `Record` do TS vira lista na fronteira.
#[napi(object)]
pub struct TorrentStatusPairIn {
    pub hash: String,
    pub status: TorrentStatusIn,
}

/// Resultado de uma passagem de progresso.
#[napi(object)]
pub struct ProgressDerivationOut {
    pub stalled: Vec<String>,
    pub signals: i64,
}

/// Entrada da fila persistente (índice no array de streams do chamador).
#[napi(object)]
pub struct QueueEntryIn {
    pub index: f64,
    pub pool: String,
    pub rare: bool,
    pub slot_limit: Option<f64>,
}

/// Candidato do fallback (`pool` = `any` | `seeds`).
#[napi(object)]
pub struct FallbackPickIn {
    pub index: f64,
    pub pool: String,
    pub rare: bool,
    pub slot_limit: Option<f64>,
}

/// Entrada da fila já composta.
#[napi(object)]
pub struct QueueEntryOut {
    pub index: i64,
    pub pool: String,
    pub rare: bool,
    pub slot_limit: Option<i64>,
}

/// Opções do `toQueueCandidate`.
#[napi(object)]
pub struct QueueCandidateOptsIn {
    pub imdb_id: Option<String>,
    pub season: Option<f64>,
    pub episode: Option<f64>,
    pub season_fill: bool,
    pub rare: bool,
    pub slot_limit: Option<f64>,
    pub size_bytes: Option<f64>,
}

/// Candidato persistido da fila (o `QueueCandidate` do núcleo).
#[napi(object)]
pub struct QueueCandidateRuleOut {
    pub info_hash: String,
    pub name: Option<String>,
    pub title: Option<String>,
    pub quality: Option<String>,
    pub size: Option<f64>,
    pub seeders: Option<i64>,
    pub br: bool,
    pub dubbed: bool,
    pub bank_dub: bool,
    pub lied: bool,
    pub pool: String,
    pub imdb_id: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub is_pack: bool,
    pub probe_season: Option<i64>,
    pub probe_episode: Option<i64>,
    pub rare: bool,
    pub slot_limit: Option<i64>,
}

/// Config viva da seleção seeds.
#[napi(object)]
pub struct SeedsLiveIn {
    pub min_seeders: f64,
    pub top_seeds_max: f64,
    pub pt_first: bool,
}

/// Regime raro da seleção seeds.
#[napi(object)]
pub struct SeedsRareIn {
    pub max: f64,
    pub threshold: f64,
    pub max_seeders: f64,
}

/// Opções da seleção seeds.
#[napi(object)]
pub struct SeedsOptsIn {
    pub season: Option<f64>,
    pub queue_depth: f64,
    pub rare: SeedsRareIn,
}

/// Universo do pool seeds: streams já elegíveis + hashes viáveis (minúsculos).
#[napi(object)]
pub struct SeedsPoolInput {
    pub streams: Vec<AutofetchStreamIn>,
    pub live: SeedsLiveIn,
    pub opts: SeedsOptsIn,
    pub viable_hashes: Vec<String>,
}
