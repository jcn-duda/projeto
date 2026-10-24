//! Fim da passada (`finish_value`): entrada gravavel + fatos da resposta.
//!
//! Separado de `finish.rs` apenas pelo teto de linhas (split mecanico).

use adom_core::{commit_decision, play_disposition, CommitFacts, PlayDisposition, PlayFacts};

use crate::cache::{has_playable_stream, StreamsEntry};
use crate::contract::StreamItem;
use crate::resolve_url::ResolveSigner;

use super::config::{DebridContext, OrchestratorConfig};
use super::finish::FinishValue;
use super::meta::SearchMeta;
use super::trace::{self, new_trace};
/// Fim da passada: entrada gravável + fatos da resposta.
#[allow(clippy::too_many_arguments)]
pub(super) fn finish_value(
    built: crate::list_builder::BuiltList,
    meta: &SearchMeta,
    partial: bool,
    // A checagem rodou? Sem debrid ativo ninguém pergunta: `Unknown` não é
    // degradação, é ausência de pergunta.
    debrid_checked: bool,
    debrid: &DebridContext,
    search_key: &str,
    signer: &ResolveSigner,
    config: &OrchestratorConfig,
    trace_enabled: bool,
    now_ms: i64,
) -> FinishValue {
    // A URL de play nasce AQUI (prefixo/segredo são da requisição) e RELATIVA:
    // o host entra em `applyNoticeOrigin`, nunca no cache. O item resolvido
    // perde `infoHash`/`sources`, como no Node.
    let mut built = built;
    let signer = ResolveSigner {
        work_hint: built.work_hint.clone(),
        ..signer.clone()
    };
    let short = debrid_short(&debrid.service);
    // Sem debrid ativo ninguém perguntou — e isso NÃO é "não tem" (o TS nem
    // chama o applyDebrid: `known` fica undefined → conhecido).
    let debrid_known = if debrid.is_active() {
        built.debrid_known && !built.needs_debrid_refresh
    } else {
        true
    };
    // `known:false` do LOTE → lista inteira pelo `/resolve` (degradado), como o
    // `materialize` do Node. O multiobra admitido continua fora dessa regra
    // (o núcleo decide; sem o knob ele já saiu no finalize).
    // Só há `resolveUncached`/degradação com debrid ATIVO e veredito utilizável:
    // sem serviço/chave ninguém perguntou, e `Unusable` (auth/quota) é conta que
    // não responde — o Node devolve P2P e descarta multiobra nesses caminhos.
    let check_usable = debrid_checked && debrid.is_active() && !built.debrid_unusable;
    let degraded = check_usable && !debrid_known;
    let resolve_uncached = check_usable && config.resolve_uncached;
    let unusable = built.debrid_unusable;
    let mut materialized: Vec<_> = Vec::with_capacity(built.streams.len());
    for mut stream in built.streams.drain(..) {
        let hash = stream.info_hash.clone().filter(|h| !h.is_empty());
        let disposition = play_disposition(&PlayFacts {
            has_info_hash: hash.is_some(),
            multi_work_admitted: stream.multi_work_admitted,
            // `Unusable` descarta até o ⚡ do memo: a conta não responde, então
            // a lista inteira volta P2P, como o `filter` do Node.
            cached: stream.cached && !unusable,
            // Sombra: sem checagem não há "frio conhecido" a resolver.
            // `P2p` por hash (quota) também não: o Node exibe P2P puro.
            resolve_uncached: resolve_uncached && !stream.p2p,
            degraded,
        });
        match disposition {
            // Defensivo: o finalize já removeu. Nunca oferecer a coleção fria.
            PlayDisposition::Drop => continue,
            PlayDisposition::P2p => {}
            PlayDisposition::Resolve => {
                // Sem hash o `/resolve` não existe: `viaDebrid` devolve o
                // stream como P2P antes de montar a URL (mesmo no degradado).
                if let Some(hash) = hash {
                    // `p:1` do `viaDebrid`: `workHint && s._multiWork`, e o
                    // `_multiWork` do Node já é `isMultiWorkCollection(title) ||
                    // _multiWorkAdmitted`. A marca genérica basta — exigir
                    // admissão perderia o pack de trilogia sem opt-in TMDB.
                    let multi_work = stream.multi_work || stream.multi_work_admitted;
                    let url = signer.url(&hash, stream.dubbed, multi_work);
                    stream.item.url = Some(url);
                    stream.item.info_hash = None;
                    stream.item.sources = None;
                    // `[AD⚡]` só no tocável; frio via knob/degradado é
                    // `[AD download]` — mesmo `markDebridName` do Node.
                    if let Some(name) = stream.item.name.clone() {
                        stream.item.name =
                            Some(adom_core::mark_debrid_name(&name, short, stream.cached));
                    }
                }
            }
        }
        materialized.push(stream);
    }
    built.streams = materialized;

    // Ledger: o funil do build vira `stages`; `final` fecha o tamanho entregue.
    let mut trace = new_trace(now_ms as f64, trace_enabled);
    trace::record_build_stages(&mut trace, &built.funnel);
    trace::finish_trace(&mut trace, built.streams.len(), now_ms as f64);
    let trace_value = trace::trace_to_cache_value(trace.as_ref());

    let streams: Vec<StreamItem> = built.streams.iter().map(|s| s.item.clone()).collect();
    let notice = !built.streams.is_empty() && built.streams.iter().all(|s| s.notice);
    let needs_debrid_refresh = debrid.is_active() && built.needs_debrid_refresh;
    let mut entry = StreamsEntry {
        streams,
        partial: partial || built.fallback,
        debrid_known: Some(debrid_known),
        fallback: built.fallback,
        notice,
        trace: trace_value,
        search_meta: Some(meta.search_meta_json()),
    };
    let decision = commit_decision(&CommitFacts {
        playable: has_playable_stream(&entry.streams),
        partial: entry.partial,
        debrid_known: entry.debrid_known,
        needs_debrid_refresh,
        has_fallback: built.fallback,
        cache_ttl: config.cache_ttl,
        fallback_streams_ttl: config.fallback_streams_ttl,
    });
    entry.partial = decision.partial;
    entry.debrid_known = Some(decision.debrid_known);
    // TTL <= 0 é cache desligado: não grava (mesma leitura do ramo da reserva).
    let commit_write = decision.write && decision.ttl > 0;
    let partial_entry = entry.partial;
    // Efeitos de cauda: o payload nasce aqui porque ele lê o veredito de cache
    // por stream; QUEM emite é o tail, atrás de `EFFECTS_RUST` (default ON no
    // `from_env`; `off` é o rollback).
    //
    // Os dois early returns do `applyDebrid` que NÃO enfileiram nada:
    // sem adaptador (sem serviço/chave, `:87`) e conta `unusable`/auth-quota
    // (`:159-170`). Nos dois o Node não esquenta nem interroga nada.
    let effects = if debrid.is_active() && !built.debrid_unusable {
        let effect_ctx = super::effects::EffectContext {
            adapter_id: &debrid.service,
            api_key: &debrid.api_key,
            imdb_id: &meta.imdb_id,
            season: meta.season,
            episode: meta.episode,
            search_key,
            known: debrid_known,
            work: built.work_hint.as_ref(),
        };
        super::effects::build_effects(&built.effect_seeds, &effect_ctx)
    } else {
        Vec::new()
    };
    FinishValue {
        entry,
        entered: built.entered_raw,
        filtered: built.filtered_raw,
        partial: partial_entry,
        debrid_known,
        needs_debrid_refresh,
        commit_write,
        commit_ttl: decision.ttl,
        effects,
    }
}

/// Sigla do adaptador no rótulo da lista (`short` do registry TS).
fn debrid_short(service: &str) -> &'static str {
    match service {
        "alldebrid" => "AD",
        "premiumize" => "PM",
        "torbox" => "TB",
        "realdebrid" => "RD",
        "debridlink" => "DL",
        _ => "",
    }
}
