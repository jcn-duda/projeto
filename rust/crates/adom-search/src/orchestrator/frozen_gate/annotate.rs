//! Reposicao dos campos que o build do Node fechou (`apply-debrid.json`).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::audio::AudioProof;
use super::capture::{AppliedFields, ApplyDebridFile, DebridResult};

/// Hash de um stream já resolvido pelo debrid. O `infoHash` some do envelope
/// (`url` substitui), então o caminho `/resolve/<hash>` é a única âncora.
pub(super) fn applied_hash(item: &Value) -> Option<String> {
    for field in ["infoHash", "magnet"] {
        if let Some(hash) = item
            .get(field)
            .and_then(Value::as_str)
            .and_then(adom_core::extract_info_hash)
        {
            let hash = hash.trim().to_ascii_lowercase();
            if !hash.is_empty() {
                return Some(hash);
            }
        }
    }
    let url = item.get("url").and_then(Value::as_str)?;
    let (_, rest) = url.split_once("/resolve/")?;
    let hash: String = rest
        .chars()
        .take_while(char::is_ascii_hexdigit)
        .take(40)
        .collect();
    (hash.len() == 40).then(|| hash.to_ascii_lowercase())
}

/// Veredito de cache POR HASH a partir do `apply-debrid.json` — a checagem que
/// GEROU o expected. O `debrid.json` capturado pode ser de outra chamada (a
/// checagem Node com a conta em quota), e o replay então marcava
/// `[AD download]` onde o Node mostrou `[AD⚡]` (Carandiru/Central/Bacurau,
/// 2026-10-20). O `name` aplicado é o veredito final: `⚡` = em cache, prefixo
/// `[` sem `⚡` = fora do cache com link do debrid, sem prefixo = P2P (unusable).
pub(super) fn applied_debrid_verdicts(files: &[ApplyDebridFile]) -> BTreeMap<String, DebridResult> {
    let mut out = BTreeMap::new();
    for file in files {
        for item in &file.output {
            let Some(hash) = applied_hash(item) else {
                continue;
            };
            if out.contains_key(&hash) {
                continue;
            }
            let name = item.get("name").and_then(Value::as_str).unwrap_or("");
            let verdict = if name.contains('\u{26A1}') {
                DebridResult {
                    cached: true,
                    known: true,
                    unusable: None,
                }
            } else if name.starts_with('[') {
                DebridResult {
                    cached: false,
                    known: true,
                    unusable: None,
                }
            } else {
                // Sem prefixo = P2P porque ESTE hash não foi resolvido (conta
                // em quota ou release fora do cache sem `resolveUncached`),
                // não porque o lote inteiro falhou: os `[AD⚡]`/`[AD download]`
                // do mesmo lote continuam valendo. `Unusable` no lote
                // desmaterializava a resposta toda; `Missing` materializava o
                // P2P que o Node deixou cru. `Unknown` preserva os dois.
                DebridResult {
                    cached: false,
                    known: false,
                    unusable: Some(Value::String("p2p".into())),
                }
            };
            out.insert(hash, verdict);
        }
    }
    out
}

/// Qualidade que o Node efetivamente usou no build (`_quality` do
/// `applyDebrid`). No replay do Node ela vem PRONTA no `apply-debrid.json`; o
/// `index.json` só tem o rótulo do post. A primeira entrada vence: é a passada
/// da resposta, que é o que o comparador de streams mede.
/// Hashes da lista PRÉ-debrid que o Node passou ao `applyDebrid` (primeira
/// chamada = passada da resposta). `None` em captura antiga/sem chave: o replay
/// mantém o comportamento anterior.
pub(super) fn pre_debrid_hashes(files: &[ApplyDebridFile]) -> Option<BTreeSet<String>> {
    let key = files.first()?.key.trim();
    let list = key.split('|').nth(2)?;
    let hashes: BTreeSet<String> = list
        .split(',')
        .map(str::trim)
        .filter(|hash| !hash.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    (!hashes.is_empty()).then_some(hashes)
}

pub(super) fn retain_item_hashes(items: &mut Vec<Value>, allowed: &BTreeSet<String>) {
    items.retain(|item| batch_item_hash(item).is_some_and(|hash| allowed.contains(&hash)));
}

/// title/size finais por hash da PRIMEIRA chamada do `applyDebrid` (a passada
/// da resposta). O replay pode ficar na média quando a lista `fsz` só chegou
/// depois do build; o título do apply já é o do Node.
/// O `instant.json` é do TAIL se tem hash que a PRIMEIRA passada do
/// `applyDebrid` não viu (o arquivo é sobrescrito a cada build).
pub(super) fn applied_fields(files: &[ApplyDebridFile]) -> BTreeMap<String, AppliedFields> {
    let mut out = BTreeMap::new();
    let Some(file) = files.first() else {
        return out;
    };
    for item in &file.output {
        let Some(hash) = applied_hash(item) else {
            continue;
        };
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string);
        let size = item.get("size").and_then(Value::as_str).map(str::to_string);
        if title.is_none() && size.is_none() {
            continue;
        }
        out.insert(hash, AppliedFields { title, size });
    }
    out
}

pub(super) fn applied_qualities(files: &[ApplyDebridFile]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for file in files {
        for item in &file.output {
            let Some(quality) = item
                .get("_quality")
                .and_then(Value::as_str)
                .filter(|quality| !quality.is_empty())
            else {
                continue;
            };
            if let Some(hash) = applied_hash(item) {
                out.entry(hash).or_insert_with(|| quality.to_string());
            }
        }
    }
    out
}

/// Repõe o `provenQuality` nos itens do índice. É o campo que o
/// `toStremioStream` lê ANTES do título (`item.provenQuality || qualityFromTitle`)
/// e que o `map_stream` do Rust já consome (`RawItem::proven_quality`); aqui só
/// se recupera a entrada que a captura não tem em nenhum outro arquivo. Item que
/// já traz o campo na captura vence: é a prova do próprio lote.
///
/// `applied` (hash → `_quality` do `apply-debrid.json`) CONFIRMA a prova: se o
/// `_quality` final do Node para o hash diverge do valor gravado, a prova não
/// foi a usada e nada é reposto. O mapa gravado é hash → qualidade, mas a prova
/// é POR ITEM e duas cópias do mesmo hash podem ter provas diferentes — medido
/// em Harry Potter 1 (23e-b): a cópia da CONTA ganhou `SD` da sonda de cabeçalho
/// enquanto a foto do índice (vencedora do dedupe, a que o Node exibe) tinha
/// `720p` no título; repor `SD` nela a cortava no filtro de resolução que o Node
/// não aplicou. Já em Game of Thrones S08E03 a prova (`1080p`) vence o título
/// mentiroso (`720p`) e o `_quality` confirma — o item recebe a prova.
pub(super) fn annotate_proven_quality(
    items: &mut [Value],
    recorded: &BTreeMap<String, String>,
    applied: &BTreeMap<String, String>,
) {
    for item in items {
        if item.get("provenQuality").is_some() {
            continue;
        }
        let Some(hash) = batch_item_hash(item) else {
            continue;
        };
        let Some(quality) = recorded.get(&hash) else {
            continue;
        };
        if applied
            .get(&hash)
            .is_some_and(|final_quality| final_quality != quality)
        {
            continue;
        }
        if let Some(map) = item.as_object_mut() {
            map.insert("provenQuality".into(), Value::String(quality.clone()));
        }
    }
}

/// Caminho de captura ANTIGA (sem `proven-quality.json`): repõe o mapa
/// `_quality` sem confirmação — é o próprio `_quality` a fonte.
pub(super) fn annotate_proven_quality_applied(
    items: &mut [Value],
    qualities: &BTreeMap<String, String>,
) {
    for item in items {
        if item.get("provenQuality").is_some() {
            continue;
        }
        let Some(hash) = batch_item_hash(item) else {
            continue;
        };
        let Some(quality) = qualities.get(&hash) else {
            continue;
        };
        if let Some(map) = item.as_object_mut() {
            map.insert("provenQuality".into(), Value::String(quality.clone()));
        }
    }
}

/// Hash de um item do lote (infoHash/magnet ou o `/resolve/<hash>` do envelope).
pub(super) fn batch_item_hash(item: &Value) -> Option<String> {
    applied_hash(item)
}

/// Repõe `provenAudio`/`provenName` nos itens — o que o `applyFileEvidence` do
/// Node faz nas rotas internas ANTES de o Rust ver o lote.
pub(super) fn annotate_audio_proof_items(
    items: &mut [Value],
    proofs: &BTreeMap<String, AudioProof>,
) {
    for item in items {
        if item.get("provenAudio").is_some() {
            continue;
        }
        let Some(hash) = batch_item_hash(item) else {
            continue;
        };
        let Some(proof) = proofs.get(&hash) else {
            continue;
        };
        let Some(map) = item.as_object_mut() else {
            continue;
        };
        map.insert("provenAudio".into(), Value::String(proof.audio.clone()));
        map.insert("provenName".into(), Value::String(proof.name.clone()));
    }
}
