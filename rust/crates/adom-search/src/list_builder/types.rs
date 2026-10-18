//! Tipos do BUILD da lista — porte da orquestração de `stream-builder.ts` +
//! `stream-builder-pipeline.ts` (oráculo: branch `esm`).
//!
//! A sequência do TS vai dos ITENS CRUS (saída da janela de coleta) até a
//! LISTA FINAL: filtro de título → pack multiobra → episódio → sortAndLimit
//! (pool ampliado, cotas) → 💾 de episódio → applyDebrid (AQUI só a
//! dependência injetada [`DebridCheck`]) → limitReservingBr → aviso se vazia.
//! As RÉGUAS moram no `adom-core`; este módulo só orquestra a ordem e o estado.
//!
//! Invariantes que este porte carrega:
//!
//! - **origem BR é campo** (`RawItem::is_br`); `looks_pt_br` também liga;
//! - **piso de seeders não corta antes da checagem de debrid**
//!   (`seedFloorFor`: cachedOnly + cacheCheck honesto + chave ⇒ piso 0);
//! - **corte BR depois do pool ampliado** (`limit_reserving_br` do núcleo
//!   roda SÓ no fim, pós-debrid);
//! - **config do usuário nunca hardcoded**: [`BuildOptions`] carrega todos os
//!   números; `Default` replica os defaults do operador para os testes.
//! - **host nunca entra na lista**: avisos e `/resolve` nascem RELATIVOS; o
//!   host é montado na resposta por [`apply_notice_origin`].

use std::collections::{BTreeMap, HashMap};

use adom_core::{QualityLimits, RankingStream};
use serde_json::Value;

// ── Dependência injetada: a checagem de debrid ──────────────────────────────

/// Resposta de UMA checagem (porte do veredito de `applyDebrid`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DebridAnswer {
    /// ⚡ pronto. `url` é o `/resolve/...` RELATIVO (sem host); `None` = pronto
    /// mas sem link montado nesta fatia (o play decide depois).
    Cached { url: Option<String> },
    /// Conferido e NÃO está em cache: `cachedOnly` corta, resto fica P2P.
    Missing,
    /// `known:false` — ninguém perguntou de verdade: lista passa sem ⚡ e o
    /// passe tardio refaz (`debrid_known` NÃO vira `true`).
    Unknown,
    /// `unusable` (auth/quota): lista volta como P2P, sem autofetch.
    Unusable,
}

/// Quem constrói a lista recebe a checagem AQUI, injetada. A implementação
/// real (`AdapterDebridCheck`) faz UM lote por busca via [`Self::prepare`];
/// testes usam stub.
pub trait DebridCheck {
    fn check(&mut self, stream: &RankingStream) -> DebridAnswer;

    /// Pré-aquece o lote de hashes (default: no-op). Chamar UMA vez antes do
    /// laço de streams evita N uploads no AllDebrid.
    fn prepare(&mut self, _hashes: &[String]) {}
}

// ── Config (do usuário, via URL; nunca do `.env` no caminho de busca) ───────

/// Números que o TS lia de `config`/`opts()` dentro do construtor. Defaults =
/// os defaults do operador (`src/config/search.ts`); a instância real vem do
/// caller, que decodificou a config do usuário da URL.
#[derive(Debug, Clone)]
pub struct BuildOptions {
    /// `maxResults`.
    pub max_results: f64,
    /// Pool ampliado pré-debrid: `max_results * candidatePoolFactor`.
    pub candidate_pool_factor: f64,
    /// `minSeeders` (piso cru; pode ser zerado pelo seedFloorFor abaixo).
    pub min_seeders: f64,
    /// `SEARCH_CACHED_ONLY_IGNORES_SEEDS`.
    pub cached_only_ignores_seeds: bool,
    /// `qualities` (filtro de qualidade).
    pub qualities: Vec<String>,
    pub prefer_dubbed: bool,
    pub dubbed_only: bool,
    pub exclude_cam: bool,
    pub max_size_gb: f64,
    /// Teto por qualidade (`max2160p`…`maxUnknown`), já normalizado.
    pub quality_limits: QualityLimits,
    /// Vagas BR garantidas no corte final.
    pub br_reserved_slots: f64,
    /// Vagas BR POR FAIXA de qualidade (reserva de faixa).
    pub br_reserved_per_quality: f64,
    pub br_only: bool,
    pub br_first: bool,
    /// Teto por indexer (global).
    pub max_per_indexer: f64,
    /// Teto por indexer id (`indexerLimits`).
    pub indexer_limits: QualityLimits,
    /// Prioridade de indexer (ids já validados).
    pub indexer_priority: Vec<String>,
    /// `config.search.noticeStream`.
    pub notice_stream: bool,
    /// `SEARCH_UNAIRED_MARGIN_MS` (24h).
    pub unaired_margin_ms: i64,
    /// `SEARCH_PREAIR_RELEASE_MARGIN_MS` (48h).
    pub pre_air_margin_ms: i64,
    /// `config.search.preHomeReleaseCut` + margem (a data vem injetada).
    pub pre_home_release_cut: bool,
    pub pre_home_release_margin_ms: i64,
    /// `config.search.titlePrecisionTailCut` (default `true`).
    pub title_precision_tail_cut: bool,
}

impl Default for BuildOptions {
    fn default() -> Self {
        BuildOptions {
            max_results: 40.0,
            candidate_pool_factor: 2.0,
            min_seeders: 0.0,
            cached_only_ignores_seeds: true,
            qualities: Vec::new(),
            prefer_dubbed: false,
            dubbed_only: false,
            exclude_cam: false,
            max_size_gb: 0.0,
            quality_limits: QualityLimits::default(),
            br_reserved_slots: 0.0,
            br_reserved_per_quality: 0.0,
            br_only: false,
            br_first: true,
            max_per_indexer: 0.0,
            indexer_limits: QualityLimits::default(),
            indexer_priority: Vec::new(),
            notice_stream: true,
            unaired_margin_ms: 24 * 60 * 60 * 1000,
            pre_air_margin_ms: 48 * 60 * 60 * 1000,
            pre_home_release_cut: false,
            pre_home_release_margin_ms: 0,
            title_precision_tail_cut: true,
        }
    }
}

/// Contexto da obra + injeções de I/O que o TS lia de bancos (a busca nativa
/// recebe tudo pronto; NADA de rede aqui).
#[derive(Debug, Clone, Default)]
pub struct BuildContext {
    /// Nomes da obra (aliases já resolvidos — `resolveSearchNames`).
    pub names: Vec<String>,
    /// Ano de catálogo como texto (`String(year ?? '')`, sujo "2024–" vale).
    pub year: String,
    /// Ano dual (Monster).
    pub alt_year: Option<String>,
    /// Raiz da coleção multiobra (opt-in TMDB), quando há.
    pub multi_work_root: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub is_demo: bool,
    /// `debrid.current() != null` — há adapter para escolher arquivo em pack.
    pub debrid_available: bool,
    /// `adapter.cacheCheck` — o debrid diz o que está pronto?
    pub debrid_cache_check_honest: bool,
    /// Há chave de debrid na conta?
    pub debrid_has_key: bool,
    /// `opts().debridCachedOnly`.
    pub debrid_cached_only: bool,
    /// Estreia do episódio (`Date.parse(airDate)`) em ms; `None` = sem data.
    pub episode_aired_at_ms: Option<i64>,
    /// Contagem de episódios por temporada (Cinemeta): `[(temporada, n)]`.
    pub episode_counts: Vec<(i64, i64)>,
    /// `first_seen` do banco de magnets vivo por hash (injetado).
    pub first_seen_ms: HashMap<String, f64>,
    /// Bases normalizadas de executáveis do acervo desta obra (corte 2).
    pub executable_bases: Vec<String>,
    /// Relógio da build (ms desde a época).
    pub now_ms: i64,
}

// ── Saída ───────────────────────────────────────────────────────────────────

/// Um stream da lista final: o item do CONTRATO (`StreamItem`, sem campo `_*`)
/// mais as marcas internas que a resposta precisa (aviso, origem BR).
///
/// As marcas de baixo existem porque a URL de `/resolve` é montada FORA do
/// build: o HMAC depende de prefixo/segredo/prazo da REQUISIÇÃO (nunca do
/// build), mas os fatos que entram no payload (`infoHash`, dica `w`/`p`/`d`)
/// são do stream. Sem elas, o orquestrador teria de reparsear o `StreamItem` —
/// e o item resolvido já perdeu `infoHash`/`sources` de propósito.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltStream {
    pub item: crate::contract::StreamItem,
    pub is_br: bool,
    /// Aviso de lista vazia: o item É o aviso (o link sai no origin).
    pub notice: bool,
    /// ⚡ — o debrid respondeu "pronto" para este item.
    pub cached: bool,
    /// Hash de origem (o `/resolve` precisa dele; some do contrato se resolvido).
    pub info_hash: Option<String>,
    /// Prova/promessa de dublado: dica `d:1` do HMAC.
    pub dubbed: bool,
    /// Pack multiobra ADMITIDO: dica `p:1` do HMAC.
    pub multi_work_admitted: bool,
}

/// Resultado do build: a lista, o estado do debrid e o funil observacional.
#[derive(Debug, Clone, Default)]
pub struct BuiltList {
    pub streams: Vec<BuiltStream>,
    /// Dica de obra para o pickFile no play (só filme): `n`/`y`.
    pub work_hint: Option<WorkHint>,
    /// Lote cru que SOBREVIVEU ao filtro de título (antes de episódio/ranking).
    /// É a matéria-prima do `releaseIndex.record` (`/internal/search/index-write`):
    /// gravar o lote pré-filtro encheria o índice de release irrelevante.
    pub filtered_raw: Vec<crate::raw_item::RawItem>,
    /// Lote cru ANTES do filtro de título — o `entered` do banco de magnets
    /// (antes/depois do filtro, para a marca de veredito).
    pub entered_raw: Vec<crate::raw_item::RawItem>,
    /// A lista carrega RESERVA do banco/foto do índice (`_fromFallback`):
    /// entrada com reserva nunca é completa.
    pub fallback: bool,
    /// Alguma checagem respondeu de verdade (Cached/Missing/Unusable)?
    pub debrid_known: bool,
    /// O debrid sinalizou auth/quota (lista P2P, sem autofetch).
    pub debrid_unusable: bool,
    /// `unknown:false` em algum item (passe tardio refaz).
    pub needs_debrid_refresh: bool,
    /// Quantos itens estavam no pool que ENTROU no debrid.
    pub candidates_before_debrid: usize,
    pub br_entered_debrid: usize,
    pub dub_entered_debrid: usize,
    /// Funil observacional (porte do ledger P5, versão contadores).
    pub funnel: BTreeMap<String, usize>,
}

impl BuiltList {
    /// Conta um estágio do funil.
    pub fn count(&mut self, stage: &str, n: usize) {
        self.funnel.insert(stage.to_string(), n);
    }
}

/// Dica de obra (`workHint`): nomes + ano limpo (primeiro token de 4 dígitos).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkHint {
    pub names: Vec<String>,
    pub year: Option<i64>,
}

/// `seedFloorFor` (`src/providers/seed-floor.ts`): debrid que diz o que está
/// pronto + "só em cache" ⇒ o piso de seeders sai da frente e o ⚡ decide
/// (invariante 3). Baixar (Chupim) segue com o próprio piso.
pub fn seed_floor_for(opts: &BuildOptions, ctx: &BuildContext) -> f64 {
    if opts.cached_only_ignores_seeds
        && ctx.debrid_cache_check_honest
        && ctx.debrid_has_key
        && ctx.debrid_cached_only
    {
        0.0
    } else {
        opts.min_seeders
    }
}

/// `Value` do seeders cru, com a coerção `Number` do JS (NaN → `null`).
pub fn seeders_value_of(seeders: Option<f64>) -> Value {
    match seeders {
        Some(n) => serde_json::Number::from_f64(n)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        None => Value::Null,
    }
}

/// Fecha na RESPOSTA o que o cache não pode carregar (porte do
/// `applyNoticeOrigin` de `stream-builder.ts`): o aviso vira `externalUrl` com
/// o host de quem pergunta AGORA e o `/resolve` relativo ganha o mesmo host —
/// o HOST NUNCA ENTROU na lista nem vai para o cache. Sem base, aviso e
/// resolve-url são DESCARTADOS: link quebrado ocuparia a tela e sumiria no
/// play. O chip `size` é lido do `💾` do `title` na hora da resposta.
pub fn apply_notice_origin(
    built: &[BuiltStream],
    base: Option<&str>,
    prefix: &str,
) -> Vec<crate::contract::StreamItem> {
    let base = base.map(|b| b.trim_end_matches('/')).unwrap_or("");
    let mut out = Vec::with_capacity(built.len());
    for entry in built {
        if entry.notice {
            if base.is_empty() {
                continue;
            }
            let mut item = entry.item.clone();
            item.external_url = Some(format!("{base}{prefix}/configure"));
            out.push(item);
            continue;
        }
        let mut item = entry.item.clone();
        if let Some(url) = item.url.take() {
            if base.is_empty() {
                continue;
            }
            // Path+query relativo (o HMAC não cobre o host); absoluto legado
            // troca só o origin — aqui o build só produz relativo.
            item.url = Some(format!("{base}{url}"));
        }
        out.push(item);
    }
    out
}
