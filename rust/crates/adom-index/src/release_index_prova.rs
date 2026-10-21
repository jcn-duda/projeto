//! Provas laterais do `idx:v14` (F3.1a), no MESMO `cache.db` e com as MESMAS
//! chaves do Node. Portado de `src/utils/release-index-miss.ts`,
//! `release-index-file.ts`, `release-index-maintenance.ts` e dos trechos
//! `markLied`/`clearPartial`/`snapshotWorks` de `release-index.ts`.
//!
//! Diferenças conscientes:
//! - o Node regrava com o TTL restante arredondado em segundos; aqui só o
//!   `value` muda e o `expires_at` fica intacto (o instante de expiração não anda);
//! - `isMissing` e `isMissingQuiet` viram um só: o Rust não promove LRU, então a
//!   leitura já é sem efeito;
//! - as métricas `search.idx.*` ficam no Node, que continua contando.
//!
//! Submódulo de `release_index`, para enxergar o `conn` e os helpers privados.

use std::collections::{HashMap, HashSet};

use adom_core::WorkTarget;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{
    enforce_quota, idx_prefix, IndexEntry, IndexedRelease, ReleaseIndexStore, IDX_NAMESPACE,
};

/// Evidência por ARQUIVO (`idx:v14:file:<hash>`): o que o play viu dentro do
/// torrent. `e` é ausente quando o episódio não foi provado — o Node omite o
/// campo, e o Rust também.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FileEvidence {
    #[serde(default)]
    pub a: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub e: Option<u8>,
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub n: String,
}

/// `idx:v14:tt123` / `…:S2` / `…:S2E5`, como o `obraKey` do Node: o `E` é
/// anexado sempre que há episódio, mesmo sem temporada.
fn chave_obra(imdb_id: &str, season: Option<i64>, episode: Option<i64>) -> String {
    let mut key = format!("{}{}", idx_prefix(), imdb_id);
    if let Some(season) = season {
        key.push_str(&format!(":S{season}"));
    }
    if let Some(episode) = episode {
        key.push_str(&format!("E{episode}"));
    }
    key
}

/// Extrai o `tt<dígitos>` de uma chave já sem o prefixo `idx:v14:`. Só aceita
/// fim de chave ou `:` logo depois, para `tt12` não casar com `tt1`.
fn imdb_da_chave(rest: &str) -> Option<&str> {
    let digitos = rest.strip_prefix("tt")?;
    let n = digitos.bytes().take_while(u8::is_ascii_digit).count();
    if n == 0 {
        return None;
    }
    let fim = 2 + n;
    match rest.as_bytes().get(fim) {
        None | Some(b':') => Some(&rest[..fim]),
        _ => None,
    }
}

/// `/^tt\d+$/` do `forgetAutofetchHash`: o id inteiro precisa ser `tt` + dígitos.
fn imdb_exato(imdb_id: &str) -> bool {
    imdb_id
        .strip_prefix("tt")
        .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
}

impl ReleaseIndexStore {
    /// Gate do módulo pai: TTL > 0, id `tt…` e hash presente.
    fn habilitado(&self, imdb_id: &str, hash: &str) -> bool {
        self.ttl_seconds > 0 && imdb_id.starts_with("tt") && !hash.is_empty()
    }

    /// Linha viva (não expirada) da chave, com o valor cru.
    fn vivo(&self, key: &str, now_ms: i64) -> Option<String> {
        let conn = self.lock();
        conn.query_row(
            "SELECT value, expires_at FROM cache WHERE key = ?1",
            params![key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .ok()
        .filter(|(_, expires_at)| *expires_at >= now_ms)
        .map(|(value, _)| value)
    }

    /// Grava com o TTL do store (renova a expiração, como o `cache.set` do Node).
    fn grava_vivo(&self, key: &str, value: &str, now_ms: i64) -> Result<(), String> {
        let expires_at = now_ms.saturating_add(self.ttl_seconds.saturating_mul(1_000) as i64);
        let conn = self.lock();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
            params![key, value, expires_at],
        )
        .map_err(|err| err.to_string())?;
        enforce_quota(&conn, IDX_NAMESPACE, now_ms)
    }

    /// Troca só o valor, mantendo a expiração que a linha já tinha.
    fn reescreve(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.lock();
        conn.execute(
            "UPDATE cache SET value = ?2 WHERE key = ?1",
            params![key, value],
        )
        .map(|_| ())
        .map_err(|err| err.to_string())
    }

    fn apaga(&self, key: &str) -> Result<(), String> {
        let conn = self.lock();
        conn.execute("DELETE FROM cache WHERE key = ?1", params![key])
            .map(|_| ())
            .map_err(|err| err.to_string())
    }

    /// Todas as linhas vivas da obra: a chave `base` e as que começam com
    /// `base:`. O `:` evita que `tt1` pegue `tt12`.
    fn vivas_da_obra(&self, base: &str, now_ms: i64) -> Result<Vec<(String, String)>, String> {
        let filho = format!("{base}:");
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT key, value FROM cache
                 WHERE (key = ?1 OR substr(key, 1, length(?2)) = ?2) AND expires_at >= ?3",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![base, filho, now_ms], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string());
        rows
    }

    /// Marca nova (`{at}`): devolve `true` só se a chave ainda não estava viva.
    fn marca_nova(&self, key: &str, now_ms: i64) -> Result<bool, String> {
        let nova = self.vivo(key, now_ms).is_none();
        self.grava_vivo(key, &json!({ "at": now_ms }).to_string(), now_ms)?;
        Ok(nova)
    }

    /// `markMissing`: este hash NÃO serve este episódio. Sem temporada e
    /// episódio não há o que provar.
    pub fn mark_missing(
        &self,
        imdb_id: &str,
        location: WorkTarget,
        hash: &str,
        now_ms: i64,
    ) -> Result<bool, String> {
        let (Some(season), Some(episode)) = (location.season, location.episode) else {
            return Ok(false);
        };
        if !self.habilitado(imdb_id, hash) {
            return Ok(false);
        }
        let key = format!(
            "{}miss:{imdb_id}:S{season}E{episode}:{}",
            idx_prefix(),
            hash.to_lowercase()
        );
        self.marca_nova(&key, now_ms)
    }

    /// `markMissingSeason`: este hash não serve nenhum episódio da temporada.
    pub fn mark_missing_season(
        &self,
        imdb_id: &str,
        season: i64,
        hash: &str,
        now_ms: i64,
    ) -> Result<bool, String> {
        if !self.habilitado(imdb_id, hash) {
            return Ok(false);
        }
        let key = format!(
            "{}missS:{imdb_id}:S{season}:{}",
            idx_prefix(),
            hash.to_lowercase()
        );
        self.marca_nova(&key, now_ms)
    }

    /// `isMissing`/`isMissingQuiet`: temporada primeiro, depois o episódio.
    pub fn is_missing(&self, imdb_id: &str, location: WorkTarget, hash: &str, now_ms: i64) -> bool {
        if !self.habilitado(imdb_id, hash) {
            return false;
        }
        if let Some(season) = location.season {
            let key = format!(
                "{}missS:{imdb_id}:S{season}:{}",
                idx_prefix(),
                hash.to_lowercase()
            );
            if self.vivo(&key, now_ms).is_some() {
                return true;
            }
        }
        let (Some(season), Some(episode)) = (location.season, location.episode) else {
            return false;
        };
        let key = format!(
            "{}miss:{imdb_id}:S{season}E{episode}:{}",
            idx_prefix(),
            hash.to_lowercase()
        );
        self.vivo(&key, now_ms).is_some()
    }

    /// `markFileEvidence`: devolve `true` só na primeira prova do hash.
    pub fn mark_file_evidence(
        &self,
        hash: &str,
        evidence: &FileEvidence,
        now_ms: i64,
    ) -> Result<bool, String> {
        if self.ttl_seconds == 0 || hash.is_empty() {
            return Ok(false);
        }
        let key = format!("{}file:{}", idx_prefix(), hash.to_lowercase());
        let nova = self.vivo(&key, now_ms).is_none();
        let encoded = serde_json::to_string(evidence).map_err(|err| err.to_string())?;
        self.grava_vivo(&key, &encoded, now_ms)?;
        Ok(nova)
    }

    /// `fileEvidence`: a prova por arquivo do hash, se ainda viva.
    pub fn file_evidence(&self, hash: &str, now_ms: i64) -> Option<FileEvidence> {
        if self.ttl_seconds == 0 || hash.is_empty() {
            return None;
        }
        let key = format!("{}file:{}", idx_prefix(), hash.to_lowercase());
        serde_json::from_str(&self.vivo(&key, now_ms)?).ok()
    }

    /// `markLied`: marca o hash nas três chaves da obra (episódio, temporada,
    /// raiz) onde ele aparece. Devolve quantas releases mudaram de `false`
    /// para `true`.
    pub fn mark_lied(
        &self,
        imdb_id: &str,
        location: WorkTarget,
        hash: &str,
        now_ms: i64,
    ) -> Result<usize, String> {
        if !self.habilitado(imdb_id, hash) {
            return Ok(0);
        }
        let normalized = hash.to_lowercase();
        let chaves: HashSet<String> = [
            chave_obra(imdb_id, location.season, location.episode),
            chave_obra(imdb_id, location.season, None),
            chave_obra(imdb_id, None, None),
        ]
        .into_iter()
        .collect();
        let mut changed = 0;
        for key in chaves {
            let Some(raw) = self.vivo(&key, now_ms) else {
                continue;
            };
            let Ok(mut entry) = serde_json::from_str::<IndexEntry>(&raw) else {
                continue;
            };
            if !entry.releases.iter().any(|r| r.hash == normalized) {
                continue;
            }
            for release in entry.releases.iter_mut() {
                if release.hash == normalized && !release.lied {
                    release.lied = true;
                    changed += 1;
                }
            }
            let encoded = serde_json::to_string(&entry).map_err(|err| err.to_string())?;
            self.grava_vivo(&key, &encoded, now_ms)?;
        }
        Ok(changed)
    }

    /// `clearPartial`: tira o flag `partial` de TODAS as chaves vivas da obra,
    /// mantendo as releases. Devolve quantas chaves foram limpas.
    pub fn clear_partial(&self, imdb_id: &str, now_ms: i64) -> Result<usize, String> {
        if self.ttl_seconds == 0 || !imdb_id.starts_with("tt") {
            return Ok(0);
        }
        let base = chave_obra(imdb_id, None, None);
        let mut cleared = 0;
        for (key, raw) in self.vivas_da_obra(&base, now_ms)? {
            let Ok(mut entry) = serde_json::from_str::<IndexEntry>(&raw) else {
                continue;
            };
            if !entry.partial {
                continue;
            }
            entry.partial = false;
            let encoded = serde_json::to_string(&entry).map_err(|err| err.to_string())?;
            self.reescreve(&key, &encoded)?;
            cleared += 1;
        }
        Ok(cleared)
    }

    /// `forgetAutofetchHash`: remove o hash das submissões `source:autofetch` da
    /// obra. Observação pública do mesmo hash fica. Chave que esvazia é apagada.
    pub fn forget_autofetch_hash(
        &self,
        imdb_id: &str,
        hash: &str,
        now_ms: i64,
    ) -> Result<usize, String> {
        let wanted = hash.to_lowercase();
        if self.ttl_seconds == 0 || !imdb_exato(imdb_id) || wanted.is_empty() {
            return Ok(0);
        }
        let base = chave_obra(imdb_id, None, None);
        let mut removed = 0;
        for (key, raw) in self.vivas_da_obra(&base, now_ms)? {
            let Ok(entry) = serde_json::from_str::<IndexEntry>(&raw) else {
                continue;
            };
            if entry.releases.is_empty() {
                continue;
            }
            let antes = entry.releases.len();
            let mantidas: Vec<IndexedRelease> = entry
                .releases
                .iter()
                .filter(|r| {
                    let drop = r.hash == wanted && r.source.as_deref() == Some("autofetch");
                    if drop {
                        removed += 1;
                    }
                    !drop
                })
                .cloned()
                .collect();
            if mantidas.len() == antes {
                continue;
            }
            if mantidas.is_empty() {
                self.apaga(&key)?;
            } else {
                let nova = IndexEntry {
                    releases: mantidas,
                    ..entry
                };
                let encoded = serde_json::to_string(&nova).map_err(|err| err.to_string())?;
                self.reescreve(&key, &encoded)?;
            }
        }
        Ok(removed)
    }

    /// `snapshotWorks`: agrega as chaves `idx` das obras pedidas, dedupe por
    /// hash (o `seenAt` mais recente vence). Só lê: não toca na linha.
    pub fn snapshot_works(
        &self,
        imdb_ids: &[String],
        now_ms: i64,
    ) -> Result<HashMap<String, Vec<IndexedRelease>>, String> {
        let pedidas: HashSet<&str> = imdb_ids
            .iter()
            .map(String::as_str)
            .filter(|id| id.starts_with("tt"))
            .collect();
        self.agrega_obras(Some(&pedidas), now_ms)
    }

    /// `snapshotAllWorks`: o mesmo agregado, sem filtro de obra (catálogo).
    pub fn snapshot_all_works(
        &self,
        now_ms: i64,
    ) -> Result<HashMap<String, Vec<IndexedRelease>>, String> {
        self.agrega_obras(None, now_ms)
    }

    /// Uma varredura do namespace inteiro. A ordem das releases segue a primeira
    /// vez que cada hash apareceu, como o `Map` do Node.
    fn agrega_obras(
        &self,
        filtro: Option<&HashSet<&str>>,
        now_ms: i64,
    ) -> Result<HashMap<String, Vec<IndexedRelease>>, String> {
        let base = idx_prefix();
        let linhas: Vec<(String, String)> = {
            let conn = self.lock();
            let mut stmt = conn
                .prepare(
                    "SELECT key, value FROM cache
                     WHERE substr(key, 1, length(?1)) = ?1 AND expires_at >= ?2",
                )
                .map_err(|err| err.to_string())?;
            let out = stmt
                .query_map(params![base, now_ms], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string());
            out?
        };

        let mut por_obra: HashMap<String, (Vec<IndexedRelease>, HashMap<String, usize>)> =
            HashMap::new();
        for (key, raw) in linhas {
            let Some(rest) = key.strip_prefix(base) else {
                continue;
            };
            // `miss:`, `missS:` e `file:` caem aqui: não começam com `tt`.
            let Some(imdb) = imdb_da_chave(rest) else {
                continue;
            };
            if filtro.is_some_and(|f| !f.contains(imdb)) {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<IndexEntry>(&raw) else {
                continue;
            };
            let (lista, posicao) = por_obra.entry(imdb.to_string()).or_default();
            for rel in entry.releases {
                if rel.hash.is_empty() {
                    continue;
                }
                match posicao.get(&rel.hash) {
                    Some(&i) => {
                        if rel.seen_at > lista[i].seen_at {
                            lista[i] = rel;
                        }
                    }
                    None => {
                        posicao.insert(rel.hash.clone(), lista.len());
                        lista.push(rel);
                    }
                }
            }
        }
        Ok(por_obra
            .into_iter()
            .filter(|(_, (lista, _))| !lista.is_empty())
            .map(|(imdb, (lista, _))| (imdb, lista))
            .collect())
    }
}

#[cfg(test)]
#[path = "release_index_prova_tests.rs"]
mod tests;
