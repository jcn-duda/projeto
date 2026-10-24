use adom_core::{play_disposition, PlayDisposition, PlayFacts, RankingStream};

/// Fatos do stream para o núcleo. `degraded` é do LOTE (`known:false`), não do
/// item: o Node manda a lista inteira pelo `/resolve` quando a checagem não
/// fechou, e o multiobra admitido continua sendo exceção (drop sem o knob).
/// `resolve_uncached` já chega depurado por disponibilidade/`Unusable` — o
/// núcleo continua sendo a única régua de P2P × `/resolve` × drop. Em
/// `Unusable` o ⚡ também é descartado: o Node devolve a lista inteira como
/// P2P (a conta não responde, nem para o que o memo/`davail` confirmou).
pub(super) fn disposition_of(
    stream: &RankingStream,
    degraded: bool,
    resolve_uncached: bool,
    unusable: bool,
) -> PlayDisposition {
    play_disposition(&PlayFacts {
        has_info_hash: stream
            .info_hash
            .as_deref()
            .is_some_and(|hash| !hash.is_empty()),
        multi_work_admitted: stream.multi_work_admitted.unwrap_or(false),
        cached: !unusable
            && stream
                .extra
                .get("cached")
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
        // P2P por hash (quota) NÃO vira `/resolve` nem com `resolveUncached`:
        // `DebridAnswer::P2p` é "sem link do debrid", o knob só vale para frio
        // conhecido. Sem esta guarda o replay marcava `[AD download]` onde o
        // expected era P2P (Auto da Compadecida/HP1).
        resolve_uncached: resolve_uncached && !unusable,
        degraded,
    })
}
