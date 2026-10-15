//! Porte puro de `src/providers/autofetch-obra.ts` — identidade, cap e visão
//! combinada do teto por OBRA do Chupim (Fase 2).
//!
//! Funções PURAS: entrada explícita (incluindo config), saída determinística.
//! A fronteira impura (`reserveObra`, `commitObra`, etc.) fica no Node.
//! Reusa [`ObraEntry`] de `autofetch_obra_overflow` para a visão combinada.

use sha2::{Digest, Sha256};

use crate::autofetch_obra_overflow::ObraEntry;
use crate::cache_keys::prefix;

// ── Constantes ───────────────────────────────────────────────────────────────

/// Prefixo da chave de cache do registro da obra: `autofetch:v3:o:`.
pub fn obra_prefix() -> String {
    format!("{}o:", prefix("autofetch"))
}

/// Lease curto da reserva volátil (ms): cobre a chamada de enqueue.
pub const OBRA_LEASE_TTL_MS: f64 = 60_000.0;

// ── Tipos de entrada ─────────────────────────────────────────────────────────

/// Configuração viva necessária para as decisões puras (subconjunto do
/// `autofetchLive.effective()` do TS).
#[derive(Debug, Clone, PartialEq)]
pub struct ObraLiveConfig {
    /// Teto de downloads por busca (pool `br`).
    pub auto_fetch_max: f64,
    /// Teto do pool `seeds` (regime normal).
    pub auto_fetch_top_seeds_max: f64,
    /// Teto do pool `seeds` (regime raro).
    pub auto_fetch_rare_max: f64,
    /// Janela deslizante do registro (segundos).
    pub auto_fetch_ttl: f64,
}

/// Entrada para construção da identidade da obra.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ObraIdentityInput {
    pub adapter_id: String,
    pub account: String,
    /// Tipo canônico (`"movie"`/`"series"`); `None` é inferido pela presença de season.
    pub type_: Option<String>,
    pub imdb_id: Option<String>,
    pub season: Option<f64>,
    pub episode: Option<f64>,
    /// Pack de temporada: episódio normalizado para vazio.
    pub is_pack: bool,
    pub search_key: Option<String>,
}

/// Entrada completa do registro persistido por hash aceito.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ObraRecordEntry {
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
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PendingReservation {
    pub id: String,
    pub pool: String,
    pub rare: bool,
    pub at: f64,
    pub hash: String,
    pub quality: Option<String>,
    pub overflow: bool,
}

/// Contagem por pool (entradas na janela + reservas vivas).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ObraCounts {
    pub br: u32,
    pub any: u32,
    pub seeds: u32,
    pub total: u32,
}

// ── Funções auxiliares internas ──────────────────────────────────────────────

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest.as_slice() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Inferir tipo: explícito "series"/"movie" vence; senão, presença de season
/// finita → "series"; caso contrário → "movie".
fn infer_type(type_: Option<&str>, season: Option<f64>) -> &'static str {
    if let Some(t) = type_ {
        let lower = t.to_lowercase();
        if lower == "series" || lower == "movie" {
            // SAFETY: "series" e "movie" são literais estáticas.
            return if lower == "series" { "series" } else { "movie" };
        }
    }
    match season {
        Some(s) if s.is_finite() => "series",
        _ => "movie",
    }
}

/// Segmento numérico: `None`/não-finito → vazio; senão `trunc(value)` como string.
fn segment(value: Option<f64>) -> String {
    match value {
        Some(v) if v.is_finite() => (v.trunc() as i64).to_string(),
        _ => String::new(),
    }
}

// ── Funções públicas ─────────────────────────────────────────────────────────

/// Identidade estável da obra:
/// `adapterId:accountScope:type:imdbId:season:episode`
///
/// Sem imdbId válido cai no digest do searchKey. Sem imdbId E sem searchKey a
/// identidade existe mas é degenerada (o chamador decide se aplica o teto).
pub fn obra_identity(input: &ObraIdentityInput) -> String {
    let tipo = infer_type(input.type_.as_deref(), input.season);
    let base = format!("{}:{}:{}", input.adapter_id, input.account, tipo);
    let imdb_id = input.imdb_id.as_deref().unwrap_or("");
    if is_valid_imdb(imdb_id) {
        let episode_seg = if input.is_pack {
            String::new()
        } else {
            segment(input.episode)
        };
        format!(
            "{}:{}:{}:{}",
            base,
            imdb_id,
            segment(input.season),
            episode_seg
        )
    } else {
        let search_key = input.search_key.as_deref().unwrap_or("");
        format!("{}:sk:{}", base, sha256_hex(search_key))
    }
}

/// Chave de cache do registro da obra (`autofetch:v3:o:<sha256 da identidade>`).
pub fn obra_key(identity: &str) -> String {
    format!("{}{}", obra_prefix(), sha256_hex(identity))
}

/// Digest completo (sha256 hex) da identidade — usado como marker F6.
pub fn obra_digest(identity: &str) -> String {
    sha256_hex(identity)
}

/// Teto da vaga por pool. `br` acompanha `autoFetchMax`; `seeds` usa rareMax
/// ou topSeedsMax conforme o regime; pool desconhecido é conservador (1).
pub fn pool_cap(pool: &str, rare: bool, config: &ObraLiveConfig) -> u32 {
    match pool {
        "br" => {
            let v = config.auto_fetch_max.trunc() as i64;
            if v < 1 {
                1
            } else {
                v as u32
            }
        }
        "seeds" => {
            let cap = if rare {
                config.auto_fetch_rare_max
            } else {
                config.auto_fetch_top_seeds_max
            };
            let v = cap.trunc() as i64;
            if v < 1 {
                1
            } else {
                v as u32
            }
        }
        _ => 1,
    }
}

/// Determina se a entrada é rara no pool seeds (eleva o teto).
///
/// - Pool diferente de "seeds" → nunca é raro.
/// - Flag `rare` explícito → sempre raro.
/// - Senão: `rareMax > topMax && slotLimit >= rareMax` (cobre o dreno que não
///   carrega o booleano).
pub fn seeds_rare(
    pool: &str,
    rare_flag: bool,
    slot_limit: Option<f64>,
    config: &ObraLiveConfig,
) -> bool {
    if pool != "seeds" {
        return false;
    }
    if rare_flag {
        return true;
    }
    let rare_max = config.auto_fetch_rare_max.trunc() as i64;
    let top_max = config.auto_fetch_top_seeds_max.trunc() as i64;
    rare_max > top_max && slot_limit.is_some_and(|sl| (sl.trunc() as i64) >= rare_max)
}

/// Janela deslizante em milissegundos.
pub fn window_ms(config: &ObraLiveConfig) -> f64 {
    let ttl = config.auto_fetch_ttl;
    if ttl.is_nan() || ttl < 0.0 {
        0.0
    } else {
        ttl * 1000.0
    }
}

/// Contagem por pool das entradas ativas (persistidas na janela + reservas vivas).
pub fn counts_from(entries: &[ObraRecordEntry], pending: &[PendingReservation]) -> ObraCounts {
    let mut br: u32 = 0;
    let mut any: u32 = 0;
    let mut seeds: u32 = 0;
    for e in entries {
        match e.pool.as_str() {
            "br" => br += 1,
            "any" => any += 1,
            "seeds" => seeds += 1,
            _ => {}
        }
    }
    for p in pending {
        match p.pool.as_str() {
            "br" => br += 1,
            "any" => any += 1,
            "seeds" => seeds += 1,
            _ => {}
        }
    }
    let total = br + any + seeds;
    ObraCounts {
        br,
        any,
        seeds,
        total,
    }
}

/// Visão combinada (registro persistido + reservas vivas) como [`ObraEntry`],
/// para a decisão de overflow. Reserva viva é vaga ocupada com a qualidade dela.
pub fn combined_view(
    entries: &[ObraRecordEntry],
    pending: &[PendingReservation],
) -> Vec<ObraEntry> {
    let mut out: Vec<ObraEntry> = entries
        .iter()
        .map(|e| ObraEntry {
            pool: e.pool.clone(),
            quality: e.quality.clone().unwrap_or_default(),
            overflow: e.overflow,
        })
        .collect();
    for p in pending {
        out.push(ObraEntry {
            pool: p.pool.clone(),
            quality: p.quality.clone().unwrap_or_default(),
            overflow: p.overflow,
        });
    }
    out
}

/// Parser defensivo do JSON do registro persistido no L1.
/// Formato estranho → registro vazio (nunca lança).
pub fn read_record(raw: &serde_json::Value) -> Vec<ObraRecordEntry> {
    let entries = match raw.get("entries").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return Vec::new(),
    };
    let str_field = |obj: &serde_json::Map<String, serde_json::Value>, k: &str| -> String {
        obj.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let opt_str = |obj: &serde_json::Map<String, serde_json::Value>, k: &str| -> Option<String> {
        obj.get(k)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };
    let mut out = Vec::with_capacity(entries.len());
    for item in entries {
        let obj = match item.as_object() {
            Some(o) => o,
            None => continue,
        };
        let hash = str_field(obj, "hash").to_lowercase();
        if hash.is_empty() {
            continue;
        }
        out.push(ObraRecordEntry {
            hash,
            pool: str_field(obj, "pool"),
            accepted_at: obj
                .get("acceptedAt")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0),
            title: opt_str(obj, "title"),
            br: obj.get("br").and_then(|v| v.as_bool()).unwrap_or(false),
            dubbed: obj.get("dubbed").and_then(|v| v.as_bool()).unwrap_or(false),
            id: opt_str(obj, "id"),
            quality: opt_str(obj, "quality"),
            overflow: obj
                .get("overflow")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        });
    }
    out
}

/// Valida se o imdbId tem o formato `tt\d+`.
fn is_valid_imdb(id: &str) -> bool {
    if !id.starts_with("tt") || id.len() < 3 {
        return false;
    }
    id[2..].chars().all(|c| c.is_ascii_digit())
}

// ── Testes unitários ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ObraLiveConfig {
        ObraLiveConfig {
            auto_fetch_max: 3.0,
            auto_fetch_top_seeds_max: 2.0,
            auto_fetch_rare_max: 4.0,
            auto_fetch_ttl: 3600.0,
        }
    }
    fn input(imdb: &str, season: Option<f64>, episode: Option<f64>) -> ObraIdentityInput {
        ObraIdentityInput {
            adapter_id: "pm".into(),
            account: "a1".into(),
            imdb_id: Some(imdb.into()),
            season,
            episode,
            ..Default::default()
        }
    }

    #[test]
    fn identidade_cobre_casos_principais() {
        assert_eq!(
            obra_identity(&input("tt1234567", None, None)),
            "pm:a1:movie:tt1234567::"
        );
        assert_eq!(
            obra_identity(&input("tt7000001", Some(1.0), Some(2.0))),
            "pm:a1:series:tt7000001:1:2"
        );
        let pack = ObraIdentityInput {
            is_pack: true,
            ..input("tt7000001", Some(1.0), Some(2.0))
        };
        assert_eq!(obra_identity(&pack), "pm:a1:series:tt7000001:1:");
        let no_imdb = ObraIdentityInput {
            adapter_id: "pm".into(),
            account: "a".into(),
            search_key: Some("sk".into()),
            ..Default::default()
        };
        assert!(obra_identity(&no_imdb).starts_with("pm:a:movie:sk:"));
        let explicit = ObraIdentityInput {
            type_: Some("movie".into()),
            ..input("tt100", Some(1.0), None)
        };
        assert!(obra_identity(&explicit).contains(":movie:"));
    }

    #[test]
    fn pool_cap_e_seeds_rare() {
        let c = cfg();
        assert_eq!(pool_cap("br", false, &c), 3);
        assert_eq!(pool_cap("seeds", false, &c), 2);
        assert_eq!(pool_cap("seeds", true, &c), 4);
        assert_eq!(pool_cap("any", false, &c), 1);
        assert!(!seeds_rare("br", true, None, &c));
        assert!(seeds_rare("seeds", true, None, &c));
        assert!(seeds_rare("seeds", false, Some(4.0), &c));
        assert!(!seeds_rare("seeds", false, Some(2.0), &c));
    }

    #[test]
    fn window_ms_e_counts() {
        assert_eq!(window_ms(&cfg()), 3_600_000.0);
        let entries = vec![
            ObraRecordEntry {
                pool: "br".into(),
                ..Default::default()
            },
            ObraRecordEntry {
                pool: "br".into(),
                ..Default::default()
            },
            ObraRecordEntry {
                pool: "seeds".into(),
                ..Default::default()
            },
        ];
        let pending = vec![PendingReservation {
            pool: "any".into(),
            ..Default::default()
        }];
        assert_eq!(
            counts_from(&entries, &pending),
            ObraCounts {
                br: 2,
                any: 1,
                seeds: 1,
                total: 4
            }
        );
    }

    #[test]
    fn combined_view_e_read_record() {
        let entries = vec![ObraRecordEntry {
            pool: "br".into(),
            quality: Some("720p".into()),
            ..Default::default()
        }];
        let pending = vec![PendingReservation {
            pool: "br".into(),
            quality: Some("1080p".into()),
            overflow: true,
            ..Default::default()
        }];
        let view = combined_view(&entries, &pending);
        assert_eq!(view.len(), 2);
        assert_eq!(view[1].quality, "1080p");
        assert!(view[1].overflow);
        // read_record: defensivo
        let raw = serde_json::json!({"entries": [{"hash": "AABB", "pool": "br", "acceptedAt": 1000.0, "br": true, "quality": "720p"}, {"hash": "", "pool": "x"}, null]});
        let rec = read_record(&raw);
        assert_eq!(rec.len(), 1);
        assert_eq!(rec[0].hash, "aabb");
        assert!(read_record(&serde_json::json!("bad")).is_empty());
    }

    #[test]
    fn is_valid_imdb_verifica_formato() {
        assert!(is_valid_imdb("tt1234567"));
        assert!(!is_valid_imdb("tt"));
        assert!(!is_valid_imdb("tt12a45"));
        assert!(!is_valid_imdb(""));
    }
}
