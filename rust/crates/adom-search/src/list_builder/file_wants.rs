//! Hashes cuja LISTA DE ARQUIVOS o debrid deve ler junto com a checagem de
//! cache (porte de `packHashesMissingFiles`, `test/helpers/pipeline-oracle/
//! episode-size.ts`, oráculo: branch `esm`).
//!
//! A lista de arquivos é a ÚNICA fonte do tamanho do episódio dentro de um
//! pack, do tamanho de um item que o tracker deixou sem tamanho e da
//! resolução quando o nome não a diz. Pedi-la na mesma passada da checagem
//! evita uma ida extra ao debrid depois do build.

use std::collections::{BTreeMap, HashSet};

use adom_core::{
    is_season_pack_release, names_multiple_episodes, DebridFile, RankingStream, UNKNOWN_QUALITY,
};

/// Hashes (minúsculos, sem duplicata, na ordem da 1ª aparição) que precisam
/// da lista de arquivos e que `known` (o memo `fsz`) ainda não tem.
///
/// Entra quem for pack OU vier sem tamanho OU sem resolução:
/// - filme: pack = coleção multiobra (`multi_work`, marcada na montagem);
/// - série: pack de temporada, ou título que nomeia mais de um episódio
///   ("S01.Dub E01-E08", capítulos de novela) — o tamanho dessa faixa é o
///   total dela, e o do episódio só sai dos arquivos.
///
/// Episódio avulso com tamanho e resolução fica de fora: o total dele já é o
/// do episódio.
pub fn pack_hashes_missing_files(
    streams: &[RankingStream],
    season: Option<i64>,
    known: &BTreeMap<String, Vec<DebridFile>>,
) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for stream in streams {
        // Hash ausente viraria a string vazia na fila de leitura do debrid.
        let Some(raw_hash) = stream.info_hash.as_deref().filter(|h| !h.is_empty()) else {
            continue;
        };
        let title = stream
            .title
            .as_deref()
            .or(stream.name.as_deref())
            .unwrap_or("");
        let pack = match season {
            None => stream.multi_work == Some(true),
            Some(_) => is_season_pack_release(title, season) || names_multiple_episodes(title),
        };
        // Sem resolução: só o rótulo explícito conta. `None`/vazio NÃO é
        // "sem resolução" — o TS só olhava o rótulo, e tratar a ausência como
        // ruim mandaria à leitura de arquivos todo item sem qualidade medida.
        let no_quality = stream.quality.as_deref() == Some(UNKNOWN_QUALITY);
        if !(pack || lacks_size(stream) || no_quality) {
            continue;
        }
        // O memo `fsz` é indexado em minúsculas: a chave tem que bater com ele.
        let hash = raw_hash.to_ascii_lowercase();
        if known.contains_key(&hash) {
            continue;
        }
        if seen.insert(hash.clone()) {
            out.push(hash);
        }
    }
    out
}

/// Item sem tamanho = nem `size` nem `bytes` positivos. Não usamos o 💾 do
/// texto (régua do TS) porque aqui o stream ainda não foi formatado; `size` e
/// `bytes` vêm do mesmo `size_bytes` do item (`stream_map.rs`). O sentinela
/// "1 KB" das fontes BR e os tamanhos implausíveis já chegam como `None`
/// (`raw_item::known_size`), então não precisam de tratamento aqui.
fn lacks_size(stream: &RankingStream) -> bool {
    let positive = |v: Option<f64>| v.is_some_and(|n| n > 0.0);
    !positive(stream.size) && !positive(stream.bytes)
}
