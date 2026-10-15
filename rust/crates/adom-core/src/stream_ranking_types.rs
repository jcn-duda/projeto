//! Tipos do porte de `src/utils/stream-ranking.ts` — COMPARTILHADOS entre a
//! Parte 2 (`stream_ranking_dedupe::dedupe_by_hash`) e a Parte 3
//! (`sortAndLimit`). Qualquer campo novo tem que servir aos dois.
//!
//! O `RankingStream` espelha o `stream: any` do TS limitado ao que o
//! ranking lê/escreve. Os campos `_*` são INTERNOS do pipeline de busca
//! (invariante 2 do AGENTS.md: não podem vazar para a resposta) e viajam com
//! o nome TS original (o `serde rename` está manual nos impls lá embaixo,
//! porque `serde` derive é dev-depend neste crate). Campos do `Stream`
//! público que o dedupe só PRESERVA (`infoHash`, `title`, `name`,
//! `behaviorHints`) são tipados; qualquer OUTRO campo que o TS carregaria no
//! spread (`{...winner}`) cai em `extra` e volta igual na saída — é o que
//! mantém a paridade do golden sem tipar o `Stream` inteiro.
//!
//! Limitações do porte (fora da classe do corpus): valores não-numéricos em
//! `_seeders`/`_size`/`_bytes` são coercidos a `Number` na FRONTeira (o
//! chamador napi/oráculo faz o `Number()` do JS) — aqui o tipo já é `f64`;
//! surrogate órfão em `name`/`title` não é representado (o corpus evita).

use serde_json::{Map, Value};

/// Stream no estágio de ranking (dedupe + sort). `extra` carrega os campos
/// públicos que o ranking não lê e que o spread do TS preservaria.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RankingStream {
    pub info_hash: Option<String>,
    pub title: Option<String>,
    pub name: Option<String>,
    pub behavior_hints: Option<Value>,
    // ── internos `_*` ────────────────────────────────────────────────────
    pub quality: Option<String>,
    pub seeders: Option<f64>,
    pub size: Option<f64>,
    pub bytes: Option<f64>,
    /// Origem BR (campo, não regex — invariante 2).
    pub br: Option<bool>,
    /// Promessa de dublado (post BR), sem prova de arquivo.
    pub dub_claim: Option<bool>,
    /// Prova de dublado.
    pub dubbed: Option<bool>,
    pub indexer: Option<String>,
    pub tracker: Option<String>,
    /// `dn=` do magnet — o rótulo CAM do relabel depende dele.
    pub magnet_dn: Option<String>,
    /// Marca estrutural de pack multiobra.
    pub multi_work: Option<bool>,
    /// Pack multiobra ADMITIDO (opt-in TMDB): aciona nunca-P2P/fora do autofetch.
    pub multi_work_admitted: Option<bool>,
    /// Mentira comprovada de áudio (DubLieError) — nunca entra na lista.
    pub lied: Option<bool>,
    /// Demais campos preservados pelo spread `{...winner}` do TS.
    pub extra: Map<String, Value>,
}

/// Entrada do corte que o TS registra via `dropTrace(trace, loser, motivo)`.
/// Como o porte é PURO (sem IO, sem estado de trace mutável), o dedupe
/// devolve os cortes; quem chama empurra no trace. `reason` é sempre
/// `"dedupe"` na Parte 2 (o motivo fica para a Parte 3 reusar o tipo).
#[derive(Debug, Clone, PartialEq)]
pub struct TraceDrop {
    pub reason: String,
    /// `title || name`, primeira linha — o mesmo `label_of` do trace.
    pub label: String,
    pub br: bool,
    pub dubbed: Option<bool>,
    pub quality: Option<String>,
}

impl serde::Serialize for RankingStream {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = Map::new();
        let get: [Option<Value>; 17] = [
            self.info_hash.as_deref().map(Value::from),
            self.title.as_deref().map(Value::from),
            self.name.as_deref().map(Value::from),
            self.behavior_hints.clone(),
            self.quality.as_deref().map(Value::from),
            self.seeders
                .and_then(serde_json::Number::from_f64)
                .map(Value::Number),
            self.size
                .and_then(serde_json::Number::from_f64)
                .map(Value::Number),
            self.bytes
                .and_then(serde_json::Number::from_f64)
                .map(Value::Number),
            self.br.map(Value::from),
            self.dub_claim.map(Value::from),
            self.dubbed.map(Value::from),
            self.indexer.as_deref().map(Value::from),
            self.tracker.as_deref().map(Value::from),
            self.magnet_dn.as_deref().map(Value::from),
            self.multi_work.map(Value::from),
            self.multi_work_admitted.map(Value::from),
            self.lied.map(Value::from),
        ];
        const KEYS: [&str; 17] = [
            "infoHash",
            "title",
            "name",
            "behaviorHints",
            "_quality",
            "_seeders",
            "_size",
            "_bytes",
            "_br",
            "_dubClaim",
            "_dubbed",
            "_indexer",
            "_tracker",
            "_magnetDn",
            "_multiWork",
            "_multiWorkAdmitted",
            "_lied",
        ];
        for (key, value) in KEYS.iter().zip(get) {
            if let Some(value) = value {
                map.insert((*key).to_string(), value);
            }
        }
        for (key, value) in &self.extra {
            map.insert(key.clone(), value.clone());
        }
        let mut ser = serializer.serialize_map(Some(map.len()))?;
        for (key, value) in &map {
            ser.serialize_entry(key, value)?;
        }
        ser.end()
    }
}

impl<'de> serde::Deserialize<'de> for RankingStream {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let map = Map::<String, Value>::deserialize(deserializer)?;
        let mut s = RankingStream::default();
        for (key, value) in map {
            match key.as_str() {
                "infoHash" => s.info_hash = value.as_str().map(str::to_string),
                "title" => s.title = value.as_str().map(str::to_string),
                "name" => s.name = value.as_str().map(str::to_string),
                "behaviorHints" => s.behavior_hints = Some(value),
                "_quality" => s.quality = value.as_str().map(str::to_string),
                "_seeders" => s.seeders = value.as_f64(),
                "_size" => s.size = value.as_f64(),
                "_bytes" => s.bytes = value.as_f64(),
                "_br" => s.br = value.as_bool(),
                "_dubClaim" => s.dub_claim = value.as_bool(),
                "_dubbed" => s.dubbed = value.as_bool(),
                "_indexer" => s.indexer = value.as_str().map(str::to_string),
                "_tracker" => s.tracker = value.as_str().map(str::to_string),
                "_magnetDn" => s.magnet_dn = value.as_str().map(str::to_string),
                "_multiWork" => s.multi_work = value.as_bool(),
                "_multiWorkAdmitted" => s.multi_work_admitted = value.as_bool(),
                "_lied" => s.lied = value.as_bool(),
                _ => {
                    s.extra.insert(key, value);
                }
            }
        }
        Ok(s)
    }
}

impl serde::Serialize for TraceDrop {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = Map::new();
        map.insert("reason".to_string(), Value::from(self.reason.as_str()));
        map.insert("label".to_string(), Value::from(self.label.as_str()));
        map.insert("br".to_string(), Value::from(self.br));
        if let Some(dubbed) = self.dubbed {
            map.insert("dubbed".to_string(), Value::from(dubbed));
        }
        if let Some(quality) = self.quality.as_deref() {
            map.insert("quality".to_string(), Value::from(quality));
        }
        let mut ser = serializer.serialize_map(Some(map.len()))?;
        for (key, value) in &map {
            ser.serialize_entry(key, value)?;
        }
        ser.end()
    }
}
