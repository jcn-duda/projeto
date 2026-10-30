//! Fonte de produção da lista de arquivos (`fsz:v1`) e do total (`tsz:v1`)
//! por hash para o build do `/stream`.
//!
//! Sem ela o orquestrador montava a lista com os mapas vazios: o 💾 de pack e
//! de filme dentro de coleção pela lista de arquivos nunca saía no corte
//! nativo, embora a checagem do TorBox/Premiumize e o play já soubessem os
//! tamanhos. Quem grava é o `adom-debrid` (checagem nativa) e o Node (efeitos
//! do play), os dois no MESMO KV do `cache.db`.
//!
//! O KV é aberto a cada consulta pelo `production_kv` (guarda só a abertura
//! bem-sucedida): um lock no boot não pode desligar o 💾 até o restart.

use std::collections::BTreeMap;

use adom_core::DebridFile;
use adom_debrid::error::now_ms;
use adom_debrid::file_sizes::{read_files, read_totals};
use adom_debrid::native_kv::production_kv;
use adom_search::orchestrator::FileSizesSource;

pub(crate) struct NativeFileSizes;

impl FileSizesSource for NativeFileSizes {
    fn files_for(&self, hashes: &[String]) -> BTreeMap<String, Vec<DebridFile>> {
        match production_kv() {
            Some(kv) => read_files(kv, hashes, now_ms() as i64),
            None => BTreeMap::new(),
        }
    }

    fn totals_for(&self, hashes: &[String]) -> BTreeMap<String, f64> {
        match production_kv() {
            Some(kv) => read_totals(kv, hashes, now_ms() as i64),
            None => BTreeMap::new(),
        }
    }
}
