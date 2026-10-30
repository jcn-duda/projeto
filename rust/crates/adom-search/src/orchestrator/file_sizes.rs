//! Fonte nativa da lista de arquivos e do total por hash (`fsz`/`tsz`).
//!
//! O `💾` de pack e de coleção sai da lista de arquivos do torrent, e essa
//! lista não vem da coleta: ela é persistida no KV nativo por outro componente
//! (`fsz:v1:<hash>`/`tsz:v1:<hash>`). Antes desta fonte o orquestrador só
//! conhecia o mapa do replay congelado, então em produção o `💾` nunca saía.
//!
//! A leitura é feita POR HASH e A CADA build: a lista pode ter chegado depois
//! da última busca, e o build precisa ver o que existe agora.

use std::collections::{BTreeMap, HashSet};

use adom_core::DebridFile;

use crate::list_builder::BuildContext;
use crate::raw_item::RawItem;

/// Lista de arquivos e total do torrent, lidos por hash (chave minúscula).
///
/// Hash sem registro simplesmente não aparece no mapa devolvido: "não sei" e
/// "não tem arquivo" são o mesmo silêncio para o build, que segue sem `💾`.
pub trait FileSizesSource: Send + Sync {
    fn files_for(&self, hashes: &[String]) -> BTreeMap<String, Vec<DebridFile>>;
    fn totals_for(&self, hashes: &[String]) -> BTreeMap<String, f64>;
}

/// Hashes únicos e não vazios dos itens, na ordem da primeira aparição.
///
/// `RawItem::hash` já devolve o hash em minúsculas (`extract_info_hash` normaliza),
/// então a chave pedida à fonte é a mesma que o build usa para consultar o mapa.
pub(super) fn hashes_of(items: &[RawItem]) -> Vec<String> {
    let mut seen = HashSet::new();
    items
        .iter()
        .map(RawItem::hash)
        .filter(|hash| !hash.is_empty() && seen.insert(hash.clone()))
        .collect()
}

/// Mescla a fonte no contexto do build. Só preenche hash que ainda NÃO está no
/// mapa: o que o replay congelado injetou vence, para a captura continuar
/// reproduzível. Sem fonte, ou sem hash, nada muda e a fonte nem é chamada.
pub(super) fn merge_file_sizes(
    source: Option<&dyn FileSizesSource>,
    items: &[RawItem],
    ctx: &mut BuildContext,
) {
    let Some(source) = source else {
        return;
    };
    let hashes = hashes_of(items);
    if hashes.is_empty() {
        return;
    }
    for (hash, files) in source.files_for(&hashes) {
        ctx.files_by_hash.entry(hash).or_insert(files);
    }
    for (hash, total) in source.totals_for(&hashes) {
        ctx.totals_by_hash.entry(hash).or_insert(total);
    }
}

#[cfg(test)]
#[path = "file_sizes_tests.rs"]
mod file_sizes_tests;
