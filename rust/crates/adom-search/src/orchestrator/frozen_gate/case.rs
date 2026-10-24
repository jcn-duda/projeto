//! `FrozenCase::load`: le a captura inteira e aplica as anotacoes do build.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

use crate::internal_types::MetaResponse;

use super::annotate::{
    annotate_audio_proof_items, annotate_proven_quality, annotate_proven_quality_applied,
    applied_debrid_verdicts, applied_fields, applied_qualities, pre_debrid_hashes,
    retain_item_hashes,
};
use super::annotate_sources::{
    annotate_media_source_items, applied_media_sources, normalize_files, normalize_qualities,
};
use super::audio::applied_audio_proofs;
use super::capture::{
    AppliedFields, ApplyDebridFile, CollectFile, DebridCall, DebridFile, FallbackFile, FileEntry,
    FrozenBatch, IndexFile, RequestFile,
};
use super::helpers::{read_json, read_optional};

pub(super) struct FrozenCase {
    pub(super) request: RequestFile,
    pub(super) meta: MetaResponse,
    pub(super) collect: Vec<CollectFile>,
    pub(super) debrid: DebridCall,
    /// Conjunto `instant` exato do sort (quando o record o capturou).
    pub(super) instant: Vec<String>,
    /// Lista de arquivos por hash (memo `fsz`): `💾` de pack e fill pós-debrid.
    pub(super) files: BTreeMap<String, Vec<adom_core::DebridFile>>,
    /// Total do torrent por hash (`inputs/totals.json`, memo `tsz` do Node):
    /// o `💾` de quem veio sem tamanho e sem lista de arquivos.
    pub(super) totals: BTreeMap<String, f64>,
    /// Estado do memo na passada PRÉ-debrid (`None` = captura antiga).
    pub(super) build_files: Option<BTreeMap<String, Vec<adom_core::DebridFile>>>,
    pub(super) build_totals: Option<BTreeMap<String, f64>>,
    /// Itens da reserva 📦 que o Node injetou (`None` = caso sem o arquivo).
    pub(super) fallback: Option<Vec<Value>>,
    /// Lote do índice/instantânea da captura (`inputs/index.json`), já anotado.
    pub(super) index: Option<FrozenBatch>,
    /// title/size finais por hash (do `apply-debrid.json`).
    pub(super) applied_fields: BTreeMap<String, AppliedFields>,
    pub(super) options: Value,
    pub(super) operator: Value,
}

impl FrozenCase {
    pub(super) fn load(dir: &Path) -> Result<Self, String> {
        let request: RequestFile = read_json(&dir.join("request.json"))?;
        let meta_file: Value = read_json(&dir.join("inputs/meta.json"))?;
        let id = if request.stream_id.is_empty() {
            meta_file
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        } else {
            request.stream_id.clone()
        };
        // O id do Stremio de série é `tt…:S:E`; o `MetaResponse` do Node leva o
        // IMDb BASE + temporada/episódio separados. Usar o id completo fazia a
        // dica `w` do `/resolve` sair com `tt…:1:1` e divergia em toda série.
        let mut id_parts = id.split(':');
        let imdb_id = id_parts.next().unwrap_or(&id).to_string();
        let season = id_parts.next().and_then(|value| value.parse::<i64>().ok());
        let episode = id_parts.next().and_then(|value| value.parse::<i64>().ok());
        let meta = MetaResponse {
            ok: true,
            media_type: request.r#type.clone(),
            id: imdb_id.clone(),
            imdb_id: imdb_id.clone(),
            season,
            episode,
            meta: meta_file.get("meta").cloned(),
            titles: meta_file.get("titles").cloned(),
            multi_work: meta_file
                .get("collection")
                .cloned()
                .filter(|value| !value.is_null()),
            home_release_at: meta_file.get("homeReleaseAt").and_then(Value::as_i64),
        };
        let mut collect: Vec<CollectFile> = read_optional(&dir.join("inputs/collect.json"))?;
        // A qualidade PROVADA pelo ARQUIVO (sonda do play + evidência do
        // `releaseIndex`) é decisão do BUILD, não do post: o índice e o lote
        // crus são gravados ANTES dela e só trazem o rótulo do post. O record
        // grava `inputs/proven-quality.json` (hash → qualidade); o
        // `apply-debrid.json` traz o `_quality` POR ITEM, que vence (ver
        // `annotate_proven_quality`). Sem repor o campo, o corte final do Rust
        // classifica o item no balde "sem resolução" e a cota de qualidade deixa
        // passar o que o Node cortou (Cidade de Deus: apachetorrent, 15 seeders
        // → 720p).
        let proven = normalize_qualities(read_optional::<BTreeMap<String, String>>(
            &dir.join("inputs/proven-quality.json"),
        )?);
        // O memo `fsz` do Node (arquivo + tamanho por hash): é a lista que o
        // `annotateEpisodeSizes`/`fillMissingSizes` lê para o 💾 de pack e para
        // o item que o tracker publicou sem tamanho. O record já a grava; o
        // replay do Rust não tinha como consumi-la (nenhuma rota a carrega).
        let raw_files: BTreeMap<String, Vec<FileEntry>> =
            normalize_files(read_optional(&dir.join("inputs/files.json"))?);
        let files: BTreeMap<String, Vec<adom_core::DebridFile>> = raw_files
            .iter()
            .map(|(hash, list)| {
                (
                    hash.clone(),
                    list.iter()
                        .map(|file| adom_core::DebridFile {
                            path: file.path.clone(),
                            size: file.size,
                        })
                        .collect(),
                )
            })
            .collect();
        // Estado do memo na passada PRÉ-debrid (1ª anotação do Node). O record
        // grava o arquivo MESMO VAZIO (marcador): existência = captura nova;
        // ausência = captura antiga, e a 1ª passada segue a régua anterior.
        let build_files_path = dir.join("inputs/files-build.json");
        let build_files: Option<BTreeMap<String, Vec<adom_core::DebridFile>>> = build_files_path
            .is_file()
            .then(|| read_optional::<BTreeMap<String, Vec<FileEntry>>>(&build_files_path))
            .transpose()?
            .map(|raw| {
                normalize_files(raw)
                    .into_iter()
                    .map(|(hash, list)| {
                        (
                            hash,
                            list.into_iter()
                                .map(|file| adom_core::DebridFile {
                                    path: file.path,
                                    size: file.size,
                                })
                                .collect(),
                        )
                    })
                    .collect()
            });
        let build_totals_path = dir.join("inputs/totals-build.json");
        let build_totals: Option<BTreeMap<String, f64>> = build_totals_path
            .is_file()
            .then(|| read_optional::<BTreeMap<String, f64>>(&build_totals_path))
            .transpose()?
            .map(|raw| {
                raw.into_iter()
                    .filter_map(|(hash, total)| {
                        let hash = hash.trim().to_ascii_lowercase();
                        (!hash.is_empty() && total > 0.0).then_some((hash, total))
                    })
                    .collect()
            });
        let applied: Vec<ApplyDebridFile> = read_optional(&dir.join("inputs/apply-debrid.json"))?;
        let applied_fields = applied_fields(&applied);
        // Lote congelado do índice/instantânea (`inputs/index.json`). Desde o R4
        // não existe rota Node de índice: este lote — já com as marcas de origem
        // e o recorte final do build do Node — é o que a via rápida recebe. As
        // anotações de prova abaixo repõem o que a captura não grava (o lote é
        // fotografado ANTES de `applyFileEvidence`/qualidade provada).
        let index_file: Option<IndexFile> = read_optional(&dir.join("inputs/index.json"))?;
        let mut index_batch: Option<FrozenBatch> = index_file.map(|file| {
            let value = file.value;
            let raw = value.raw.unwrap_or_default();
            FrozenBatch {
                items: raw.items,
                instant: value.instant,
                index_covered: value.served_from_index,
            }
        });
        // O `apply-debrid.json` também guarda a LISTA PRÉ-DEBRID do Node (a
        // chave da chamada): é o lote que sobreviveu aos filtros/sort do Node.
        // Replay usa essa lista como recorte quando existe — a captura não tem
        // `releaseIndex.fileEvidence` e re-derivar os filtros mantinha itens
        // que o Node já havia descartado (medido nos 512: 94 buscas, extras
        // TorrentDos/Apache BR e ausentes TPB/Lime/AllDebrid).
        let pre_debrid = pre_debrid_hashes(&applied);
        if let Some(allowed) = &pre_debrid {
            for entry in &mut collect {
                retain_item_hashes(&mut entry.response.items, allowed);
            }
            if let Some(batch) = &mut index_batch {
                retain_item_hashes(&mut batch.items, allowed);
            }
        }
        let applied_q = applied_qualities(&applied);
        if proven.is_empty() {
            // Captura antiga (sem o arquivo): o `_quality` do `applyDebrid` é o
            // `provenQuality` que o Node passou ao build. Só o ÍNDICE — o lote
            // da coleta nunca carrega prova de arquivo e repor `_quality` ali
            // muda o desempate do dedupe.
            if let Some(batch) = &mut index_batch {
                annotate_proven_quality_applied(&mut batch.items, &applied_q);
            }
        } else {
            // O arquivo novo é o contrato: vale para o índice E para o lote cru
            // (a prova também corrige item que veio da coleta).
            if let Some(batch) = &mut index_batch {
                annotate_proven_quality(&mut batch.items, &proven, &applied_q);
            }
            for entry in &mut collect {
                annotate_proven_quality(&mut entry.response.items, &proven, &applied_q);
            }
        }
        // A prova de ÁUDIO/NOME (`provenAudio`/`provenName` do `applyFileEvidence`)
        // NÃO é gravada no caso: `index.json`/`collect.json` são fotografados
        // ANTES dela e o record só repõe `provenQuality`. O que o caso TEM é o
        // veredito já aplicado no `apply-debrid.json` (`_dubbed` + o chip no
        // `name`) — o mesmo tipo de reconstrução que `applied_qualities` já faz
        // com `_quality`. O rótulo (DUB×DUAL×NAC) sai do chip; sem chip e com
        // `_dubbed` o rótulo vem da lista de arquivos (raro: `Dual` sem prova PT
        // renderiza sem chip).
        let proofs = applied_audio_proofs(&applied, &raw_files);
        if let Some(batch) = &mut index_batch {
            annotate_audio_proof_items(&mut batch.items, &proofs);
        }
        for entry in &mut collect {
            annotate_audio_proof_items(&mut entry.response.items, &proofs);
        }
        // A FONTE do rótulo (`mediaSource`, o "WEB-DL" do `720p WEB-DL BR`)
        // pode ser resolvida DURANTE o build (índice/banco) e o item cru da
        // captura não a carrega: o replay exibia `720p BR` onde o Node exibe
        // `720p WEB-DL BR` (Carandiru `53421ce875`, 2026-10-20). O
        // `apply-debrid.json` já grava o VENCEDOR do dedupe com o `bingeGroup`
        // `powerm-<qualidade>-<fonte>`; a fonte sai de lá — mesma classe de
        // reconstrução do `_quality` em [`applied_qualities`], sem campo novo no
        // record (capturas antigas já a têm).
        let media_sources = applied_media_sources(&applied);
        if !media_sources.is_empty() {
            if let Some(batch) = &mut index_batch {
                annotate_media_source_items(&mut batch.items, &media_sources);
            }
            for entry in &mut collect {
                annotate_media_source_items(&mut entry.response.items, &media_sources);
            }
        }
        let debrid: DebridFile = read_optional(&dir.join("inputs/debrid.json"))?;
        // Reserva 📦 já decidida pelo Node (`collectFallbackForBuild`). O caso
        // grava o resultado; sem este canal a reserva não entra na build e o
        // item vivo que ela venceria troca de posição.
        let fallback_file = dir.join("inputs/fallback.json");
        // A reserva 📦 é decisão do Node (`collectFallbackForBuild`) e pode ser
        // injetada FORA do lote pré-debrid (o caso e2e do Dragon Ball tem um
        // Apache só no fallback): NÃO passa pelo recorte da chave.
        let fallback = fallback_file
            .is_file()
            .then(|| read_optional::<FallbackFile>(&fallback_file))
            .transpose()?
            .and_then(|file| file.value)
            .map(|value| value.items);
        // Índice/instantânea da captura: lote VERBATIM da via rápida (R4).
        let index_batch = index_batch;
        // Conjunto `instant` real do sort; ausente em capturas antigas → cai no
        // recorte de `fromAccount` (aproximação).
        let instant: Vec<String> = read_optional(&dir.join("inputs/instant.json"))?;
        // Total do torrent (`tsz`) que o build do Node usou. Sem ele o replay
        // deixa sem `💾` o item que o tracker publicou sem tamanho e sem lista.
        let totals: BTreeMap<String, f64> =
            read_optional::<BTreeMap<String, f64>>(&dir.join("inputs/totals.json"))?
                .into_iter()
                .filter_map(|(hash, total)| {
                    let hash = hash.trim().to_ascii_lowercase();
                    (!hash.is_empty() && total > 0.0).then_some((hash, total))
                })
                .collect();
        let config: Value = read_json(&dir.join("inputs/config.json"))?;
        Ok(FrozenCase {
            request,
            meta,
            collect,
            debrid: {
                // O record novo grava o check CONSOLIDADO em `results`; o antigo
                // gravava `calls`. `calls[0]` era o lote errado quando havia
                // mais de uma chamada (prepare + check).
                let mut call = debrid.calls.into_iter().next().unwrap_or_default();
                // O `apply-debrid.json` é a checagem que GEROU o expected (o
                // veredito final por stream). Só sobrepõe quando o lote tem
                // algum `⚡` — é a evidência de que o Node viu cache fresco; sem
                // isso (capturas antigas, tudo download) a régua anterior
                // (`debrid.json`/`calls`) continua valendo, senão o
                // `cacheMaxAge` vira 900 e o gate do corpus quebra.
                let applied_verdicts = applied_debrid_verdicts(&applied);
                call.applied_p2p = applied_verdicts
                    .iter()
                    .filter(|(_, result)| {
                        !result.cached
                            && !result.known
                            && result
                                .unusable
                                .as_ref()
                                .and_then(Value::as_str)
                                .is_some_and(|reason| reason == "p2p")
                    })
                    .map(|(hash, _)| hash.clone())
                    .collect();
                if applied_verdicts.values().any(|result| result.cached) {
                    call.results = applied_verdicts;
                    call.known = true;
                    call.unusable = None;
                } else if !debrid.results.is_empty() {
                    call.results = debrid.results;
                }
                call
            },
            instant,
            files,
            totals,
            build_files,
            build_totals,
            fallback,
            index: index_batch,
            applied_fields,
            options: config.get("options").cloned().unwrap_or(Value::Null),
            operator: config.get("operator").cloned().unwrap_or(Value::Null),
        })
    }
}
