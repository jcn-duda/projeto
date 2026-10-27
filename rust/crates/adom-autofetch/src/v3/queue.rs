//! Operações da fila v3 sobre o `NativeKv`: fila por busca, blacklist de
//! mortos e marker de aceite (o par Rust de `writeQueue`/`readQueue`/
//! `dropQueue`/`isDead`/`markerKey` do Node).

use adom_store::kv::NativeKv;
use serde_json::Value;

use crate::v3::{
    dead_key, marker_key, queue_key, queue_prefix, Number, QueueCandidate, NAMESPACE_V3,
};

/// Estado v3 sobre o `NativeKv`.
///
/// Pede o KV EMPRESTADO (`QueueV3::new(&kv)`): a mesma instância do store
/// serve fila v3, fila v1 e qualquer outro estado do processo — quem tem o
/// `NativeKv` não precisa abri-lo de novo nem clonar handle.
///
/// Um escritor por vez é premissa (mesma do [`crate::queue`]): a fila é
/// leitura-modificação-escrita sem CAS.
pub struct QueueV3<'a> {
    kv: &'a NativeKv,
}

/// Relatório do `write_queue` — as métricas (`autofetch.queue.added`) são do
/// chamador; o crate não conta nada.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WriteReport {
    /// Candidatos gravados (o `clean.length` do Node).
    pub kept: usize,
    /// Descartados: sem hash, hash duplicado, hash morto, acima da profundidade.
    pub dropped: usize,
}

impl<'a> QueueV3<'a> {
    pub fn new(kv: &'a NativeKv) -> Self {
        Self { kv }
    }

    /// Acesso cru ao KV (a ponte napi compartilha o handle com o chamador).
    pub fn kv(&self) -> &NativeKv {
        self.kv
    }

    /// Fila viva da busca. Garbage no valor devolve ERRO (o leitor TS tolera e
    /// devolve `[]`; o chamador nativo decide a tolerância — formatos ilegíveis
    /// não podem sumir em silêncio dentro do crate).
    pub fn read_queue(&self, search_key: &str, now_ms: i64) -> Result<Vec<QueueCandidate>, String> {
        if search_key.is_empty() {
            return Ok(Vec::new());
        }
        let Some(value) = self.kv.get_json(&queue_key(search_key), now_ms)? else {
            return Ok(Vec::new());
        };
        serde_json::from_value(value).map_err(|err| format!("fila v3 ilegível: {err}"))
    }

    /// Grava a fila da busca com as MESMAS regras do `writeQueue` do Node:
    /// sem hash sai; hash duplicado fica o PRIMEIRO; hash morto (quando
    /// adapter+conta dados) sai; `addedAt` ausente nasce agora; teto de
    /// profundidade; fila vazia esquece a chave.
    ///
    /// Divergência consciente do Node: o TS para no teto (`break`) e não conta
    /// o que sobrou; aqui TODOS os candidatos são avaliados e o corte por
    /// profundidade é o truncado final — a fila sobrevivente é a mesma, e o
    /// relatório de descartes sai completo (custa só leitura de `dead:` que o
    /// TS nem faria; as filas têm profundidade ~8).
    ///
    /// `scope` é o par `(adapterId, conta)`: o filtro de hash morto só vale com
    /// OS DOIS (o `deadKey` é por adapter:conta), como no `writeQueue` do Node.
    pub fn write_queue(
        &self,
        search_key: &str,
        candidates: &[QueueCandidate],
        ttl_seconds: i64,
        depth: usize,
        scope: Option<(&str, &str)>,
        now_ms: i64,
    ) -> Result<WriteReport, String> {
        if search_key.is_empty() {
            return Ok(WriteReport::default());
        }
        let mut seen = std::collections::HashSet::new();
        let mut clean: Vec<QueueCandidate> = Vec::new();
        let mut dropped = 0usize;
        for candidate in candidates {
            if candidate.info_hash.is_empty() {
                dropped += 1;
                continue;
            }
            let hash = candidate.info_hash.to_lowercase();
            if !seen.insert(hash.clone()) {
                dropped += 1;
                continue;
            }
            if let Some((adapter, account)) = scope {
                if self.is_dead(adapter, account, &hash, now_ms)? {
                    dropped += 1;
                    continue;
                }
            }
            let mut kept = candidate.clone();
            kept.info_hash = hash;
            // `addedAt: c.addedAt || Date.now()` do Node: ausente ou 0 nasce agora.
            let stale = kept.added_at.as_ref().and_then(Number::as_i64);
            if stale.unwrap_or(0) == 0 {
                kept.added_at = Some(Number::from_i64(now_ms));
            }
            clean.push(kept);
        }
        // Teto de profundidade: quem sobra fora também é descarte contado.
        let viable = candidates.len() - dropped;
        clean.truncate(depth.max(1));
        dropped += viable - clean.len();
        let key = queue_key(search_key);
        let report = if clean.is_empty() {
            self.kv.forget(&key)?;
            WriteReport { kept: 0, dropped }
        } else {
            let value = serde_json::to_value(&clean).map_err(|err| err.to_string())?;
            self.kv.put_json(&key, &value, ttl_seconds, now_ms)?;
            WriteReport {
                kept: clean.len(),
                dropped,
            }
        };
        Ok(report)
    }

    /// Aceita chave pronta (`autofetch:…`) ou searchKey, como o Node.
    ///
    /// `true` = havia fila e saiu (a métrica `autofetch.queue.dropped` é do
    /// chamador).
    pub fn drop_queue(&self, key_or_search_key: &str) -> Result<bool, String> {
        if key_or_search_key.is_empty() {
            return Ok(false);
        }
        let key = if key_or_search_key.starts_with(NAMESPACE_V3) {
            key_or_search_key.to_string()
        } else {
            queue_key(key_or_search_key)
        };
        self.kv.forget(&key)
    }

    /// Chaves de fila vivas (varredura de reindex/status; as vencidas saem na
    /// mesma passada, como o `cache.keys` do Node).
    pub fn queue_keys(&self, now_ms: i64) -> Result<Vec<String>, String> {
        self.kv.keys_matching(&queue_prefix(), now_ms)
    }

    /// Número de filas vivas e itens somados (o `snapshot().queues` do painel).
    pub fn totals(&self, now_ms: i64) -> Result<(usize, usize), String> {
        let mut queues = 0usize;
        let mut items = 0usize;
        for key in self.queue_keys(now_ms)? {
            let Some(value) = self.kv.get_json(&key, now_ms)? else {
                continue;
            };
            let Ok(candidates) = serde_json::from_value::<Vec<QueueCandidate>>(value) else {
                continue;
            };
            queues += 1;
            items += candidates.len();
        }
        Ok((queues, items))
    }

    /// Marca o hash como morto na conta (valor `1`, como o TS grava).
    pub fn mark_dead(
        &self,
        adapter_id: &str,
        account: &str,
        info_hash: &str,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> Result<(), String> {
        if adapter_id.is_empty() || account.is_empty() || info_hash.is_empty() {
            return Ok(());
        }
        self.kv.put_json(
            &dead_key(adapter_id, account, info_hash),
            &Value::from(1),
            ttl_seconds,
            now_ms,
        )
    }

    /// O hash está na blacklist da conta (`=== 1` do Node).
    pub fn is_dead(
        &self,
        adapter_id: &str,
        account: &str,
        info_hash: &str,
        now_ms: i64,
    ) -> Result<bool, String> {
        if adapter_id.is_empty() || account.is_empty() || info_hash.is_empty() {
            return Ok(false);
        }
        let Some(value) = self
            .kv
            .get_json(&dead_key(adapter_id, account, info_hash), now_ms)?
        else {
            return Ok(false);
        };
        Ok(value.as_i64() == Some(1))
    }

    /// Grava o marker na forma EXATA recebida (`1`, `{id}`, `{id,…meta}`) —
    /// quem monta o valor é o chamador ([`marker_value`]).
    pub fn set_marker(
        &self,
        adapter_id: &str,
        account: &str,
        info_hash: &str,
        value: &Value,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> Result<(), String> {
        if adapter_id.is_empty() || account.is_empty() || info_hash.is_empty() {
            return Ok(());
        }
        self.kv.put_json(
            &marker_key(adapter_id, account, info_hash),
            value,
            ttl_seconds,
            now_ms,
        )
    }

    /// Marker cru (truthiness do Node: `Some` = aceito; a forma é do chamador).
    pub fn marker(
        &self,
        adapter_id: &str,
        account: &str,
        info_hash: &str,
        now_ms: i64,
    ) -> Result<Option<Value>, String> {
        if adapter_id.is_empty() || account.is_empty() || info_hash.is_empty() {
            return Ok(None);
        }
        self.kv
            .get_json(&marker_key(adapter_id, account, info_hash), now_ms)
    }

    /// Apaga o marker (o evict/desbloqueio do recheck fazem isso no Node).
    pub fn forget_marker(
        &self,
        adapter_id: &str,
        account: &str,
        info_hash: &str,
    ) -> Result<bool, String> {
        if adapter_id.is_empty() || account.is_empty() || info_hash.is_empty() {
            return Ok(false);
        }
        self.kv.forget(&marker_key(adapter_id, account, info_hash))
    }
}

/// `markerValue(accepted, meta)` do Node: `1` sem meta/sem id, `{id}` quando só
/// há id, objeto completo com meta. Os leitores testam TRUTHINESS, nunca `===1`.
/// `acceptedAt` ausente na meta nasce de `now_ms` (o `Date.now()` do TS).
pub fn marker_value(
    accepted: bool,
    transfer_id: Option<&str>,
    meta: Option<&Value>,
    now_ms: i64,
) -> Value {
    let id = transfer_id.unwrap_or("");
    let has_id = accepted && !id.is_empty();
    match meta {
        None if has_id => serde_json::json!({ "id": id }),
        None => Value::from(1),
        Some(meta) => {
            let mut out = serde_json::Map::new();
            if has_id {
                out.insert("id".into(), Value::from(id));
            }
            // `if (meta.pool)`/`if (meta.obra)`: só string NÃO vazia entra.
            for field in ["pool", "obra", "title"] {
                if let Some(text) = meta.get(field).and_then(Value::as_str) {
                    if !text.is_empty() {
                        let value = if field == "title" {
                            Value::from(text.chars().take(120).collect::<String>())
                        } else {
                            Value::from(text)
                        };
                        out.insert(field.into(), value);
                    }
                }
            }
            let accepted_at = meta
                .get("acceptedAt")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .map(|value| value as i64)
                .unwrap_or(now_ms);
            out.insert("acceptedAt".into(), Value::from(accepted_at));
            out.insert(
                "br".into(),
                Value::from(meta.get("br").and_then(Value::as_bool) == Some(true)),
            );
            out.insert(
                "dubbed".into(),
                Value::from(meta.get("dubbed").and_then(Value::as_bool) == Some(true)),
            );
            Value::Object(out)
        }
    }
}
