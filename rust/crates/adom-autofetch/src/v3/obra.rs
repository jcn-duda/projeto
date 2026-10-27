//! Registro durável por obra v3. Não faz reservas nem dispara downloads.
//! A leitura/alteração/gravação exige um único escritor, como a fila v3.

use adom_core::{read_record, ObraRecordEntry};
use adom_store::kv::NativeKv;
use serde_json::{json, Value};

pub struct ObraStoreV3<'a> {
    kv: &'a NativeKv,
}

impl<'a> ObraStoreV3<'a> {
    pub fn new(kv: &'a NativeKv) -> Self {
        Self { kv }
    }

    pub fn read(&self, key: &str, now: i64) -> Result<Vec<ObraRecordEntry>, String> {
        if key.is_empty() {
            return Ok(Vec::new());
        }
        Ok(self
            .kv
            .get_json(key, now)?
            .as_ref()
            .map(read_record)
            .unwrap_or_default())
    }

    /// Confirma um aceite: substitui o mesmo hash e mantém só a janela viva.
    /// O chamador entrega a chave calculada pelo núcleo e só chama após aceite.
    pub fn commit(
        &self,
        key: &str,
        entry: &ObraRecordEntry,
        ttl: i64,
        now: i64,
    ) -> Result<bool, String> {
        let hash = entry.hash.to_lowercase();
        if key.is_empty() || hash.is_empty() {
            return Ok(false);
        }
        let span = ttl.max(0).saturating_mul(1000);
        let mut kept: Vec<ObraRecordEntry> = self
            .read(key, now)?
            .into_iter()
            .filter(|e| {
                e.hash != hash && span > 0 && e.accepted_at > now.saturating_sub(span) as f64
            })
            .collect();
        let mut accepted = entry.clone();
        accepted.hash = hash;
        accepted.accepted_at = now as f64;
        kept.push(accepted);
        self.write(key, &kept, ttl, now)?;
        Ok(true)
    }

    /// Remove somente o hash terminal provado; a última entrada remove a chave.
    pub fn forget_hash(&self, key: &str, hash: &str, ttl: i64, now: i64) -> Result<bool, String> {
        let hash = hash.to_lowercase();
        if key.is_empty() || hash.is_empty() {
            return Ok(false);
        }
        let before = self.read(key, now)?;
        let kept: Vec<ObraRecordEntry> =
            before.iter().filter(|e| e.hash != hash).cloned().collect();
        if kept.len() == before.len() {
            return Ok(false);
        }
        if kept.is_empty() {
            self.kv.forget(key)?;
        } else {
            self.write(key, &kept, ttl, now)?;
        }
        Ok(true)
    }

    fn write(
        &self,
        key: &str,
        entries: &[ObraRecordEntry],
        ttl: i64,
        now: i64,
    ) -> Result<(), String> {
        let encoded: Vec<Value> = entries.iter().map(encode_entry).collect();
        self.kv
            .put_json(key, &json!({ "entries": encoded }), ttl.max(1), now)
    }
}

fn encode_entry(entry: &ObraRecordEntry) -> Value {
    let mut value = json!({"hash":entry.hash,"pool":entry.pool,"acceptedAt":entry.accepted_at,"br":entry.br,"dubbed":entry.dubbed});
    let obj = value.as_object_mut().expect("objeto literal");
    for (key, item) in [
        ("title", &entry.title),
        ("id", &entry.id),
        ("quality", &entry.quality),
    ] {
        if let Some(item) = item.as_ref().filter(|s| !s.is_empty()) {
            obj.insert(key.into(), json!(item));
        }
    }
    if entry.overflow {
        obj.insert("overflow".into(), json!(true));
    }
    value
}
