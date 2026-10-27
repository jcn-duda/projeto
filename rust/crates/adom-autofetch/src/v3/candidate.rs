//! O [`QueueCandidate`] — o payload persistido da fila v3 — e o [`Number`] que
//! preserva a representação dos números JS.
//!
//! Regra de fidelidade (módulo pai [`crate::v3`]): o que entra do Node sai com
//! o MESMO significado. Campos fora da struct sobrevivem no `extra` (o índice
//! `[key: string]: unknown` do tipo TS); `probeSeason`/`probeEpisode`/`episode`
//! são SEMPRE gravados (`None` → `null`), os demais só quando definidos.

use std::collections::BTreeMap;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

/// Número JS preservado: inteiro continua inteiro no JSON de volta (`1080`
/// não vira `1080.0`), e qualquer número (inteiro ou não) é aceito — condenar
/// `1.5` a erro de parse perderia a fila inteira por um campo.
#[derive(Clone, Debug, PartialEq)]
pub struct Number(pub serde_json::Number);

impl Number {
    pub fn from_i64(value: i64) -> Self {
        Number(serde_json::Number::from(value))
    }

    /// `Math.trunc(x)` do JS para os acessores `_i64`.
    pub fn as_i64(&self) -> Option<i64> {
        self.0
            .as_i64()
            .or_else(|| self.0.as_f64().map(|f| f.trunc() as i64))
    }

    pub fn as_f64(&self) -> Option<f64> {
        self.0.as_f64()
    }
}

impl From<i64> for Number {
    fn from(value: i64) -> Self {
        Self::from_i64(value)
    }
}

impl Serialize for Number {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Number {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        match value {
            Value::Number(number) => Ok(Number(number)),
            other => Err(D::Error::custom(format!("número esperado, veio {other}"))),
        }
    }
}

/// Candidato persistido da fila — o JSON que `toQueueCandidate` +
/// `writeQueue` gravam e o dreno TS lê. Todos os campos são tolerantes
/// (ausente/`null` = `None`); campos fora desta struct sobrevivem no `extra`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueCandidate {
    /// Identidade da SONDA (sempre gravada, `null` quando sem temporada).
    #[serde(default, serialize_with = "serialize_null")]
    pub probe_season: Option<Number>,
    /// Identidade da SONDA (sempre gravada, `null` quando sem episódio).
    #[serde(default, serialize_with = "serialize_null")]
    pub probe_episode: Option<Number>,
    pub info_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    /// Bytes do download (política seeds do dreno); ausente = cai no 💾 do title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seeders: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub br: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dubbed: Option<bool>,
    /// Classificação de áudio que só o banco tem (`_bankDub`): o dreno precisa
    /// dela para o protectBr do AllDebrid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bank_dub: Option<bool>,
    /// Condenação de áudio (mentira de release PT) preservada até o dreno.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lied: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imdb_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<Number>,
    /// Sempre gravado: pack de temporada tem `null` (cap da temporada).
    #[serde(default, serialize_with = "serialize_null")]
    pub episode: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_pack: Option<bool>,
    /// Evidência rara do pool seeds que o dreno leva ao `reserveObra`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rare: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_limit: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<Number>,
    /// Campos fora da struct (`[key: string]: unknown` do tipo TS): o
    /// `writeQueue` do Node os espalha de volta, então o porto idem.
    #[serde(flatten, default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

/// Campos "sempre presentes" do TS: `None` sai como `null`, não ausente.
fn serialize_null<S: Serializer>(value: &Option<Number>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(number) => number.serialize(serializer),
        None => serializer.serialize_none(),
    }
}

impl QueueCandidate {
    /// Hash normalizado (minúsculo) — o TS grava já normalizado.
    pub fn hash(&self) -> &str {
        &self.info_hash
    }

    fn number_i64(field: &Option<Number>) -> Option<i64> {
        field.as_ref().and_then(|n| n.as_i64())
    }

    pub fn season_i64(&self) -> Option<i64> {
        Self::number_i64(&self.season)
    }

    pub fn episode_i64(&self) -> Option<i64> {
        Self::number_i64(&self.episode)
    }

    /// Identidade da SONDA: `probeSeason ?? season ?? null` do dreno.
    pub fn probe_season_i64(&self) -> Option<i64> {
        Self::number_i64(&self.probe_season).or_else(|| self.season_i64())
    }

    /// Identidade da SONDA: `probeEpisode ?? (pack ? null : episode ?? null)`.
    pub fn probe_episode_i64(&self) -> Option<i64> {
        match Self::number_i64(&self.probe_episode) {
            Some(episode) => Some(episode),
            None if self.is_pack() => None,
            None => self.episode_i64(),
        }
    }

    pub fn slot_limit_i64(&self) -> Option<i64> {
        Self::number_i64(&self.slot_limit)
    }

    pub fn added_at_i64(&self) -> Option<i64> {
        Self::number_i64(&self.added_at)
    }

    pub fn size_i64(&self) -> Option<i64> {
        Self::number_i64(&self.size)
    }

    pub fn seeders_i64(&self) -> Option<i64> {
        Self::number_i64(&self.seeders)
    }

    pub fn is_pack(&self) -> bool {
        self.is_pack == Some(true)
    }

    pub fn is_rare(&self) -> bool {
        self.rare == Some(true)
    }
}
