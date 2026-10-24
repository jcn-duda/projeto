//! Handle do índice de releases `idx:v14` para o Node (F3.1, lado Rust).
//!
//! O store mora no `adom-index`; aqui é só a casca napi. Síncrono por design:
//! o Node chama de dentro das decisões, e a escrita fecha no SQLite antes de
//! devolver, então uma leitura logo depois da escrita já vê o que foi gravado
//! (o `harvest-worker` depende disso). O relógio entra por parâmetro, como no
//! resto do núcleo.

use std::path::Path;

use adom_core::{BankRow, WorkTarget};
use adom_index::{FileEvidence, RecordOptions, ReleaseIndexStore};
use napi::Error;
use napi_derive::napi;
use serde_json::Value;

fn erro(err: String) -> Error {
    Error::from_reason(err)
}

fn alvo(season: Option<i64>, episode: Option<i64>) -> WorkTarget {
    WorkTarget { season, episode }
}

/// Linha do acervo já lida pelo Node (`hash`, `uri`, `title`).
#[napi(object)]
pub struct BankRowInput {
    pub hash: String,
    pub uri: String,
    pub title: String,
}

/// Opções do `record`: `keepPartial` nunca rebaixa parcial; `source` é `autofetch`.
#[napi(object)]
pub struct RecordOptionsInput {
    pub partial: Option<bool>,
    pub keep_partial: Option<bool>,
    pub source: Option<String>,
    pub supplemental: Option<bool>,
}

#[napi]
pub struct IdxStore {
    inner: ReleaseIndexStore,
}

#[napi]
impl IdxStore {
    /// Abre (ou cria) o `cache.db` em `dbPath`, com os tetos do operador.
    /// `:memory:` sobe só em memória (`CACHE_PERSIST=false`).
    #[napi(constructor)]
    pub fn new(db_path: String, ttl_seconds: i64, max_releases: i64) -> napi::Result<Self> {
        let base = if db_path == ":memory:" {
            ReleaseIndexStore::open_memory()
        } else {
            ReleaseIndexStore::open(Path::new(&db_path))
        };
        let inner = base
            .map_err(erro)?
            .with_limits(ttl_seconds.max(0) as u64, max_releases.max(1) as usize);
        Ok(Self { inner })
    }

    /// Existência exata de uma chave viva do namespace (diagnóstico e testes).
    #[napi]
    pub fn has_key(&self, key: String, now_ms: i64) -> bool {
        self.inner.has_key(&key, now_ms)
    }

    /// Apaga o namespace `idx` inteiro; devolve quantas linhas saíram.
    #[napi]
    pub fn clear(&self) -> napi::Result<i64> {
        self.inner.clear_all().map(|n| n as i64).map_err(erro)
    }

    /// Linhas vivas do namespace `idx` (o `status().entries` do painel).
    #[napi]
    pub fn entries(&self, now_ms: i64) -> napi::Result<i64> {
        self.inner
            .count_live(now_ms)
            .map(|n| n as i64)
            .map_err(erro)
    }

    /// Releases da obra (episódio → temporada → raiz), dedupe por hash.
    #[napi]
    pub fn lookup(
        &self,
        imdb_id: String,
        season: Option<i64>,
        episode: Option<i64>,
        now_ms: i64,
    ) -> Value {
        let releases = self.inner.lookup(&imdb_id, alvo(season, episode), now_ms);
        serde_json::to_value(releases).unwrap_or(Value::Null)
    }

    #[napi]
    pub fn is_partial(
        &self,
        imdb_id: String,
        season: Option<i64>,
        episode: Option<i64>,
        now_ms: i64,
    ) -> bool {
        self.inner
            .is_partial(&imdb_id, alvo(season, episode), now_ms)
    }

    #[napi]
    pub fn is_missing(
        &self,
        imdb_id: String,
        season: Option<i64>,
        episode: Option<i64>,
        hash: String,
        now_ms: i64,
    ) -> bool {
        self.inner
            .is_missing(&imdb_id, alvo(season, episode), &hash, now_ms)
    }

    #[napi]
    pub fn mark_missing(
        &self,
        imdb_id: String,
        season: Option<i64>,
        episode: Option<i64>,
        hash: String,
        now_ms: i64,
    ) -> napi::Result<bool> {
        self.inner
            .mark_missing(&imdb_id, alvo(season, episode), &hash, now_ms)
            .map_err(erro)
    }

    #[napi]
    pub fn mark_missing_season(
        &self,
        imdb_id: String,
        season: i64,
        hash: String,
        now_ms: i64,
    ) -> napi::Result<bool> {
        self.inner
            .mark_missing_season(&imdb_id, season, &hash, now_ms)
            .map_err(erro)
    }

    #[napi]
    pub fn mark_file_evidence(
        &self,
        hash: String,
        evidence: Value,
        now_ms: i64,
    ) -> napi::Result<bool> {
        let evidence: FileEvidence =
            serde_json::from_value(evidence).map_err(|err| erro(err.to_string()))?;
        self.inner
            .mark_file_evidence(&hash, &evidence, now_ms)
            .map_err(erro)
    }

    /// Evidência por arquivo do hash, ou `null`.
    #[napi]
    pub fn file_evidence(&self, hash: String, now_ms: i64) -> Value {
        serde_json::to_value(self.inner.file_evidence(&hash, now_ms)).unwrap_or(Value::Null)
    }

    #[napi]
    pub fn mark_lied(
        &self,
        imdb_id: String,
        season: Option<i64>,
        episode: Option<i64>,
        hash: String,
        now_ms: i64,
    ) -> napi::Result<i64> {
        self.inner
            .mark_lied(&imdb_id, alvo(season, episode), &hash, now_ms)
            .map(|n| n as i64)
            .map_err(erro)
    }

    #[napi]
    pub fn clear_partial(&self, imdb_id: String, now_ms: i64) -> napi::Result<i64> {
        self.inner
            .clear_partial(&imdb_id, now_ms)
            .map(|n| n as i64)
            .map_err(erro)
    }

    #[napi]
    pub fn forget_autofetch_hash(
        &self,
        imdb_id: String,
        hash: String,
        now_ms: i64,
    ) -> napi::Result<i64> {
        self.inner
            .forget_autofetch_hash(&imdb_id, &hash, now_ms)
            .map(|n| n as i64)
            .map_err(erro)
    }

    /// `{ imdb: Release[] }` só das obras pedidas.
    #[napi]
    pub fn snapshot_works(&self, imdb_ids: Vec<String>, now_ms: i64) -> napi::Result<Value> {
        let mapa = self.inner.snapshot_works(&imdb_ids, now_ms).map_err(erro)?;
        Ok(serde_json::to_value(mapa).unwrap_or(Value::Null))
    }

    /// `{ imdb: Release[] }` de todo o namespace (catálogo).
    #[napi]
    pub fn snapshot_all_works(&self, now_ms: i64) -> napi::Result<Value> {
        let mapa = self.inner.snapshot_all_works(now_ms).map_err(erro)?;
        Ok(serde_json::to_value(mapa).unwrap_or(Value::Null))
    }

    /// `record`: devolve quantos hashes NOVOS entraram. `bank` são as linhas do
    /// acervo que o Node já leu para os candidatos; o núcleo só consulta por hash.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn record(
        &self,
        imdb_id: String,
        season: Option<i64>,
        episode: Option<i64>,
        items: Vec<Value>,
        opts: RecordOptionsInput,
        bank: Vec<BankRowInput>,
        now_ms: i64,
    ) -> napi::Result<i64> {
        let linhas: Vec<BankRow> = bank
            .into_iter()
            .map(|row| BankRow {
                hash: row.hash,
                uri: row.uri,
                title: row.title,
            })
            .collect();
        let consulta = |hashes: &[String]| -> Vec<BankRow> {
            linhas
                .iter()
                .filter(|row| hashes.contains(&row.hash))
                .cloned()
                .collect()
        };
        let novos = self
            .inner
            .record(
                &imdb_id,
                alvo(season, episode),
                &items,
                RecordOptions {
                    partial: opts.partial.unwrap_or(false),
                    keep_partial: opts.keep_partial.unwrap_or(false),
                    source: opts.source.as_deref(),
                    supplemental: opts.supplemental.unwrap_or(false),
                },
                self.inner.ttl(),
                self.inner.max_releases(),
                now_ms,
                Some(&consulta),
            )
            .map_err(erro)?;
        Ok(novos as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_700_000_000_000;
    const H1: &str = "aa01000000000000000000000000000000000001";

    fn caminho_temporario(nome: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir()
            .join(format!("idx-napi-{nome}-{nanos}.db"))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn record_com_acervo_e_lookup_pela_classe() {
        let store = IdxStore::new(caminho_temporario("record"), 30 * 24 * 3600, 60).expect("abre");
        let item =
            json!({ "title": "Filme Teste 2024 1080p DUBLADO", "infoHash": H1, "isBr": true });
        let novos = store
            .record(
                "tt1".into(),
                None,
                None,
                vec![item],
                RecordOptionsInput {
                    partial: Some(true),
                    keep_partial: None,
                    source: None,
                    supplemental: None,
                },
                vec![BankRowInput {
                    hash: H1.into(),
                    uri: String::new(),
                    title: String::new(),
                }],
                NOW,
            )
            .expect("record");
        assert_eq!(novos, 1);
        assert!(
            store.is_partial("tt1".into(), None, None, NOW),
            "partial chega ao store"
        );
        let achados = store.lookup("tt1".into(), None, None, NOW);
        assert_eq!(achados.as_array().map(Vec::len), Some(1));
        assert_eq!(achados[0]["hash"], H1);
    }

    #[test]
    fn mark_missing_e_file_evidence_pela_classe() {
        let store = IdxStore::new(caminho_temporario("prova"), 30 * 24 * 3600, 60).expect("abre");
        assert!(store
            .mark_missing("tt1".into(), Some(1), Some(2), H1.into(), NOW)
            .unwrap());
        assert!(store.is_missing("tt1".into(), Some(1), Some(2), H1.into(), NOW));
        let ev = json!({ "a": "por", "q": "1080p", "n": "x" });
        assert!(store.mark_file_evidence(H1.into(), ev, NOW).unwrap());
        assert_eq!(store.file_evidence(H1.into(), NOW)["q"], "1080p");
        assert!(store.file_evidence("bb".repeat(20), NOW).is_null());
    }
}
