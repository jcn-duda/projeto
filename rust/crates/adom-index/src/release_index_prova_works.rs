//! Marca lied, limpeza do parcial e snapshots de obra do `idx:v14`.
//!
//! Submódulo de `prova` (provas laterais): reusa os helpers de linha viva e
//! as chaves `idx:v14:` do Node.

use std::collections::{HashMap, HashSet};

use adom_core::WorkTarget;
use rusqlite::params;

use super::{chave_obra, imdb_da_chave, imdb_exato};
use crate::release_index::{idx_prefix, IndexEntry, IndexedRelease, ReleaseIndexStore};

impl ReleaseIndexStore {
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
