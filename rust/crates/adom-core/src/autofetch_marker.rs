//! Porte puro das partes determinísticas de `src/providers/autofetch-marker.ts`:
//! a CHAVE e o VALOR gravados quando um enqueue do Chupim é aceito, mais a
//! leitura do id da transferência e do digest da obra a partir desse valor.
//!
//! Chave e valor têm que mudar em PAR (quem grava e quem lê são o mesmo
//! contrato), por isso vivem juntos aqui também. O que fica DE FORA é a parte
//! impura do fonte: `cache.get`/`cache.peek`/`keysMatching` e o `markerIdIndex`
//! (varredura do L1). Aqui [`MarkerValue::from_json`] faz a ponte — recebe o
//! valor JÁ lido do cache e o interpreta, que é a essência pura dos leitores.
//!
//! # Formas do valor
//!
//! O fonte é polimórfico e preserva compatibilidade com o que já foi gravado:
//! - `1` — marker legado: só a presença importava (sem identidade).
//! - `{id}` — quando o adapter devolveu o id da transferência, sem `meta`.
//! - objeto completo (Fase 6) — `meta` presente: pool/obra/acceptedAt/title/br/
//!   dubbed, com `obra` sendo o DIGEST da identidade (nunca imdbId nem conta).
//!
//! [`MarkerValue`] modela as três formas como enum, e [`MarkerValue::to_json_string`]
//! reproduz byte a byte o `JSON.stringify` do fonte (ordem de inserção dos
//! campos e omissão dos vazios).

use serde_json::{Map, Value};

use crate::cache_keys::cache_key;

/// Corte do título no marker, em unidades de código UTF-16 (o `.slice(0, 120)`
/// do JS conta UTF-16, não code points).
const MARKER_TITLE_MAX: usize = 120;

/// Metadados do marker completo (Fase 6). Campos `None`/vazios são omitidos do
/// valor gravado, como no fonte (`if (meta.pool) …`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MarkerMeta {
    pub pool: Option<String>,
    pub obra: Option<String>,
    /// `None` = não informado → cai no `now_ms` (o `Date.now()` do fonte).
    pub accepted_at: Option<i64>,
    pub title: Option<String>,
    pub br: bool,
    pub dubbed: bool,
}

/// Valor gravado no marker, nas três formas que o fonte produz/aceita.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarkerValue {
    /// Marker legado (`1`) ou valor não-objeto: presença sem identidade.
    Legacy,
    /// `{id}`: âncora da transferência, sem `meta`.
    Id { id: String },
    /// Objeto completo (Fase 6). Campos `None` são os omitidos na gravação.
    Full {
        id: Option<String>,
        pool: Option<String>,
        obra: Option<String>,
        accepted_at: i64,
        title: Option<String>,
        br: bool,
        dubbed: bool,
    },
}

/// Chave do marker: `autofetch:v3:m:<adapter>:<conta>:<hash>` (hash em minúsculas).
pub fn marker_key(adapter: &str, account: &str, info_hash: &str) -> String {
    let hash = info_hash.to_lowercase();
    cache_key("autofetch", &["m", adapter, account, &hash])
}

/// Monta o valor do marker como o `markerValue(accepted, meta?)` do fonte.
///
/// `accepted` é o id da transferência devolvido pelo adapter (vazio quando não
/// há). `now_ms` substitui o `Date.now()` do fallback de `acceptedAt`, mantendo
/// a função pura e determinística. Sem `meta`, devolve a forma legado (`1`) ou
/// `{id}`; com `meta`, o objeto completo.
pub fn marker_value(accepted: &str, meta: Option<&MarkerMeta>, now_ms: i64) -> MarkerValue {
    let id = if accepted.is_empty() {
        None
    } else {
        Some(accepted.to_string())
    };
    let Some(meta) = meta else {
        return match id {
            Some(id) => MarkerValue::Id { id },
            None => MarkerValue::Legacy,
        };
    };
    let accepted_at = meta.accepted_at.unwrap_or(now_ms);
    MarkerValue::Full {
        id,
        pool: non_empty(meta.pool.as_deref()),
        obra: non_empty(meta.obra.as_deref()),
        accepted_at,
        title: meta
            .title
            .as_deref()
            .map(slice_utf16)
            .filter(|t| !t.is_empty()),
        br: meta.br,
        dubbed: meta.dubbed,
    }
}

/// ID da transferência guardado no marker, quando o adapter devolveu um.
/// Marker legado ou sem id → `None` (o `null` do fonte).
pub fn marker_transfer_id(value: &MarkerValue) -> Option<&str> {
    match value {
        MarkerValue::Legacy => None,
        MarkerValue::Id { id } => Some(id.as_str()),
        MarkerValue::Full { id, .. } => id.as_deref(),
    }
}

/// Digest da obra guardado no marker NOVO, ou `None` para marker legado (`1` ou
/// `{id}`). É o predicado de elegibilidade da evicção dirigida (Fase 6): só
/// marker com `obra` casa uma identidade provada.
pub fn marker_obra(value: &MarkerValue) -> Option<&str> {
    match value {
        MarkerValue::Full { obra, .. } => obra.as_deref(),
        _ => None,
    }
}

impl MarkerValue {
    /// Interpreta um valor JÁ lido do cache (a essência pura dos leitores do
    /// fonte). Não-objeto (`1`, `null`, …) vira [`MarkerValue::Legacy`].
    pub fn from_json(value: &Value) -> MarkerValue {
        let Value::Object(map) = value else {
            return MarkerValue::Legacy;
        };
        MarkerValue::Full {
            id: json_str(map.get("id")),
            pool: json_str(map.get("pool")),
            obra: json_str(map.get("obra")),
            accepted_at: map.get("acceptedAt").and_then(Value::as_i64).unwrap_or(0),
            title: json_str(map.get("title")),
            br: map.get("br").and_then(Value::as_bool).unwrap_or(false),
            dubbed: map.get("dubbed").and_then(Value::as_bool).unwrap_or(false),
        }
    }

    /// Serialização com paridade byte a byte com o `JSON.stringify` do fonte:
    /// mesma ordem de inserção e mesmas omissões (campos vazios não aparecem).
    pub fn to_json_string(&self) -> String {
        match self {
            MarkerValue::Legacy => "1".to_string(),
            MarkerValue::Id { id } => {
                let mut map = Map::new();
                map.insert("id".to_string(), Value::String(id.clone()));
                Value::Object(map).to_string()
            }
            MarkerValue::Full {
                id,
                pool,
                obra,
                accepted_at,
                title,
                br,
                dubbed,
            } => {
                let mut map = Map::new();
                if let Some(id) = id {
                    map.insert("id".to_string(), Value::String(id.clone()));
                }
                if let Some(pool) = pool {
                    map.insert("pool".to_string(), Value::String(pool.clone()));
                }
                if let Some(obra) = obra {
                    map.insert("obra".to_string(), Value::String(obra.clone()));
                }
                map.insert(
                    "acceptedAt".to_string(),
                    Value::Number((*accepted_at).into()),
                );
                if let Some(title) = title {
                    map.insert("title".to_string(), Value::String(title.clone()));
                }
                map.insert("br".to_string(), Value::Bool(*br));
                map.insert("dubbed".to_string(), Value::Bool(*dubbed));
                Value::Object(map).to_string()
            }
        }
    }
}

/// `Some(s)` só para string não-vazia (o truthy do JS omite os vazios).
fn non_empty(value: Option<&str>) -> Option<String> {
    value.filter(|s| !s.is_empty()).map(|s| s.to_string())
}

/// String não-vazia de um campo JSON, senão `None`.
fn json_str(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// `String(s).slice(0, MARKER_TITLE_MAX)` do JS: corte por unidades UTF-16.
fn slice_utf16(text: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= MARKER_TITLE_MAX {
        return text.to_string();
    }
    String::from_utf16_lossy(&units[..MARKER_TITLE_MAX])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chave_usa_o_prefixo_m_e_normaliza_o_hash() {
        assert_eq!(
            marker_key("premiumize", "acc", "AABB"),
            "autofetch:v3:m:premiumize:acc:aabb"
        );
    }

    #[test]
    fn valor_legado_e_id_sem_meta() {
        assert_eq!(marker_value("", None, 999).to_json_string(), "1");
        assert_eq!(
            marker_value("tid", None, 999).to_json_string(),
            r#"{"id":"tid"}"#
        );
    }

    #[test]
    fn valor_completo_omite_vazios_e_usa_now_como_fallback() {
        let meta = MarkerMeta {
            pool: Some("br".into()),
            obra: Some("digest".into()),
            accepted_at: None,
            title: Some("".into()),
            br: true,
            dubbed: false,
        };
        assert_eq!(
            marker_value("tid", Some(&meta), 1234).to_json_string(),
            r#"{"id":"tid","pool":"br","obra":"digest","acceptedAt":1234,"br":true,"dubbed":false}"#
        );
    }

    #[test]
    fn accepted_at_do_meta_vence_o_now() {
        let meta = MarkerMeta {
            accepted_at: Some(55),
            ..Default::default()
        };
        assert_eq!(
            marker_value("", Some(&meta), 1234).to_json_string(),
            r#"{"acceptedAt":55,"br":false,"dubbed":false}"#
        );
    }

    #[test]
    fn titulo_acima_do_corte_e_recortado() {
        let longo = "x".repeat(150);
        let meta = MarkerMeta {
            accepted_at: Some(1),
            title: Some(longo),
            ..Default::default()
        };
        let value = marker_value("", Some(&meta), 0);
        let MarkerValue::Full { title, .. } = &value else {
            panic!("esperado Full");
        };
        assert_eq!(title.as_deref().map(str::len), Some(120));
    }

    #[test]
    fn leitores_extraem_id_e_obra_por_forma() {
        assert_eq!(marker_transfer_id(&MarkerValue::Legacy), None);
        assert_eq!(marker_obra(&MarkerValue::Legacy), None);
        let id = MarkerValue::Id { id: "tid".into() };
        assert_eq!(marker_transfer_id(&id), Some("tid"));
        assert_eq!(marker_obra(&id), None);
        // from_json de objeto completo alimenta os dois leitores.
        let raw: Value = serde_json::from_str(r#"{"id":"t2","obra":"dig"}"#).unwrap();
        let full = MarkerValue::from_json(&raw);
        assert_eq!(marker_transfer_id(&full), Some("t2"));
        assert_eq!(marker_obra(&full), Some("dig"));
        // Não-objeto → Legacy.
        assert_eq!(MarkerValue::from_json(&Value::from(1)), MarkerValue::Legacy);
    }
}
