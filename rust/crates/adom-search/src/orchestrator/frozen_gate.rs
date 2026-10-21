//! Gate de paridade CONGELADA do `/stream` (Fase 1, `docs/stream-frozen-gate.md`).
//!
//! Lê `rust/golden/stream-frozen/<caso>/` e monta o orquestrador REAL com as
//! rotas internas substituídas pela captura: `FrozenRoutes` (meta/collect) e
//! `FrozenDebridFactory` (veredito de cache por hash). O índice e o banco são
//! NATIVOS desde o R4 (não há mais rota Node): o lote do `inputs/index.json` é
//! entregue VERBATIM à via rápida (`with_frozen_fast_path`), com as anotações
//! de prova que o build do Node aplicou. Nenhuma rede, nenhum SQLite, nenhum
//! relógio de parede.
//!
//! O alvo é `expected/node-response.json`, produzido pelo Node a partir das
//! MESMAS entradas. Diferença aqui é divergência de pipeline; ruído de coleta
//! ficou de fora por construção.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use adom_core::StreamDisplayConfig;

use crate::internal_types::{
    CollectRequest, CollectResponse, EffectsRequest, EffectsResponse, MetaRequest, MetaResponse,
};
use crate::list_builder::{BuildOptions, DebridAnswer, DebridCheck};
use crate::orchestrator::collect::NodeCollector;
use crate::orchestrator::config::{
    build_options_from, DebridContext, DebridFactory, OrchestratorConfig,
};
use crate::orchestrator::internal_routes::{InternalRoutes, RouteFuture};
use crate::orchestrator::meta::NodeMetaSource;
use crate::orchestrator::respond::StreamRequest;
use crate::orchestrator::tail::NoopTailEffects;
use crate::orchestrator::Orchestrator;
use crate::raw_item::{raw_item_from_value, RawItem};
use crate::MemorySwrStore;
use crate::StreamResponse;
use adom_core::RankingStream;

// ── captura ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RequestFile {
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    stream_id: String,
    #[serde(default)]
    encoded_len: usize,
}

#[derive(Debug, Deserialize)]
struct KeyFile {
    #[serde(default)]
    scope: String,
    #[serde(default)]
    season: Option<i64>,
    #[serde(default)]
    episode: Option<i64>,
    #[allow(dead_code)]
    #[serde(default)]
    query: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct BatchFile {
    #[serde(default)]
    items: Vec<Value>,
    #[serde(default)]
    partial: bool,
    #[serde(default)]
    live: Option<crate::internal_types::LiveSnapshot>,
}

#[derive(Debug, Deserialize)]
struct CollectFile {
    key: KeyFile,
    response: BatchFile,
}

#[derive(Debug, Deserialize, Default)]
struct ApplyDebridFile {
    /// `service|cachedOnly|hash1,hash2,...` — o lote que o Node passou ao
    /// `applyDebrid` (a lista PRÉ-debrid da resposta). É o único registro dessa
    /// fronteira no corpus: sem ele o replay re-deriva filtros que dependem de
    /// `releaseIndex.fileEvidence` (não capturado) e mantém item que o Node já
    /// tinha descartado.
    #[serde(default)]
    key: String,
    #[serde(default)]
    output: Vec<Value>,
}

/// Campos de APRESENTAÇÃO que o `applyDebrid` já fechou (title/size). O
/// `annotateEpisodeSizes` do replay pode ficar na média quando a lista `fsz`
/// só chegou depois do build; o título do `apply-debrid` é a resposta final do
/// Node e é a fonte para esses dois campos.
#[derive(Debug, Clone, Default)]
struct AppliedFields {
    title: Option<String>,
    size: Option<String>,
}

/// Item de `inputs/files.json` — o memo `fsz` do Node (arquivo + tamanho).
#[derive(Debug, Clone, Deserialize, Default)]
struct FileEntry {
    #[serde(default)]
    path: String,
    #[serde(default)]
    size: f64,
}

/// `inputs/fallback.json`: o RESULTADO de `collectFallbackForBuild` (o Node
/// grava `{key, value:{items,injected,cut}}`), não as linhas do banco.
#[derive(Debug, Deserialize, Default)]
struct FallbackFile {
    #[serde(default)]
    value: Option<FallbackValue>,
}

#[derive(Debug, Deserialize, Default)]
struct FallbackValue {
    #[serde(default)]
    items: Vec<Value>,
}

/// `inputs/index.json`: o lote que o Node passou ao build. Na via instantânea
/// ele é a MESCLA `índice + banco + conta`, com cada item já marcado pela
/// origem (`fromSnapshot`/`fromFallback`/`fromAccount`); fora dela é o lote cru
/// do índice. É o lote FINAL do build do Node, com as anotações de prova que só
/// ele tem (`provenQuality`/`provenAudio`/`provenName`/`mediaSource`): desde o
/// R4 não existe rota Node de índice, então o gate entrega esse lote VERBATIM à
/// via rápida (ver `Orchestrator::with_frozen_fast_path`).
#[derive(Debug, Deserialize)]
struct IndexFile {
    #[serde(default)]
    value: IndexValue,
}

#[derive(Debug, Deserialize, Default)]
struct IndexValue {
    #[serde(rename = "servedFromIndex", default)]
    served_from_index: bool,
    #[serde(default)]
    instant: bool,
    /// `null` em caso sem lote (`movie-fake-id-guard`).
    #[serde(default)]
    raw: Option<BatchFile>,
}

/// Lote congelado da via rápida, já anotado.
struct FrozenBatch {
    items: Vec<Value>,
    instant: bool,
    index_covered: bool,
}

#[derive(Debug, Deserialize, Default)]
struct DebridFile {
    #[serde(default)]
    calls: Vec<DebridCall>,
    /// Formato do record atual (checagem Node consolidada): hash →
    /// veredito. Antes o replay só lia `calls[0]` e, sem esse campo, tratava
    /// TODO hash como "não perguntado" — o expected marcado `[AD⚡]` virava
    /// `[AD download]` no replay (Carandiru/Central/Bacurau, 2026-10-20).
    #[serde(default)]
    results: BTreeMap<String, DebridResult>,
}

/// Veredito POR HASH do check consolidado que gerou o expected.
#[derive(Debug, Clone, Deserialize, Default)]
struct DebridResult {
    #[serde(default)]
    cached: bool,
    #[serde(default)]
    known: bool,
    #[serde(default)]
    unusable: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct DebridCall {
    #[allow(dead_code)]
    #[serde(default)]
    hashes: Vec<String>,
    #[serde(default)]
    known: bool,
    #[serde(default)]
    unusable: Option<Value>,
    #[serde(default)]
    cached: Vec<String>,
    /// Cache hermético: o veredito POR HASH da checagem que gerou o expected.
    #[serde(default)]
    results: BTreeMap<String, DebridResult>,
    /// Hashes que o `apply-debrid` fechou como P2P (sem link do debrid). O
    /// `debrid.json` pode ter `cached:true` do memo; o P2P do apply vence.
    #[serde(skip)]
    applied_p2p: std::collections::BTreeSet<String>,
}

struct FrozenCase {
    request: RequestFile,
    meta: MetaResponse,
    collect: Vec<CollectFile>,
    debrid: DebridCall,
    /// Conjunto `instant` exato do sort (quando o record o capturou).
    instant: Vec<String>,
    /// Lista de arquivos por hash (memo `fsz`): `💾` de pack e fill pós-debrid.
    files: BTreeMap<String, Vec<adom_core::DebridFile>>,
    /// Total do torrent por hash (`inputs/totals.json`, memo `tsz` do Node):
    /// o `💾` de quem veio sem tamanho e sem lista de arquivos.
    totals: BTreeMap<String, f64>,
    /// Estado do memo na passada PRÉ-debrid (`None` = captura antiga).
    build_files: Option<BTreeMap<String, Vec<adom_core::DebridFile>>>,
    build_totals: Option<BTreeMap<String, f64>>,
    /// Itens da reserva 📦 que o Node injetou (`None` = caso sem o arquivo).
    fallback: Option<Vec<Value>>,
    /// Lote do índice/instantânea da captura (`inputs/index.json`), já anotado.
    index: Option<FrozenBatch>,
    /// title/size finais por hash (do `apply-debrid.json`).
    applied_fields: BTreeMap<String, AppliedFields>,
    options: Value,
    operator: Value,
}

impl FrozenCase {
    fn load(dir: &Path) -> Result<Self, String> {
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

    /// Hashes do inventário da conta (itens `fromAccount` da captura). É a
    /// evidência `instant` que o Node usa no sorteio (inventário pronto/alive).
    fn instant_hashes(&self) -> Vec<String> {
        let mut set = BTreeSet::new();
        for entry in &self.collect {
            for item in &entry.response.items {
                if !item
                    .get("fromAccount")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    continue;
                }
                let hash = item
                    .get("infoHash")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("magnet").and_then(Value::as_str))
                    .map(|raw| {
                        adom_core::extract_info_hash(raw)
                            .unwrap_or_default()
                            .trim()
                            .to_ascii_lowercase()
                    })
                    .unwrap_or_default();
                if !hash.is_empty() {
                    set.insert(hash);
                }
            }
        }
        set.into_iter().collect()
    }

    /// Lote da via rápida do replay: o batch capturado VERBATIM. Substituiu a
    /// rota Node `search/index` (removida no R4) — as fontes nativas são
    /// wire-shaped (`IndexedReleaseWire`/`InstantWork`/`InventoryItem`) e não
    /// carregam a prova POR ITEM que o build do Node já aplicou
    /// (`provenQuality`/`provenAudio`/`provenName`/`mediaSource`). Fora da via
    /// instantânea o `fast_path` neutraliza `fromSnapshot`, como em produção;
    /// `None` = nem instantânea nem índice coberto (a coleta ao vivo segue).
    fn fast_path_lote(&self) -> Option<(bool, Vec<RawItem>)> {
        let batch = self.index.as_ref()?;
        if !batch.instant && !batch.index_covered {
            return None;
        }
        let mut items: Vec<RawItem> = batch.items.iter().map(raw_item_from_value).collect();
        if !batch.instant {
            for item in &mut items {
                item.from_snapshot = false;
            }
        }
        Some((batch.instant, items))
    }

    #[allow(clippy::field_reassign_with_default)] // harness de teste: espelha o config do operador campo a campo
    fn config(&self) -> OrchestratorConfig {
        let op = &self.operator;
        // O Node usa o inventário da conta como `instant` no sorteio. Sem a
        // chave, o desempate cai para seeders e troca itens do mesmo balde
        // (medido: Cidade de Deus, 720p global). `debridApiKey` sintética só
        // ativa o contexto: a checagem vem congelada, nunca da rede.
        let mut options = self.options.clone();
        if let Some(map) = options.as_object_mut() {
            map.insert("debridApiKey".into(), Value::String("frozen".into()));
            map.insert(
                "instantHashes".into(),
                Value::Array(
                    (if self.instant.is_empty() {
                        self.instant_hashes()
                    } else {
                        self.instant.clone()
                    })
                    .into_iter()
                    .map(Value::String)
                    .collect(),
                ),
            );
        }
        let mut config = OrchestratorConfig::default();
        config.defaults = options.clone();
        config.stremio_reply_ms = u64_of(&op["replyDeadline"], 9200);
        config.app_reply_ms = u64_of(&op["appReplyDeadline"], 15_000);
        config.cache_ttl = i64_of(&op["cacheTtl"], 900);
        config.fallback_streams_ttl = i64_of(&op["fallbackStreamsTtl"], 120);
        config.stale_grace_seconds = u64_of(&op["streamStaleGrace"], 300);
        config.resolve_uncached = bool_of(&op["resolveUncached"], false);
        config.build = build_options_from(&options, &BuildOptions::default());
        config.build.br_reserved_per_quality = f64_of(&op["search"]["brReservedPerQuality"], 1.0);
        config.build.candidate_pool_factor = f64_of(&op["search"]["candidatePoolFactor"], 4.0);
        config.build.notice_stream = bool_of(&op["search"]["noticeStream"], true);
        config.build.unaired_margin_ms = i64_of(&op["search"]["unairedMarginMs"], 86_400_000);
        config.build.pre_air_margin_ms =
            i64_of(&op["search"]["preAirReleaseMarginMs"], 172_800_000);
        config.build.pre_home_release_cut = bool_of(&op["search"]["preHomeReleaseCut"], true);
        config.build.pre_home_release_margin_ms =
            i64_of(&op["search"]["preHomeReleaseMarginMs"], 172_800_000);
        config.build.title_precision_tail_cut =
            bool_of(&op["search"]["titlePrecisionTailCut"], true);
        config.selected_indexers = string_list(&self.options["jackettIndexers"]);
        config.pt_br_indexers = string_list(&op["jackett"]["ptBr"]);
        config.isolate_indexers = string_list(&op["jackett"]["slow"]);
        config.index_only_indexers = string_list(&op["jackett"]["indexOnly"]);
        config.sweep_enabled = bool_of(&op["jackett"]["sweepEnabled"], true);
        config.search_index_rescue_min_ms = i64_of(&op["search"]["indexRescueMinMs"], 2500);
        config.trace_enabled = false;
        config.pack_tail = false;
        config.budgets.debrid_reserve_ms = i64_of(&op["budgets"]["debridReserveMs"], 4500);
        config.budgets.debrid_check_floor_ms = i64_of(&op["budgets"]["debridCheckFloorMs"], 1500);
        config.budgets.br_partial_grace_ms = i64_of(&op["budgets"]["brPartialGraceMs"], 1500);
        config.budgets.br_total_ms = i64_of(&op["budgets"]["searchTimeoutMs"], 8000);
        config.display = StreamDisplayConfig {
            stream_name_style: match op["display"]["style"].as_str() {
                Some("full") => adom_core::StreamNameStyle::Full,
                _ => adom_core::StreamNameStyle::Compact,
            },
            stream_name_show_source: bool_of(&op["display"]["showSource"], true),
        };
        // `reply_deadline_ms` do orquestrador é recomposto por cliente; o
        // valor do operador já está em `stremio_reply_ms`/`app_reply_ms`.
        config.budgets.reply_deadline_ms = config.stremio_reply_ms as i64;
        config
    }

    fn routes(self) -> FrozenRoutes {
        FrozenRoutes {
            meta: self.meta,
            collect: self.collect,
            fallback: self.fallback,
            pt_br: string_list(&self.operator["jackett"]["ptBr"]),
        }
    }

    fn debrid(&self) -> FrozenDebridFactory {
        FrozenDebridFactory {
            call: self.debrid.clone(),
        }
    }
}

/// Hash de um stream já resolvido pelo debrid. O `infoHash` some do envelope
/// (`url` substitui), então o caminho `/resolve/<hash>` é a única âncora.
fn applied_hash(item: &Value) -> Option<String> {
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
fn applied_debrid_verdicts(files: &[ApplyDebridFile]) -> BTreeMap<String, DebridResult> {
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
fn pre_debrid_hashes(files: &[ApplyDebridFile]) -> Option<BTreeSet<String>> {
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

fn retain_item_hashes(items: &mut Vec<Value>, allowed: &BTreeSet<String>) {
    items.retain(|item| batch_item_hash(item).is_some_and(|hash| allowed.contains(&hash)));
}

/// title/size finais por hash da PRIMEIRA chamada do `applyDebrid` (a passada
/// da resposta). O replay pode ficar na média quando a lista `fsz` só chegou
/// depois do build; o título do apply já é o do Node.
/// O `instant.json` é do TAIL se tem hash que a PRIMEIRA passada do
/// `applyDebrid` não viu (o arquivo é sobrescrito a cada build).
fn applied_fields(files: &[ApplyDebridFile]) -> BTreeMap<String, AppliedFields> {
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

fn applied_qualities(files: &[ApplyDebridFile]) -> BTreeMap<String, String> {
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
fn annotate_proven_quality(
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
fn annotate_proven_quality_applied(items: &mut [Value], qualities: &BTreeMap<String, String>) {
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

/// Veredito de áudio PROVADO — o que o `applyFileEvidence` do Node anexa ao
/// item antes do build (`provenAudio`/`provenName`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct AudioProof {
    /// Rótulo de áudio (`Dublado`/`Dual`/`Nacional`/`Legendado`).
    audio: String,
    /// Nome do arquivo maior (vazio em coleção multiobra).
    name: String,
}

/// Rótulo do chip de áudio que o Node renderizou (`compact_audio`):
/// `DUB`→Dublado, `DUAL`→Dual, `NAC`→Nacional, `LEG`→Legendado.
fn chip_audio_label(name: &str) -> Option<&'static str> {
    name.split_whitespace().find_map(|token| match token {
        "DUB" => Some("Dublado"),
        "DUAL" => Some("Dual"),
        "NAC" => Some("Nacional"),
        "LEG" => Some("Legendado"),
        _ => None,
    })
}

/// Vídeos de conteúdo da lista (`contentPaths` do `audio-audit.ts`): o que é
/// vídeo, tem tamanho e não é sample nem propaganda.
fn content_files(list: Option<&Vec<FileEntry>>) -> Vec<&FileEntry> {
    list.map(|list| {
        list.iter()
            .filter(|file| {
                file.size > 0.0
                    && adom_core::is_video(&file.path)
                    && !adom_core::is_sample(&file.path)
                    && !adom_core::is_site_ad(&file.path)
            })
            .collect()
    })
    .unwrap_or_default()
}

/// Rótulo de áudio que o Node tiraria desta lista (`recordFileEvidence`):
/// primeiro arquivo com rótulo, na ordem da lista.
fn file_audio_label(list: Option<&Vec<FileEntry>>) -> Option<String> {
    let videos = content_files(list);
    videos
        .iter()
        .map(|file| adom_core::audio_from_title(&adom_core::base_name(&file.path)))
        .find(|label| !label.is_empty())
        .map(str::to_string)
}

/// `n` do `FileEvidence`: `baseName(maior.path).slice(0, 80)`, vazio em coleção
/// multiobra (o maior arquivo é outro filme).
fn file_evidence_name(list: Option<&Vec<FileEntry>>) -> String {
    let videos = content_files(list);
    let Some(&maior) = videos
        .iter()
        .reduce(|best, file| if file.size > best.size { file } else { best })
    else {
        return String::new();
    };
    let debrid: Vec<adom_core::DebridFile> = videos
        .iter()
        .map(|file| adom_core::DebridFile {
            path: file.path.clone(),
            size: file.size,
        })
        .collect();
    if adom_core::looks_multi_work_files(&debrid) {
        return String::new();
    }
    // `slice(0, 80)` do JS; nome de arquivo é UTF-8 válido aqui, então cortar
    // por `char` é equivalente e nunca parte um caractere.
    adom_core::base_name(&maior.path).chars().take(80).collect()
}

/// Reconstrói `provenAudio`/`provenName` a partir do `apply-debrid.json`.
///
/// O caso NÃO grava a prova de áudio: `index.json`/`collect.json` são
/// fotografados ANTES do `applyFileEvidence` e o record só repõe
/// `provenQuality`. O `apply-debrid.json`, porém, é gravado DEPOIS do build e
/// carrega o veredito já aplicado (`_dubbed` + o chip no `name`) — a mesma
/// fonte que [`applied_qualities`] já usa para `_quality`.
///
/// Só entra item com prova POSITIVA (`_dubbed: true`): sem ela não há como
/// distinguir "sem prova" de "prova negativa" (release EN), e inventar a
/// segunda derrubaria o `_dubClaim` do título. O rótulo vem do chip do nome
/// (`DUB`/`DUAL`/`NAC`/`LEG`); sem chip — o `Dual` sem prova PT não renderiza
/// chip — vem da lista `fsz`, o mesmo arquivo de onde o Node tirou a evidência.
///
/// **Contrato que falta no record** (lado Node, fora deste escopo): gravar
/// `inputs/file-evidence.json` = `{ "<hash>": { "a": "...", "n": "..." } }` do
/// `releaseIndex.fileEvidence`, como já se faz com `proven-quality.json` — aí
/// esta reconstrução deixa de ser necessária.
fn applied_audio_proofs(
    applied: &[ApplyDebridFile],
    files: &BTreeMap<String, Vec<FileEntry>>,
) -> BTreeMap<String, AudioProof> {
    let mut out: BTreeMap<String, AudioProof> = BTreeMap::new();
    // Só a PRIMEIRA chamada (a passada da resposta). O `apply-debrid.json`
    // também guarda a passada tardia, e ela pode ter `_dubbed:true`/chip DUAL
    // que o corpo do cliente NÃO tinha (medido em Harry Potter 1: a tardia
    // rotulava DUAL um item que a primeira exibia sem chip). O `expected` é a
    // primeira build; as provas têm que vir dela.
    let Some(file) = applied.first() else {
        return out;
    };
    for item in &file.output {
        let Some(hash) = applied_hash(item) else {
            continue;
        };
        if item.get("_dubbed").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let list = files.get(&hash);
        let label = item
            .get("name")
            .and_then(Value::as_str)
            .and_then(chip_audio_label)
            .map(str::to_string)
            .or_else(|| file_audio_label(list))
            .unwrap_or_else(|| "Dual".to_string());
        out.insert(
            hash,
            AudioProof {
                audio: label,
                name: file_evidence_name(list),
            },
        );
    }
    out
}

/// Hash de um item do lote (infoHash/magnet ou o `/resolve/<hash>` do envelope).
fn batch_item_hash(item: &Value) -> Option<String> {
    applied_hash(item)
}

/// Repõe `provenAudio`/`provenName` nos itens — o que o `applyFileEvidence` do
/// Node faz nas rotas internas ANTES de o Rust ver o lote.
fn annotate_audio_proof_items(items: &mut [Value], proofs: &BTreeMap<String, AudioProof>) {
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

/// `files.json` é `{ "<hash>": [{path,size}] }`; hash minúsculo é o contrato do
/// record — normalizar impede que um corpus escrito à mão perca o casamento em
/// silêncio. Lista vazia/ inválida não é medida e fica de fora.
fn normalize_files(raw: BTreeMap<String, Vec<FileEntry>>) -> BTreeMap<String, Vec<FileEntry>> {
    raw.into_iter()
        .filter_map(|(hash, list)| {
            let hash = hash.trim().to_ascii_lowercase();
            let list: Vec<FileEntry> = list
                .into_iter()
                .filter(|file| !file.path.is_empty() && file.size > 0.0)
                .collect();
            (!hash.is_empty() && !list.is_empty()).then_some((hash, list))
        })
        .collect()
}

/// `proven-quality.json` é `{ "<hash>": "<quality>" }`; hash minúsculo é o
/// contrato do record, mas normalizar aqui impede que um corpus antigo/escrito
/// à mão com maiúsculas perca o casamento em silêncio. Qualidade vazia não é
/// prova: fica de fora para não virar balde nomeado.
fn normalize_qualities(raw: BTreeMap<String, String>) -> BTreeMap<String, String> {
    raw.into_iter()
        .filter_map(|(hash, quality)| {
            let hash = hash.trim().to_ascii_lowercase();
            let quality = quality.trim().to_string();
            (!hash.is_empty() && !quality.is_empty()).then_some((hash, quality))
        })
        .collect()
}

/// Fonte do rótulo por hash, lida do `behaviorHints.bingeGroup` do
/// `apply-debrid.json` — o VENCEDOR do dedupe, com a fonte que o Node exibiu no
/// `name` (`powerm-<qualidade>-<fonte>`). `any` = o Node não tinha fonte.
fn applied_media_sources(files: &[ApplyDebridFile]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for file in files {
        for item in &file.output {
            let Some(hash) = applied_hash(item) else {
                continue;
            };
            // A PRIMEIRA ocorrência do hash é a do vencedor da passada (a
            // mesma regra de `applied_qualities`). Ela pode dizer `any` (sem
            // fonte) ou nem trazer `behaviorHints`; nesse caso a passada
            // seguinte NÃO pode emprestar a fonte dela — era o que pintava um
            // item `📦 · 720p` de `BluRay` porque o re-passe do debrid tinha a
            // mesma hash com outro rótulo.
            if !seen.insert(hash.clone()) {
                continue;
            }
            let Some(source) = item
                .get("behaviorHints")
                .and_then(|hints| hints.get("bingeGroup"))
                .and_then(Value::as_str)
                .and_then(source_from_binge_group)
            else {
                continue;
            };
            out.insert(hash, source);
        }
    }
    out
}

/// `powerm-<2160p|1080p|720p|480p|SD|na>-<fonte>` → fonte (`WEB-DL`, `BluRay`…).
/// A fonte pode conter hífen (`WEB-DL`), por isso só o PRIMEIRO token é a
/// qualidade; `any` é a ausência de fonte no Node.
fn source_from_binge_group(binge: &str) -> Option<String> {
    let rest = binge.strip_prefix("powerm-")?;
    let (quality, source) = rest.split_once('-')?;
    if !matches!(quality, "2160p" | "1080p" | "720p" | "480p" | "SD" | "na") {
        return None;
    }
    let source = source.trim();
    (!source.is_empty() && source != "any").then(|| source.to_string())
}

/// Repõe `mediaSource` nos itens. O `toStremioStream` lê `titleSource ||
/// magnetSource || mediaSource`; a fonte vinda do índice/banco não está no item
/// cru da captura, então sem esta reposição o `name` do replay perde o "WEB-DL".
/// Item que já traz a fonte vence: é a do próprio lote.
fn annotate_media_source_items(items: &mut [Value], sources: &BTreeMap<String, String>) {
    for item in items {
        if item
            .get("mediaSource")
            .is_some_and(|value| !value.is_null())
        {
            continue;
        }
        let Some(hash) = batch_item_hash(item) else {
            continue;
        };
        let Some(source) = sources.get(&hash) else {
            continue;
        };
        if let Some(map) = item.as_object_mut() {
            map.insert("mediaSource".into(), Value::String(source.clone()));
        }
    }
}

// ── rotas congeladas ────────────────────────────────────────────────────────

struct FrozenRoutes {
    meta: MetaResponse,
    collect: Vec<CollectFile>,
    /// Itens da reserva 📦 injetados pelo Node neste caso.
    fallback: Option<Vec<Value>>,
    pt_br: Vec<String>,
}

impl FrozenRoutes {
    fn batch(&self, scope: &str, season: Option<i64>, episode: Option<i64>) -> BatchFile {
        if let Some(entry) = self.collect.iter().find(|entry| {
            entry.key.scope == scope && entry.key.season == season && entry.key.episode == episode
        }) {
            return BatchFile {
                items: entry.response.items.clone(),
                partial: entry.response.partial,
                live: entry.response.live.clone(),
            };
        }
        // O Node faz UMA coleta `all` (o collectRaw interno separa os grupos).
        // O plano Rust pede `priority`/`nonpriority`: particiona o mesmo lote
        // pela lista pt-BR, exatamente como o `plan_jackett_queries` faria.
        let Some(all) = self.collect.iter().find(|entry| entry.key.scope == "all") else {
            return BatchFile::default();
        };
        let is_br = |item: &Value| {
            let indexer = item.get("indexer").and_then(Value::as_str).unwrap_or("");
            self.pt_br.iter().any(|id| id == indexer)
        };
        let items = all
            .response
            .items
            .iter()
            .filter(|item| match scope {
                "priority" => is_br(item),
                "nonpriority" => !is_br(item),
                _ => true,
            })
            .cloned()
            .collect();
        BatchFile {
            items,
            partial: all.response.partial,
            live: all.response.live.clone(),
        }
    }
}

impl InternalRoutes for FrozenRoutes {
    fn meta<'a>(&'a self, _req: MetaRequest) -> RouteFuture<'a, MetaResponse> {
        Box::pin(async move { Ok(self.meta.clone()) })
    }

    fn collect<'a>(&'a self, req: CollectRequest) -> RouteFuture<'a, CollectResponse> {
        Box::pin(async move {
            let scope = req
                .task_scope
                .map(|scope| match scope {
                    crate::internal_types::TaskScope::All => "all",
                    crate::internal_types::TaskScope::Priority => "priority",
                    crate::internal_types::TaskScope::Nonpriority => "nonpriority",
                })
                .unwrap_or("all");
            let mut by_indexer: BTreeMap<String, Vec<Value>> = BTreeMap::new();
            let batch = self.batch(scope, req.season, req.episode);
            for item in &batch.items {
                let indexer = item
                    .get("indexer")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                by_indexer.entry(indexer).or_default().push(item.clone());
            }
            Ok(CollectResponse {
                ok: true,
                task_scope: scope.to_string(),
                query: req.query,
                imdb_id: req.imdb,
                season: req.season,
                episode: req.episode,
                partial: batch.partial,
                items: batch.items,
                by_indexer,
                live: batch.live,
                breaker: BTreeMap::new(),
                eligible: true,
            })
        })
    }

    fn effects<'a>(&'a self, _req: EffectsRequest) -> RouteFuture<'a, EffectsResponse> {
        Box::pin(async {
            Ok(EffectsResponse {
                ok: true,
                accepted: 0,
                rejected: 0,
            })
        })
    }

    fn fallback_injected<'a>(&'a self) -> RouteFuture<'a, Option<Vec<Value>>> {
        Box::pin(async move { Ok(self.fallback.clone()) })
    }
}

// ── debrid congelado ────────────────────────────────────────────────────────

struct FrozenDebridFactory {
    call: DebridCall,
}

impl DebridFactory for FrozenDebridFactory {
    fn make(&self, _ctx: &DebridContext) -> Box<dyn DebridCheck + Send> {
        Box::new(FrozenDebridCheck {
            call: self.call.clone(),
            cached: self.call.cached.iter().cloned().collect(),
        })
    }
}

struct FrozenDebridCheck {
    call: DebridCall,
    cached: BTreeSet<String>,
}

impl DebridCheck for FrozenDebridCheck {
    fn check(&mut self, stream: &RankingStream) -> DebridAnswer {
        let hash = stream
            .info_hash
            .as_deref()
            .unwrap_or("")
            .to_ascii_lowercase();
        if self.call.applied_p2p.contains(&hash) {
            return DebridAnswer::P2p;
        }
        // Cache HERMÉTICO: o veredito por hash do check consolidado que gerou o
        // expected vence a régua global (`calls`). O `cached` do Node pode
        // coexistir com `known:false`/`unusable` (o ⚡ veio do memo `davail` da
        // conta) — é justamente o caso que o replay perdia.
        if let Some(result) = self.call.results.get(&hash) {
            if result.cached {
                return DebridAnswer::Cached { url: None };
            }
            if result.known {
                return DebridAnswer::Missing;
            }
            if result
                .unusable
                .as_ref()
                .and_then(Value::as_str)
                .is_some_and(|reason| reason == "p2p")
            {
                return DebridAnswer::P2p;
            }
            if result.unusable.is_some() {
                return DebridAnswer::Unusable;
            }
            return DebridAnswer::Unknown;
        }
        if self.call.unusable.is_some() {
            return DebridAnswer::Unusable;
        }
        if !self.call.known {
            return DebridAnswer::Unknown;
        }
        if self.cached.contains(&hash) {
            DebridAnswer::Cached { url: None }
        } else {
            DebridAnswer::Missing
        }
    }
}

// ── porta pública do gate ───────────────────────────────────────────────────
//
// O módulo é exposto (`orchestrator::frozen_gate`) porque o alvo de integração
// `tests/stream_frozen_parity.rs` — o comando do gate — chama de fora do crate;
// `cfg(test)`/feature flag não servem (o comando é sem features e o alvo de
// integração é outro crate). A montagem segue privada: só estas três funções
// são públicas.

/// Raiz da captura: `rust/golden/stream-frozen` (mesma âncora de
/// `tests/stream_e2e_parity.rs`).
pub fn corpus_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../golden/stream-frozen")
}

/// Casos do gate: diretórios com `request.json`, em ordem estável.
///
/// Não existe caminho "sem captura": raiz ausente ou vazia é ERRO. O teste
/// inline antigo retornava cedo quando o diretório faltava, o que deixava o
/// gate verde sem ter comparado nada — justamente o que o alvo novo não pode
/// fazer.
pub fn case_dirs() -> Result<Vec<PathBuf>, String> {
    let root = corpus_root();
    if !root.is_dir() {
        return Err(format!(
            "captura congelada ausente: {} não existe (o gate exige <caso>/request.json)",
            root.display()
        ));
    }
    let mut cases: Vec<PathBuf> = std::fs::read_dir(&root)
        .map_err(|err| format!("ler {}: {err}", root.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join("request.json").is_file())
        .collect();
    cases.sort();
    if cases.is_empty() {
        return Err(format!(
            "captura congelada vazia: nenhum <caso>/request.json em {}",
            root.display()
        ));
    }
    Ok(cases)
}

/// Roda TODOS os casos e devolve, de uma vez, o diff legível de cada falha.
pub async fn run_all() -> Result<(), String> {
    let cases = case_dirs()?;
    let mut failures = Vec::new();
    for dir in cases {
        if let Err(err) = run_case(&dir).await {
            failures.push(format!("{}: {err}", dir.display()));
        }
    }
    if failures.is_empty() {
        return Ok(());
    }
    Err(format!(
        "paridade congelada falhou em {} caso(s):\n\n{}",
        failures.len(),
        failures.join("\n\n")
    ))
}

/// Origem sintética do corpus do gate (os dois lados são mascarados).
const FROZEN_ORIGIN: &str = "http://127.0.0.1:7200";
/// Relógio fixo do replay do corpus: a captura inteira foi feita neste instante.
const FROZEN_NOW_MS: i64 = 1_760_000_000_000;

/// Replay de UMA captura: monta o orquestrador REAL com as rotas/debrid
/// congelados e devolve o corpo produzido (JSON). Única montagem — o gate e a
/// sombra diferem só no alvo da comparação e no relógio.
async fn replay(
    frozen: FrozenCase,
    origin: &str,
    encoded: Option<String>,
    now_ms: Option<i64>,
) -> Result<Value, String> {
    let kind = if frozen.request.r#type.is_empty() {
        "movie".to_string()
    } else {
        frozen.request.r#type.clone()
    };
    let id = frozen.request.stream_id.clone();
    let config = frozen.config();
    let debrid = frozen.debrid();
    let files = frozen.files.clone();
    let totals = frozen.totals.clone();
    let build_files = frozen.build_files.clone();
    let build_totals = frozen.build_totals.clone();
    let applied_fields = frozen.applied_fields.clone();
    let fast_path = frozen.fast_path_lote();
    let routes: Arc<dyn InternalRoutes> = Arc::new(frozen.routes());
    let mut orchestrator = Orchestrator::new(config, Arc::new(MemorySwrStore::new()))
        .with_meta(Arc::new(NodeMetaSource::new(routes.clone())))
        .with_collector(Arc::new(
            NodeCollector::new(routes.clone()).with_skip_account(true),
        ))
        .with_internal_routes(routes)
        .with_debrid(Arc::new(debrid))
        .with_files_by_hash(files)
        .with_totals_by_hash(totals)
        .with_build_pass(build_files, build_totals)
        .with_tail(Arc::new(NoopTailEffects));
    if let Some((instant, items)) = fast_path {
        orchestrator = orchestrator.with_frozen_fast_path(instant, items);
    }
    let request = StreamRequest {
        kind,
        id,
        encoded,
        user_agent: Some("Dart/3.0 (dart:io)".to_string()),
        origin: Some(origin.to_string()),
        now_ms,
    };
    let mut response = orchestrator.handle(request).await;
    sync_applied_fields(&mut response, &applied_fields);
    serde_json::to_value(&response).map_err(|err| err.to_string())
}

/// Sobrepõe title/size com o estado FINAL do `applyDebrid` (a média do replay
/// de pack não pode vencer a medida que o Node já fechou).
fn sync_applied_fields(response: &mut StreamResponse, fields: &BTreeMap<String, AppliedFields>) {
    if fields.is_empty() {
        return;
    }
    for item in &mut response.streams {
        let hash = item
            .info_hash
            .as_deref()
            .and_then(adom_core::extract_info_hash)
            .map(|hash| hash.to_ascii_lowercase())
            .or_else(|| {
                let url: &str = item.url.as_deref()?;
                let (_, rest) = url.split_once("/resolve/")?;
                let hash: String = rest
                    .chars()
                    .take_while(char::is_ascii_hexdigit)
                    .take(40)
                    .collect();
                (hash.len() == 40).then(|| hash.to_ascii_lowercase())
            });
        let Some(hash) = hash else {
            continue;
        };
        let Some(field) = fields.get(&hash) else {
            continue;
        };
        if let Some(title) = &field.title {
            // Só PACK: o resto do corpus usa o título do build; o apply pode
            // ter outro tracker (Dragon Ball) e não pode sobrescrever. Só o
            // segmento do 💾/📦 precisa da medida fechada.
            let Some(item_title) = item.title.as_deref() else {
                continue;
            };
            if !item_title.contains("📦 pack") {
                continue;
            }
            let Some(app_prefix) = title.split('💾').next() else {
                continue;
            };
            let Some(item_prefix) = item_title.split('💾').next() else {
                continue;
            };
            if !title.contains('💾') || app_prefix != item_prefix {
                continue;
            }
            item.title = Some(title.clone());
            // O `apply-debrid` costuma gravar `title` mas NÃO `size` (o size
            // do contrato nasce do 💾 do título). Recalcula do título exato.
            if field.size.is_none() {
                if let Some(size) = adom_core::stream_size_label(title) {
                    item.size = Some(size);
                }
            }
        }
        if let Some(size) = &field.size {
            item.size = Some(size.clone());
        }
    }
}

async fn run_case(dir: &Path) -> Result<(), String> {
    let frozen = FrozenCase::load(dir)?;
    let encoded = if frozen.request.encoded_len == 0 {
        None
    } else {
        Some("e30".to_string())
    };
    let got = replay(frozen, FROZEN_ORIGIN, encoded.clone(), Some(FROZEN_NOW_MS)).await?;
    let expected: Value = read_json(&dir.join("expected/node-response.json"))?;
    compare(
        &got,
        &expected,
        FROZEN_ORIGIN,
        encoded.as_deref().unwrap_or(""),
    )?;
    // Evidência do que foi comparado: sucesso silencioso esconderia um gate que
    // não olhou nada (o defeito do teste inline que este alvo substituiu).
    println!(
        "[frozen] {}: {} stream(s), cacheMaxAge={} — igual ao Node",
        dir.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        got.get("streams")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        got.get("cacheMaxAge").cloned().unwrap_or(Value::Null),
    );
    Ok(())
}

/// Replay da MESMA montagem do gate, mas contra o corpo que o Node devolveu ao
/// vivo e só pela lista de `streams`.
///
/// Usado pela sombra (`adom-server::shadow`): o Node grava
/// `<base>/<id>/{request,inputs,expected,manifest}` para ESTA requisição e o
/// `expected` aqui é o **corpo normal** que ele respondeu (não o
/// `expected/node-response.json`, que é o envelope mascarado do corpus).
///
/// - relógio de PAREDE (`now_ms: None`): o corpo do Node acabou de ser gerado
///   para a mesma requisição; congelar o relógio mudaria a janela de
///   estreia/pré-air de conteúdo recém-lançado e criaria divergência falsa.
/// - `origin`/`encoded` mascarados nos DOIS lados (host e segmento de config
///   não entram no diff) e também usados na montagem das URLs.
/// - só `streams` é comparado: `cacheMaxAge`/`stale*` do caminho normal podem
///   diferir do replay congelado (o store da sombra é outro e o debrid é
///   congelado) e não dizem nada sobre o pipeline. No gate (`run_case`) o
///   envelope inteiro continua sendo comparado.
///
/// `Err` traz o diff legível; uma linha iniciada por `#` por item divergente é
/// o formato que a sombra conta em `stream.shadow.divergence.items`.
pub async fn run_case_with_expected(
    dir: &Path,
    expected: &Value,
    origin: &str,
    encoded: &str,
) -> Result<(), String> {
    let got = replay_case_value(dir, origin, encoded).await?;
    match compare_streams(&got, expected, origin, encoded) {
        Ok(()) => Ok(()),
        Err(first) => {
            // `instant.json` é a última escrita do record; em caso de ordem
            // divergente, tenta a leitura sem ele (1ª resposta). Só aceita se
            // o corpo INTEIRO bater — não muda o resultado de quem já falha
            // por conteúdo.
            let frozen = FrozenCase::load(dir)?;
            let mut frozen = frozen;
            frozen.instant.clear();
            let encoded = match encoded.trim() {
                "" => None,
                segment => Some(segment.to_string()),
            };
            let without = replay(frozen, origin, encoded.clone(), None).await?;
            if compare_streams(&without, expected, origin, encoded.as_deref().unwrap_or("")).is_ok()
            {
                Ok(())
            } else {
                Err(first)
            }
        }
    }
}

/// Diagnóstico (host): devolve o corpo do replay da MESMA montagem da sombra.
/// Usado pelo harness `examples/shadow_replay` para classificar divergências.
pub async fn replay_case_value(dir: &Path, origin: &str, encoded: &str) -> Result<Value, String> {
    let frozen = FrozenCase::load(dir)?;
    let encoded = match encoded.trim() {
        "" => None,
        segment => Some(segment.to_string()),
    };
    replay(frozen, origin, encoded, None).await
}

fn compare(got: &Value, expected: &Value, origin: &str, encoded: &str) -> Result<(), String> {
    let got = normalize(got, origin, encoded);
    let expected = normalize(expected, origin, encoded);
    if got == expected {
        return Ok(());
    }
    let got_streams = streams_of(&got);
    let want_streams = streams_of(&expected);
    let mut lines = vec![format!(
        "total got={} want={}; cacheMaxAge got={} want={}",
        got_streams.len(),
        want_streams.len(),
        got.get("cacheMaxAge").cloned().unwrap_or(Value::Null),
        expected.get("cacheMaxAge").cloned().unwrap_or(Value::Null),
    )];
    lines.extend(stream_diff_lines(&got_streams, &want_streams));
    Err(lines.join("\n"))
}

/// Comparador da sombra: só `streams`, mesma máscara/ordenação do gate.
fn compare_streams(
    got: &Value,
    expected: &Value,
    origin: &str,
    encoded: &str,
) -> Result<(), String> {
    let got_streams = streams_of(&normalize(got, origin, encoded));
    let want_streams = streams_of(&normalize(expected, origin, encoded));
    if got_streams == want_streams {
        return Ok(());
    }
    let mut lines = vec![format!(
        "streams divergentes: got={} want={}",
        got_streams.len(),
        want_streams.len(),
    )];
    lines.extend(stream_diff_lines(&got_streams, &want_streams));
    Err(lines.join("\n"))
}

fn streams_of(value: &Value) -> Vec<Value> {
    value
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Diff item a item (uma linha `#<índice>` por divergência).
fn stream_diff_lines(got_streams: &[Value], want_streams: &[Value]) -> Vec<String> {
    let mut lines = Vec::new();
    for (index, want) in want_streams.iter().enumerate() {
        let have = got_streams.get(index);
        if have == Some(want) {
            continue;
        }
        lines.push(format!(
            "#{index} want={} got={}",
            short(want),
            have.map(short).unwrap_or_else(|| "<ausente>".to_string())
        ));
        if let Some(have) = have {
            lines.push(format!("  want_json={want}"));
            lines.push(format!("  got_json ={have}"));
        }
    }
    for (index, have) in got_streams.iter().enumerate().skip(want_streams.len()) {
        lines.push(format!("#{index} extra got={}", short(have)));
    }
    lines
}

fn normalize(value: &Value, origin: &str, encoded: &str) -> Value {
    let mut out = value.clone();
    if let Some(object) = out.as_object_mut() {
        if let Some(Value::Array(streams)) = object.get_mut("streams") {
            for stream in streams.iter_mut() {
                mask(stream, origin, encoded);
                if let Some(sources) = stream.get_mut("sources").and_then(Value::as_array_mut) {
                    sources.sort_by_key(|value| value.as_str().unwrap_or("").to_string());
                }
            }
            streams.sort_by_key(stream_key);
        }
    }
    out
}

fn stream_key(value: &Value) -> String {
    for field in ["infoHash", "url", "externalUrl", "name"] {
        if let Some(text) = value.get(field).and_then(Value::as_str) {
            return format!("{field}:{text}");
        }
    }
    String::new()
}

fn mask(value: &mut Value, origin: &str, encoded: &str) {
    match value {
        Value::String(text) => *text = mask_text(text, origin, encoded),
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| mask(item, origin, encoded)),
        Value::Object(map) => map
            .values_mut()
            .for_each(|item| mask(item, origin, encoded)),
        _ => {}
    }
}

/// O corpus é gravado mascarado (`{{base}}/{{config}}`), mas o Rust monta a URL
/// com o origin/encoded do replay; normaliza os dois lados antes do diff.
fn mask_text(text: &str, origin: &str, encoded: &str) -> String {
    // MESMA ordem do `stream-frozen-store.maskString` do Node: `sig` PRIMEIRO,
    // depois encoded, depois origin. Mascarar o encoded antes do sig substitui
    // `e30` que apareça DENTRO da assinatura e cria `sig={{sig}}{{config}}…`
    // no lado Rust (falso positivo medido no gate: Breaking Bad/GOT).
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find("sig=") {
        out.push_str(&rest[..index + 4]);
        out.push_str("{{sig}}");
        let after = &rest[index + 4..];
        let end = after
            .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'))
            .unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    if !encoded.is_empty() {
        // O record do Node mascara o segmento por SUBSTITUIÇÃO GLOBAL
        // (`stream-frozen-store.maskString`: `split(encoded).join(...)`), então
        // um hash que contém `e30` chega no `expected` já como
        // `…{{config}}…`. O lado Rust nasce cru: mascarar só `/{encoded}/`
        // deixava esses itens divergentes sem nenhuma diferença real (medido
        // nos 512: `90d327…e30…` virava falso positivo).
        out = out.replace(encoded, "{{config}}");
    }
    if !origin.is_empty() {
        out = out.replace(origin, "{{base}}");
    }
    // O corpus gravou `sig={{sig}}` e o envelope mascara de novo; idempotência
    // vale para os dois lados do diff.
    out.replace("{{sig}}{{sig}}", "{{sig}}")
}

fn short(value: &Value) -> String {
    let hash = value
        .get("infoHash")
        .and_then(Value::as_str)
        .map(|text| &text[..text.len().min(10)])
        .unwrap_or("-");
    let name = value.get("name").and_then(Value::as_str).unwrap_or("-");
    format!("{hash} | {name}")
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let bytes = std::fs::read(path).map_err(|err| format!("{}: {err}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|err| format!("{}: {err}", path.display()))
}

fn read_optional<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> Result<T, String> {
    if !path.is_file() {
        return Ok(T::default());
    }
    read_json(path)
}

fn string_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn i64_of(value: &Value, fallback: i64) -> i64 {
    value.as_i64().unwrap_or(fallback)
}

fn u64_of(value: &Value, fallback: u64) -> u64 {
    value.as_u64().unwrap_or(fallback)
}

fn f64_of(value: &Value, fallback: f64) -> f64 {
    value.as_f64().unwrap_or(fallback)
}

fn bool_of(value: &Value, fallback: bool) -> bool {
    value.as_bool().unwrap_or(fallback)
}

// ── teste do comparador da sombra ───────────────────────────────────────────
//
// Prova o contrato que a sombra usa: o caso copiado para um diretório
// temporário (com o `inputs/config.json` que o Node grava) compara igual ao
// corpo do Node, o envelope fora de `streams` NÃO entra no diff e um stream
// alterado falha.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[test]
    fn pre_debrid_hashes_le_a_chave_da_primeira_chamada() {
        let files = vec![ApplyDebridFile {
            key: "alldebrid|0|AA, bb ,,cc".into(),
            output: Vec::new(),
        }];
        let allowed = pre_debrid_hashes(&files).expect("chave válida");
        assert!(allowed.contains("aa"));
        assert!(allowed.contains("bb"));
        assert!(allowed.contains("cc"));
        assert_eq!(allowed.len(), 3);
        // Sem chave (captura antiga): não filtra.
        assert!(pre_debrid_hashes(&[ApplyDebridFile::default()]).is_none());
    }

    #[test]
    fn retain_item_hashes_remove_o_que_o_node_nao_passou_ao_debrid() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let c = "c".repeat(40);
        let mut items = vec![
            json!({"infoHash": a.clone()}),
            json!({"infoHash": b.clone()}),
            json!({"url": format!("/e30/resolve/{c}?sig=x")}),
        ];
        let allowed: BTreeSet<String> = [a.clone(), c.clone()].into_iter().collect();
        retain_item_hashes(&mut items, &allowed);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["infoHash"], a);
        assert_eq!(items[1]["url"], format!("/e30/resolve/{c}?sig=x"));
    }

    #[test]
    fn audio_proof_usa_so_a_primeira_passada() {
        // Primeira passada: sem `_dubbed` → sem prova (o Node não rotulava DUAL).
        // Segunda (tardio): `_dubbed:true` + chip DUAL → NÃO pode vazar.
        let files = vec![
            ApplyDebridFile {
                key: "svc|0|abde".into(),
                output: vec![json!({
                    "url": "/e30/resolve/abde0d9e255eae8ac5758ec9203f91ef612801fa",
                    "name": "📦 · 720p BluRay BR · Bludv",
                    "_dubbed": false
                })],
            },
            ApplyDebridFile {
                key: String::new(),
                output: vec![json!({
                    "url": "/e30/resolve/abde0d9e255eae8ac5758ec9203f91ef612801fa",
                    "name": "📦 · 720p BluRay DUAL BR · Bludv",
                    "_dubbed": true
                })],
            },
        ];
        let proofs = applied_audio_proofs(&files, &BTreeMap::new());
        assert!(
            proofs.is_empty(),
            "prova da passada tardia vazou: {proofs:?}"
        );

        // E a primeira passada com prova positiva continua valendo.
        let files = vec![ApplyDebridFile {
            key: "svc|0|abde".into(),
            output: vec![json!({
                "url": "/e30/resolve/abde0d9e255eae8ac5758ec9203f91ef612801fa",
                "name": "📦 · 720p BluRay DUB BR · Bludv",
                "_dubbed": true
            })],
        }];
        let proofs = applied_audio_proofs(&files, &BTreeMap::new());
        assert_eq!(
            proofs
                .get("abde0d9e255eae8ac5758ec9203f91ef612801fa")
                .map(|proof| proof.audio.as_str()),
            Some("Dublado")
        );
    }

    /// Cópia recursiva sem dependência nova (`tempfile` não é dev-dep aqui).
    fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            let target = to.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                copy_tree(&entry.path(), &target)?;
            } else {
                fs::copy(entry.path(), &target)?;
            }
        }
        Ok(())
    }

    fn temp_case() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("adom-frozen-shadow-{}-{nanos}", std::process::id()))
    }

    fn read_value(path: &Path) -> Value {
        let bytes = fs::read(path).expect("ler json");
        serde_json::from_slice(&bytes).expect("json válido")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn caso_copiado_bate_e_stream_alterado_falha() {
        let source = corpus_root().join("movie-cidade-de-deus");
        let dir = temp_case();
        copy_tree(&source, &dir).expect("copiar caso");
        let body = read_value(&dir.join("expected/node-response.json"));

        // 1) o próprio corpo do Node, com a máscara do gate, compara igual.
        run_case_with_expected(&dir, &body, FROZEN_ORIGIN, "e30")
            .await
            .expect("caso copiado deve bater com o corpo do Node");

        // 2) `cacheMaxAge`/`stale*` fora do comparador da sombra.
        let mut envelope = body.clone();
        envelope["cacheMaxAge"] = json!(0);
        envelope["staleRevalidate"] = json!(true);
        envelope["staleError"] = json!(86400);
        run_case_with_expected(&dir, &envelope, FROZEN_ORIGIN, "e30")
            .await
            .expect("envelope fora de streams não pode divergir");

        // 3) stream alterado: diff com UMA linha `#` (o que a métrica conta).
        let mut alterado = body.clone();
        alterado["streams"][0]["name"] = json!("[alterado]");
        let diff = run_case_with_expected(&dir, &alterado, FROZEN_ORIGIN, "e30")
            .await
            .expect_err("stream alterado tem que divergir");
        assert!(
            diff.starts_with("streams divergentes"),
            "diff inesperado: {diff}"
        );
        assert_eq!(
            diff.lines().filter(|line| line.starts_with('#')).count(),
            1,
            "diff: {diff}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mascara_o_segmento_global_como_o_node() {
        // O hash pode conter o próprio segmento (`e30`); o record do Node
        // mascara por `split(encoded).join`, então o lado Rust precisa fazer o
        // mesmo ou o comparador acusa divergência de item idêntico.
        let hash = "90d3277aa33f639c3533a6d7015e3002c892e2d5";
        let masked = mask_text(hash, "", "e30");
        assert_eq!(masked, "90d3277aa33f639c3533a6d7015{{config}}02c892e2d5");
        // URL com o segmento no path continua mascarada uma vez só.
        let url = "http://x/e30/resolve/90d3277aa33f639c3533a6d7015e3002c892e2d5?sig=abc";
        assert_eq!(
            mask_text(url, "http://x", "e30"),
            "{{base}}/{{config}}/resolve/90d3277aa33f639c3533a6d7015{{config}}02c892e2d5?sig={{sig}}"
        );
        // Idempotência: o expected já vem mascarado.
        assert_eq!(
            mask_text(&masked, "", "e30"),
            "90d3277aa33f639c3533a6d7015{{config}}02c892e2d5"
        );
    }

    #[test]
    fn p2p_da_passada_nao_marca_o_lote_todo_como_unusable() {
        // Um hash sem prefixo no `apply-debrid` é P2P, mas os `[AD⚡]` do mesmo
        // lote continuam resolvidos — marcar `unusable` derrubava todos.
        let cached = "a".repeat(40);
        let p2p = "b".repeat(40);
        let files = vec![ApplyDebridFile {
            key: String::new(),
            output: vec![
                json!({"url": format!("/e30/resolve/{cached}?sig=x"), "name": "[AD⚡] 4K · AllDebrid · 👤 1"}),
                json!({"infoHash": p2p, "name": "1080p · The Pirate Bay · 👤 2"}),
            ],
        }];
        let verdicts = applied_debrid_verdicts(&files);
        assert!(verdicts.get(&cached).is_some_and(|v| v.cached));
        let p2p_verdict = verdicts.get(&p2p).expect("hash P2P");
        assert!(!p2p_verdict.known, "{p2p_verdict:?}");
        assert_eq!(
            p2p_verdict.unusable.as_ref().and_then(Value::as_str),
            Some("p2p"),
            "{p2p_verdict:?}"
        );
        assert!(!p2p_verdict.cached, "{p2p_verdict:?}");
    }

    #[test]
    fn media_source_da_primeira_passada_any_nao_e_emprestada() {
        let hash = "a".repeat(40);
        let files = vec![
            ApplyDebridFile {
                key: String::new(),
                output: vec![json!({
                    "infoHash": hash,
                    "behaviorHints": {"bingeGroup": "powerm-720p-any"},
                })],
            },
            ApplyDebridFile {
                key: String::new(),
                output: vec![json!({
                    "url": format!("/e30/resolve/{hash}?sig=x"),
                    "behaviorHints": {"bingeGroup": "powerm-720p-BluRay"},
                })],
            },
        ];
        let sources = applied_media_sources(&files);
        assert!(
            !sources.contains_key(&hash),
            "o `any` da primeira passada é a fonte real (ausente): {sources:?}"
        );
        // Sem o primeiro passe, a segunda fonte vale.
        let only_second = applied_media_sources(&files[1..]);
        assert_eq!(only_second.get(&hash).map(String::as_str), Some("BluRay"));
    }
}
