//! Enumeração e manutenção do `mag:v1` — o lado que só o Rust faz.
//!
//! Desde a T2-L5b o Node não lê nem poda estas linhas: o painel pergunta o
//! agregado (`summary`/`live_count`/`live_lies`) e a página já filtrada
//! (`entries`), sem atravessar a chave de 50 mil linhas pela fronteira napi. A
//! poda (`sweep`) e o esvaziamento (`clear`) vivem aqui porque são varreduras do
//! namespace inteiro, não o ciclo de escrita do [`super::magnet_state`].
//!
//! O que a enumeração NÃO faz:
//! - não apaga vencidas: `entries`/`summary`/`live_count`/`live_lies` só
//!   ignoram a linha vencida (quem apaga é [`MagnetStateStore::sweep`]);
//! - não valida o escopo de conta: qualquer `mag:v1:<side>:<adapter>:<escopo>:
//!   <hash>` bem formado conta, inclusive escopo vazio (o escritor nunca produz
//!   um, porque sem apiKey não há chave).
//!
//! Ordem de leitura = ordem de escrita (`rowid`). É a mesma régua da evicção por
//! teto, então "mais antiga" quer dizer a mesma coisa na página e na poda.

use std::collections::{BTreeMap, HashSet};

use adom_core::prefix;
use rusqlite::{params, Connection};

use super::{is_expired, is_mark_value, is_valid_hash, magnet_key, read_row, MagnetStateStore};

/// Uma linha viva do `mag:v1`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MagEntry {
    pub adapter: String,
    pub side: String,
    pub hash: String,
    /// Segundos até vencer; `None` = linha sem janela (`expires_at` 0/ausente).
    pub ttl_remaining_seconds: Option<i64>,
}

/// Página da enumeração. `matched` é o total que casou os filtros, para o painel
/// paginar sem pedir tudo de novo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MagPage {
    pub items: Vec<MagEntry>,
    pub matched: u32,
    pub truncated: bool,
}

/// Contagem por adapter × lado, com a soma das janelas restantes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MagCount {
    pub adapter: String,
    pub side: String,
    pub count: u32,
    /// Soma dos segundos restantes das linhas vivas daquele adapter × lado.
    pub ttl_remaining_sum: i64,
}

/// O que a varredura removeu do namespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MagSweep {
    pub expired: u32,
    pub evicted: u32,
    /// Só as linhas PARSEÁVEIS removidas, por adapter × lado (decremento exato
    /// do painel). Linha ilegível sai sem contador — não há de quem descontar.
    pub counts: Vec<MagCount>,
}

impl MagnetStateStore {
    /// Linhas VIVAS, já filtradas e truncadas aqui: o painel pede 50 e não
    /// atravessa 50 mil chaves pela fronteira.
    ///
    /// `adapter`/`side`/`hash` são filtros EXATOS (`None` = sem filtro; o hash
    /// comparado em minúsculas). `limit == 0` = sem limite, todos os itens.
    /// `matched` conta tudo o que casou; `truncated` diz se a página é parcial.
    pub fn entries(
        &self,
        adapter: Option<&str>,
        side: Option<&str>,
        hash: Option<&str>,
        limit: u32,
        now_ms: i64,
    ) -> Result<MagPage, String> {
        let wanted_hash = hash.map(|value| value.to_ascii_lowercase());
        let conn = self.lock();
        let mut page = MagPage {
            items: Vec::new(),
            matched: 0,
            truncated: false,
        };
        for (_, key, expires_at) in scan_rows(&conn)? {
            if is_expired(expires_at, now_ms) {
                continue;
            }
            let Some(item) = parse_key(&key) else {
                continue;
            };
            if adapter.is_some_and(|value| value != item.adapter.as_str()) {
                continue;
            }
            if side.is_some_and(|value| value != item.side.as_str()) {
                continue;
            }
            if wanted_hash
                .as_deref()
                .is_some_and(|value| value != item.hash.as_str())
            {
                continue;
            }
            page.matched = page.matched.saturating_add(1);
            if limit == 0 || page.items.len() < limit as usize {
                page.items.push(MagEntry {
                    adapter: item.adapter,
                    side: item.side,
                    hash: item.hash,
                    ttl_remaining_seconds: remaining_seconds(expires_at, now_ms),
                });
            }
        }
        page.truncated = page.matched as usize > page.items.len();
        Ok(page)
    }

    /// Agregado por adapter × lado numa passada só, sem hash no payload.
    /// Ordenado por adapter e depois lado (determinismo do painel e dos testes).
    pub fn summary(&self, now_ms: i64) -> Result<Vec<MagCount>, String> {
        let conn = self.lock();
        let mut totals: BTreeMap<(String, String), (u32, i64)> = BTreeMap::new();
        for (_, key, expires_at) in scan_rows(&conn)? {
            if is_expired(expires_at, now_ms) {
                continue;
            }
            let Some(item) = parse_key(&key) else {
                continue;
            };
            let entry = totals.entry(pair(item)).or_insert((0, 0));
            entry.0 = entry.0.saturating_add(1);
            entry.1 = entry
                .1
                .saturating_add(remaining_seconds(expires_at, now_ms).unwrap_or(0));
        }
        Ok(totals
            .into_iter()
            .map(|((adapter, side), (count, ttl_remaining_sum))| MagCount {
                adapter,
                side,
                count,
                ttl_remaining_sum,
            })
            .collect())
    }

    /// Quantas linhas do namespace estão vivas — a mesma base do teto de
    /// [`Self::sweep`], contando também a linha ilegível que ainda não venceu.
    pub fn live_count(&self, now_ms: i64) -> Result<u32, String> {
        let conn = self.lock();
        let mut count = 0u32;
        for (_, _, expires_at) in scan_rows(&conn)? {
            if !is_expired(expires_at, now_ms) {
                count = count.saturating_add(1);
            }
        }
        Ok(count)
    }

    /// Os hashes da leva com `lie` VIVO em QUALQUER conta, na ordem da entrada
    /// e sem repetição. Uma passada só no namespace `lie`.
    pub fn live_lies(&self, hashes: &[String], now_ms: i64) -> Result<Vec<String>, String> {
        let conn = self.lock();
        let mut lies: HashSet<String> = HashSet::new();
        for (_, key, expires_at) in scan_rows(&conn)? {
            if is_expired(expires_at, now_ms) {
                continue;
            }
            if let Some(item) = parse_key(&key) {
                if item.side == "lie" {
                    lies.insert(item.hash);
                }
            }
        }
        let mut out = Vec::new();
        for hash in hashes {
            let normalized = hash.to_ascii_lowercase();
            if lies.contains(&normalized) && !out.contains(&normalized) {
                out.push(normalized);
            }
        }
        Ok(out)
    }

    /// Segundos até a marca vencer; `None` = ausente, vencida ou sem janela.
    /// Vencida não é apagada aqui (como no `live_flag`): quem apaga e
    /// contabiliza é o `sweep`. Hash fora de 40 hex é ignorado, como na
    /// escrita: essa marca nunca nasceu.
    pub fn remaining(
        &self,
        adapter: &str,
        api_key: &str,
        side: &str,
        hash: &str,
        now_ms: i64,
    ) -> Result<Option<i64>, String> {
        if adapter.is_empty()
            || api_key.is_empty()
            || !is_valid_hash(hash)
            || !matches!(side, "alive" | "bad" | "lie")
        {
            return Ok(None);
        }
        let key = magnet_key(side, adapter, api_key, hash);
        let conn = self.lock();
        let Some((raw, expires_at)) = read_row(&conn, &key)? else {
            return Ok(None);
        };
        if is_expired(expires_at, now_ms) {
            return Ok(None);
        }
        // Valor que não é marca não tem janela a mostrar (`state` também o
        // ignora) — devolver TTL aqui pintaria marca que não existe.
        if !is_mark_value(&raw) {
            return Ok(None);
        }
        Ok(remaining_seconds(expires_at, now_ms))
    }

    /// Apaga o `bad` do hash em QUALQUER conta do adapter (reparo do rd-warmer e
    /// limpeza do painel, que enumeram por adapter e não têm a apiKey) e devolve
    /// quantas LINHAS saíram (uma por conta) — é o número que o agregado durável
    /// do Node precisa baixar, então devolver booleano perderia a segunda conta.
    /// Adapter e hash entram LITERAIS no padrão, então os dois são validados
    /// antes de montar o `LIKE`.
    pub fn forget_bad_of(&self, adapter: &str, hash: &str) -> Result<u32, String> {
        if !is_valid_adapter(adapter) || !is_valid_hash(hash) {
            return Ok(0);
        }
        let pattern = format!("{}bad:{}:%:{}", prefix("mag"), like_literal(adapter), hash);
        let conn = self.lock();
        let removed = conn
            .execute(
                "DELETE FROM cache WHERE key LIKE ?1 ESCAPE '\\'",
                params![pattern],
            )
            .map_err(|err| err.to_string())?;
        Ok(to_u32(removed))
    }

    /// Esvazia o namespace inteiro (`mag:v1:%`) e devolve quantas linhas saíram.
    pub fn clear(&self) -> Result<u32, String> {
        let conn = self.lock();
        let removed = conn
            .execute("DELETE FROM cache WHERE key LIKE ?1", params![like_all()])
            .map_err(|err| err.to_string())?;
        Ok(to_u32(removed))
    }

    /// Poda do namespace, agora que o Node não apaga mais estas linhas: apaga as
    /// VENCIDAS (parseáveis ou não) e, acima de `max_entries` (`0` = sem teto),
    /// as mais antigas por `rowid`, somando cada removida em `counts`/`evicted`.
    /// Tudo numa transação só, em ordem de escrita.
    pub fn sweep(&self, max_entries: u32, now_ms: i64) -> Result<MagSweep, String> {
        let conn = self.lock();
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| err.to_string())?;
        let mut expired = 0u32;
        let mut counts: BTreeMap<(String, String), u32> = BTreeMap::new();
        // Vivas que sobram, na ordem em que podem ser evictadas: `rowid` cresce
        // com a escrita, então a primeira da lista é a mais antiga.
        let mut live: Vec<(i64, Option<(String, String)>)> = Vec::new();
        for (rowid, key, expires_at) in scan_rows(&tx)? {
            let parsed = parse_key(&key);
            if is_expired(expires_at, now_ms) {
                expired = expired.saturating_add(1);
                if let Some(item) = parsed {
                    *counts.entry(pair(item)).or_insert(0) += 1;
                }
                tx.execute("DELETE FROM cache WHERE key = ?1", params![key])
                    .map_err(|err| err.to_string())?;
                continue;
            }
            live.push((rowid, parsed.map(pair)));
        }
        // `max_entries == 0` é teto DESLIGADO, não "apaga tudo".
        let excess = if max_entries == 0 {
            0
        } else {
            live.len().saturating_sub(max_entries as usize)
        };
        let mut evicted = 0u32;
        for (rowid, side) in live.into_iter().take(excess) {
            tx.execute("DELETE FROM cache WHERE rowid = ?1", params![rowid])
                .map_err(|err| err.to_string())?;
            evicted = evicted.saturating_add(1);
            if let Some(side) = side {
                *counts.entry(side).or_insert(0) += 1;
            }
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok(MagSweep {
            expired,
            evicted,
            // Linha removida não tem janela restante a somar.
            counts: counts
                .into_iter()
                .map(|((adapter, side), count)| MagCount {
                    adapter,
                    side,
                    count,
                    ttl_remaining_sum: 0,
                })
                .collect(),
        })
    }
}

/// Chave de `mag:v1` já validada: `<side>:<adapter>:<escopo>:<hash>`.
struct ScannedKey {
    side: String,
    adapter: String,
    hash: String,
}

/// Parse da chave. O que não é `mag:v1:<alive|bad|lie>:<adapter não vazio>:
/// <escopo>:<40 hex>` é IGNORADO — não é chave desta enumeração.
fn parse_key(key: &str) -> Option<ScannedKey> {
    let rest = key.strip_prefix(prefix("mag"))?;
    // `splitn(4)`: a quarta parte fica com o resto, e um `:` sobrando reprova no
    // formato do hash em vez de virar hash com lixo.
    let mut parts = rest.splitn(4, ':');
    let side = parts.next()?;
    let adapter = parts.next()?;
    parts.next()?;
    let hash = parts.next()?;
    if !matches!(side, "alive" | "bad" | "lie") || adapter.is_empty() || !is_valid_hash(hash) {
        return None;
    }
    Some(ScannedKey {
        side: side.to_string(),
        adapter: adapter.to_string(),
        hash: hash.to_string(),
    })
}

/// Chave da agregação: adapter primeiro, lado depois (a ordem da saída).
fn pair(item: ScannedKey) -> (String, String) {
    (item.adapter, item.side)
}

/// Segundos até vencer (piso 0, divisão inteira); `None` = janela desligada.
fn remaining_seconds(expires_at: Option<i64>, now_ms: i64) -> Option<i64> {
    expires_at
        .filter(|ts| *ts > 0)
        .map(|ts| (ts.saturating_sub(now_ms) / 1_000).max(0))
}

/// Uma passada em TODAS as linhas do namespace (vencidas inclusive), em ordem de
/// escrita: é a ordem da página e a da evicção por teto.
fn scan_rows(conn: &Connection) -> Result<Vec<(i64, String, Option<i64>)>, String> {
    let mut stmt = conn
        .prepare("SELECT rowid, key, expires_at FROM cache WHERE key LIKE ?1 ORDER BY rowid")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![like_all()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

/// Padrão do namespace inteiro. O prefixo não tem `%`/`_`, então dispensa escape.
fn like_all() -> String {
    format!("{}%", prefix("mag"))
}

/// `_` é curinga do `LIKE` e o adapter validado pode contê-lo: sem o escape,
/// `bad:premium_ize` apagaria o `bad` de `premium-ize`.
fn like_literal(value: &str) -> String {
    value.replace('_', "\\_")
}

/// Alfabeto dos ids de adapter: `[A-Za-z0-9_-]+`.
fn is_valid_adapter(adapter: &str) -> bool {
    !adapter.is_empty()
        && adapter
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `usize` não atravessa o napi: o contrato devolve `u32`.
fn to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
