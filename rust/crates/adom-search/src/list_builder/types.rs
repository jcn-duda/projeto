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

use adom_core::{DebridFile, QualityLimits, RankingStream, QUALITY_KEYS};
use serde_json::{json, Value};

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
    /// `BR_MULTIWORK_PACKS` (default true; `false` é kill-switch). Gate de
    /// PRECONDIÇÃO do metadata load e do multiobra — não é opção de usuário.
    pub multi_work_packs: bool,
    /// `SEARCH_UNAIRED_MARGIN_MS` (24h).
    pub unaired_margin_ms: i64,
    /// `SEARCH_PREAIR_RELEASE_MARGIN_MS` (48h).
    pub pre_air_margin_ms: i64,
    /// `config.search.preHomeReleaseCut` + margem (a data vem injetada).
    pub pre_home_release_cut: bool,
    pub pre_home_release_margin_ms: i64,
    /// `config.search.titlePrecisionTailCut` (default `true`).
    pub title_precision_tail_cut: bool,
    /// `config.audioAudit`: o `dn=` de cena EN anula a promessa de dublado.
    pub audio_audit: super::AudioAudit,
    /// Hashes que o debrid desta conta já provou tocáveis (inventário/alive).
    /// O Node usa isto como `instant` no sorteio; sem a lista, o desempate cai
    /// para seeders e troca itens do mesmo balde de qualidade. Vem do operador
    /// (inventário da conta), nunca do usuário.
    pub instant_hashes: Vec<String>,
}

impl Default for BuildOptions {
    /// Defaults do operador (`src/config/search.ts`). Cotas vazias no núcleo =
    /// ilimitado por faixa → lista ~`maxResults`; espelhar o Node (2/faixa,
    /// BR 6+1, filtro HD, pool×4) evita o corte nativo devolver ~40 itens.
    fn default() -> Self {
        BuildOptions {
            max_results: 40.0,
            candidate_pool_factor: 4.0,
            min_seeders: 1.0,
            cached_only_ignores_seeds: true,
            qualities: vec!["2160p".into(), "1080p".into(), "720p".into()],
            prefer_dubbed: true,
            // `opts().dubbedOnly` do Node nasce de `BLUDV_DUBBED_ONLY` (default
            // TRUE) — é a MESMA opção que filtra `legendado` no scrape BR.
            dubbed_only: true,
            exclude_cam: false,
            max_size_gb: 0.0,
            quality_limits: default_quality_limits(2.0),
            br_reserved_slots: 6.0,
            br_reserved_per_quality: 1.0,
            br_only: false,
            br_first: true,
            max_per_indexer: 0.0,
            indexer_limits: QualityLimits::default(),
            indexer_priority: Vec::new(),
            notice_stream: true,
            multi_work_packs: true,
            unaired_margin_ms: 24 * 60 * 60 * 1000,
            pre_air_margin_ms: 48 * 60 * 60 * 1000,
            // `config.search.preHomeReleaseCut` + margem: default do Node é
            // LIGADO com 48h (release doméstica só é cortada quando o
            // lançamento doméstico está a mais de 48h no futuro).
            pre_home_release_cut: true,
            pre_home_release_margin_ms: 48 * 60 * 60 * 1000,
            title_precision_tail_cut: true,
            audio_audit: super::AudioAudit::default(),
            instant_hashes: Vec::new(),
        }
    }
}

/// Cotas por faixa (`QUALITY_KEYS`, incl. `"sem resolução"`).
pub fn default_quality_limits(per_bucket: f64) -> QualityLimits {
    let mut out = QualityLimits::new();
    for key in QUALITY_KEYS {
        out.insert(key.to_string(), per_bucket);
    }
    out
}

impl BuildOptions {
    /// Fatia de cotas/busca do `defaults()` do Node — chaves longas do SCHEMA
    /// para o decode da URL herdar teto/vagas quando o segmento omite `q1`/`b`.
    pub fn to_schema_defaults(&self) -> Value {
        json!({
            "qualities": self.qualities,
            "maxResults": self.max_results,
            "minSeeders": self.min_seeders,
            "brReservedSlots": self.br_reserved_slots,
            "brReservedPerQuality": self.br_reserved_per_quality,
            "brFirst": self.br_first,
            "brOnly": self.br_only,
            "preferDubbed": self.prefer_dubbed,
            "dubbedOnly": self.dubbed_only,
            "excludeCam": self.exclude_cam,
            "maxSizeGb": self.max_size_gb,
            "max2160p": self.quality_limits.get("2160p").copied().unwrap_or(2.0),
            "max1080p": self.quality_limits.get("1080p").copied().unwrap_or(2.0),
            "max720p": self.quality_limits.get("720p").copied().unwrap_or(2.0),
            "max480p": self.quality_limits.get("480p").copied().unwrap_or(2.0),
            "maxSd": self.quality_limits.get("SD").copied().unwrap_or(2.0),
            "maxUnknown": self.quality_limits
                .get(adom_core::UNKNOWN_QUALITY)
                .copied()
                .unwrap_or(2.0),
            "maxPerIndexer": self.max_per_indexer,
            "indexerPriority": self.indexer_priority,
            "indexerLimits": Value::Object(serde_json::Map::new()),
        })
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
    /// `opts().showUncachedBr` — vagas P2P BR fora do cache (exceção ao corte).
    pub show_uncached_br: bool,
    /// `DEBRID_RESOLVE_UNCACHED` do operador — o frio sai pelo `/resolve` em
    /// vez de P2P. Vem da config da instalação, nunca do segmento do usuário.
    /// Só vale com debrid ATIVO e veredito utilizável: sem serviço/chave
    /// (`NoDebridCheck`) ou com `Unusable` (auth/quota) o Node mantém P2P e
    /// descarta multiobra — o `/resolve` morreria na conta que não responde.
    pub debrid_resolve_uncached: bool,
    /// Sombra §9.1: a checagem foi suprimida (`NoDebridCheck`), então
    /// `Unknown` NÃO significa lote degradado — nada vira `/resolve`.
    pub debrid_check_disabled: bool,
    /// Estreia do episódio (`Date.parse(airDate)`) em ms; `None` = sem data.
    pub episode_aired_at_ms: Option<i64>,
    /// 1º lançamento doméstico do filme (TMDB, epoch ms) — `homeReleaseAt` do
    /// `matchContext`/`peekHomeReleaseAt` do Node. `None` = sem data (e o corte
    /// pré-home-release não roda).
    pub home_release_at: Option<i64>,
    /// Contagem de episódios por temporada (Cinemeta): `[(temporada, n)]`.
    pub episode_counts: Vec<(i64, i64)>,
    /// `first_seen` do banco de magnets vivo por hash (injetado).
    pub first_seen_ms: HashMap<String, f64>,
    /// Títulos pt/original/en do TMDB: contexto da recuperação de DUAL global
    /// (`ptTitleDual`). O build decide in-process — não depende da flag que a
    /// rota de coleta manda no item.
    pub titles: Option<adom_core::PtTitleDualTitles>,
    /// Bases normalizadas de executáveis do acervo desta obra (corte 2).
    pub executable_bases: Vec<String>,
    /// Lista de arquivos por hash (memo `fsz` do Node). É o que dá `💾` ao
    /// pack (média do episódio) e ao item que o tracker deixou sem tamanho —
    /// o `annotateEpisodeSizes`/`fillMissingSizes` do Node, injetado.
    pub files_by_hash: BTreeMap<String, Vec<DebridFile>>,
    /// Total do torrent (memo `tsz` do Node) por hash: o `💾` de quem veio sem
    /// tamanho quando não há lista de arquivos. Injetado pelo replay congelado.
    pub totals_by_hash: BTreeMap<String, f64>,
    /// Estado do memo na passada PRÉ-debrid (1ª anotação do Node). `None` =
    /// captura antiga/sem o arquivo: a 1ª passada segue a régua anterior.
    pub files_at_build: Option<BTreeMap<String, Vec<DebridFile>>>,
    pub totals_at_build: Option<BTreeMap<String, f64>>,
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
    /// Pack multiobra ADMITIDO (opt-in TMDB): decide o `playDisposition`.
    pub multi_work_admitted: bool,
    /// Coleção multiobra GENÉRICA — o `_multiWork` do Node
    /// (`isMultiWorkCollection(title) || _multiWorkAdmitted`). É ESTA marca que
    /// entra na dica `p:1` do HMAC (o genérico basta; a admissão não é
    /// pré-requisito), desde que exista dica de obra.
    pub multi_work: bool,
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
    /// Alguma checagem respondeu de verdade (Cached/Missing)? `Unusable`
    /// (auth/quota) não conta: é `known:false`, como no Node.
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
    /// Efeitos de cauda que ESTE lote decidiu (dub_audit/warmer). Vazio = sem
    /// efeito; quem emite é o orquestrador, atrás de `EFFECTS_RUST`.
    pub effect_seeds: super::effects::EffectSeeds,
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
