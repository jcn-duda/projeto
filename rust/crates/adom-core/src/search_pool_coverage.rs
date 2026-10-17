//! Porte de `src/providers/search-pool-coverage.ts`.
//!
//! # Cobertura por POOL, nunca por contagem
//!
//! Um pack de temporada no índice não decide cobertura de EPISÓDIO: o caso
//! medido (True Detective S02E01) tinha dois packs "[1080p DUBLADO]" de 22,41 e
//! 13,70 GB sustentando a cobertura de S02E01, a busca era servida do índice e
//! o dublado DO EPISÓDIO nunca aparecia. O pack promete a temporada, não a faixa
//! de áudio daquele episódio. Por isso `idx_pool_covered` exige release que
//! NOMEIE o episódio pedido; o pack continua entrando na lista (é fonte tocável
//! de verdade), só não manda o Jackett para o tail.
//!
//! # O que é reusado (não reimplementado)
//!
//! `audio_from_title`, `quality_from_title`, `explicit_pt_audio`,
//! `extract_info_hash` e a MESMA cascata de pools do autofetch
//! (`br_pool_selection::picks`): BR dublado → global dublado → melhor swarm
//! saudável.
//!
//! # Métricas ficam fora do núcleo
//!
//! O TS conta `search.idx.packOnly` no caminho `pack_only`. O núcleo não conta
//! métrica: devolve [`PoolCoverage::pack_only`] e o chamador incrementa (é o que
//! permite `countMetrics: false` na via do banco sem duplicar a regra).
//!
//! # `season` de `pool_covered` NÃO entra no ranking
//!
//! O `poolCovered` do TS recebe `{ season, requireDubbed }`, copia `r.season`
//! para o pseudo-item e chama os picks SEM opções — o bônus de pack da temporada
//! nunca é aplicado ali. O parâmetro é mantido na assinatura (contrato) e
//! ignorado, de propósito; o golden cobre a saída real.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;

use crate::audio_presentation::audio_from_title;
use crate::br_pool_selection::picks::{
    pick_any_dubbed_candidates, pick_br_dubbed_candidates, pick_top_seeded_candidates,
};
use crate::br_pool_selection::{PoolOptions, PoolStream};
use crate::episode_parse::parse_title_season_episode;
use crate::info_hash::extract_info_hash;
use crate::js_text::js_trim;
use crate::pt_audio_guards::explicit_pt_audio;
use crate::stream_quotas_extra::quality_from_title;

/// Release/item visto pela cobertura (o `Stream` do addon é maior; só os campos
/// LIDOS aqui entram).
///
/// `season`/`episode` do item NÃO existem: o TS os copia para o pseudo-item e
/// nenhum pool os lê. Campo desconhecido no JSON é ignorado pelo serde.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolCoverageItem {
    #[serde(default)]
    pub title: Option<String>,
    /// `r.Title` (itens crus da conta usam a chave capitalizada).
    #[serde(default, rename = "Title")]
    pub title_alt: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub quality: Option<String>,
    /// `r.seeders ?? r.Seeders ?? r._seeders ?? 0` — `Value` porque o TS faz
    /// `Number(...)` (aceita string numérica) e o `??` distingue ausente de null.
    #[serde(default)]
    pub seeders: Option<Value>,
    #[serde(default, rename = "Seeders")]
    pub seeders_alt: Option<Value>,
    #[serde(default, rename = "_seeders")]
    pub seeders_underscore: Option<Value>,
    #[serde(default)]
    pub hash: Option<String>,
    #[serde(default, rename = "infoHash")]
    pub info_hash: Option<String>,
    #[serde(default)]
    pub magnet: Option<String>,
    #[serde(default, rename = "isBr")]
    pub is_br: bool,
    /// `r.dubbed !== undefined` no TS: `null` (presente) é `false` e NÃO cai no
    /// cálculo pelo título; ausente cai. Daí o DUPLO opcional: `None` = campo
    /// ausente, `Some(None)` = presente e falso, `Some(Some(b))` = `b`.
    #[serde(default, deserialize_with = "deserialize_present_bool")]
    pub dubbed: Option<Option<bool>>,
    #[serde(default)]
    pub source: Option<String>,
}

/// `Boolean(r.dubbed)` quando o campo EXISTE no JSON (inclusive `null`);
/// `None` quando não existe (o `default` do serde).
fn deserialize_present_bool<'de, D>(d: D) -> Result<Option<Option<bool>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(d)?;
    Ok(Some(match value {
        Value::Null => None,
        other => Some(js_truthy(&other)),
    }))
}

/// Resultado de `idx_pool_covered`: cobertura do índice e a marca do caso em que
/// só chegaram packs (o chamador conta `search.idx.packOnly`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolCoverage {
    pub covered: bool,
    pub pack_only: bool,
}

/// `Boolean(v)` do JS.
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        // `0` e `NaN` são falsy; JSON não carrega NaN.
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `a || b || c || ''` sobre opcionais: o primeiro NÃO vazio (falsy do JS).
fn first_truthy(values: [Option<&str>; 3]) -> &str {
    values
        .into_iter()
        .flatten()
        .find(|s| !s.is_empty())
        .unwrap_or("")
}

/// `Number(v)` do JS para os campos de seeders: número, string numérica, bool
/// e `""` (→ 0); o resto vira `NaN`, que o `|| 0` zera.
fn js_number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null | Value::Array(_) | Value::Object(_) => f64::NAN,
    }
}

/// `Number(r.seeders ?? r.Seeders ?? r._seeders ?? 0) || 0`: o número puro,
/// truncado (seeders são contagens inteiras — mesma premissa de `PoolStream`).
fn seeders_of(item: &PoolCoverageItem) -> i64 {
    let raw = item
        .seeders
        .as_ref()
        .or(item.seeders_alt.as_ref())
        .or(item.seeders_underscore.as_ref())
        .map(js_number)
        .filter(|f| f.is_finite() && *f != 0.0)
        .unwrap_or(0.0);
    raw.trunc() as i64
}

/// Piso de seeders do melhor-swarm: `n >= minSeeders` com `n` INTEIRO equivale a
/// `n >= ceil(minSeeders)`. NaN/±inf mantêm a semântica do JS (`n >= NaN` é
/// sempre falso).
fn min_seeders_floor(min_seeders: f64) -> i64 {
    if min_seeders.is_nan() || min_seeders == f64::INFINITY {
        return i64::MAX;
    }
    if min_seeders == f64::NEG_INFINITY {
        return i64::MIN;
    }
    min_seeders.ceil() as i64
}

/// Release/item → o pseudo-item que o TS monta antes de chamar os pools.
fn pseudo_stream(item: &PoolCoverageItem) -> PoolStream {
    let title = js_trim(first_truthy([
        item.title.as_deref(),
        item.title_alt.as_deref(),
        item.name.as_deref(),
    ]));
    let is_br = item.is_br;
    let dubbed = match item.dubbed {
        Some(present) => present.unwrap_or(false),
        // BR infere o áudio pelo título; global exige marca PT explícita.
        None if is_br => matches!(audio_from_title(title), "Dublado" | "Dual" | "Nacional"),
        None => explicit_pt_audio(title),
    };
    let quality = match item.quality.as_deref() {
        Some(q) if !q.is_empty() => q.to_string(),
        _ => quality_from_title(title).to_string(),
    };
    let info_hash = match item.hash.as_deref() {
        Some(h) if !h.is_empty() => h.to_string(),
        _ => extract_info_hash(first_truthy([
            item.info_hash.as_deref(),
            item.magnet.as_deref(),
            None,
        ]))
        .unwrap_or_default(),
    }
    .to_lowercase();
    PoolStream {
        info_hash: Some(info_hash),
        title: Some(title.to_string()),
        name: Some(title.to_string()),
        quality: Some(quality),
        seeders: Some(seeders_of(item)),
        is_br,
        is_dubbed: dubbed,
        ..PoolStream::default()
    }
}

/// Normaliza releases (do índice ou itens crus/debrid) e verifica se cobrem os
/// requisitos de pool.
///
/// `require_dubbed`: BR dublado → global dublado. Sem ele, cai também no melhor
/// swarm saudável (`pick_top_seeded_candidates`).
///
/// `_season` existe no contrato e é IGNORADO (ver o cabeçalho do módulo).
pub fn pool_covered(
    items: &[PoolCoverageItem],
    _season: Option<i64>,
    require_dubbed: bool,
    min_seeders: f64,
) -> bool {
    if items.is_empty() {
        return false;
    }
    let pseudo: Vec<PoolStream> = items.iter().map(pseudo_stream).collect();
    let cached: HashSet<String> = HashSet::new();
    let defaults = PoolOptions::default();
    if !pick_br_dubbed_candidates(&pseudo, &cached, 1, &defaults).is_empty() {
        return true;
    }
    if !pick_any_dubbed_candidates(&pseudo, &cached, 1, &defaults).is_empty() {
        return true;
    }
    if require_dubbed {
        return false;
    }
    let top = PoolOptions {
        min_seeders: min_seeders_floor(min_seeders),
        ..PoolOptions::default()
    };
    !pick_top_seeded_candidates(&pseudo, &cached, 1, &top).is_empty()
}

/// O título NOMEIA este episódio? Pack de temporada casa o episódio no
/// `matchesEpisode` de propósito (ele contém o episódio), mas não o NOMEIA — e a
/// diferença decide quem pode sustentar a cobertura do índice.
///
/// Porte de `nomeiaEpisodio` (`src/providers/dub-audit.ts`, reexportado por
/// `src/providers/debrid-pipeline.ts`). Era o único lugar do TS com a regra;
/// agora ela vive aqui, interna ao módulo.
fn nomeia_episodio(title: &str, season: i64, episode: i64) -> bool {
    let parsed = parse_title_season_episode(title);
    parsed.episodes.contains(&episode)
        && (parsed.seasons.is_empty() || parsed.seasons.contains(&season))
}

/// "Índice cobre" — a MESMA noção de pool do autofetch, sobre as releases que
/// NÃO vieram do registro do Chupim (`source === 'autofetch'` fica fora: o
/// enqueue prova que escolhemos uma release, não que o índice tem material).
///
/// Em busca de EPISÓDIO, exige release que nomeie o episódio; só packs devolvem
/// `covered:false, pack_only:true`.
///
/// `min_seeders` é o piso do melhor-swarm: o TS o lê de
/// `autofetchLive.effective().autoFetchMinSeeders` DENTRO de `poolCovered`, e o
/// chamador o passa aqui para o núcleo continuar puro.
pub fn idx_pool_covered(
    releases: &[PoolCoverageItem],
    season: Option<i64>,
    episode: Option<i64>,
    min_seeders: f64,
) -> PoolCoverage {
    let coverage: Vec<PoolCoverageItem> = releases
        .iter()
        .filter(|r| r.source.as_deref() != Some("autofetch"))
        .cloned()
        .collect();
    if coverage.is_empty() {
        return PoolCoverage {
            covered: false,
            pack_only: false,
        };
    }
    if let (Some(season), Some(episode)) = (season, episode) {
        let named = coverage
            .iter()
            .any(|r| nomeia_episodio(r.title.as_deref().unwrap_or(""), season, episode));
        if !named {
            return PoolCoverage {
                covered: false,
                pack_only: true,
            };
        }
    }
    PoolCoverage {
        covered: pool_covered(&coverage, season, false, min_seeders),
        pack_only: false,
    }
}
