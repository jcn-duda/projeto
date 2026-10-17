//! Fronteira napi da decisão de saída de um stream (`adom_core::play_disposition`).
//!
//! A entrada é um LOTE de fatos (`hasInfoHash`, `multiWorkAdmitted`, `cached`)
//! com as opções da busca (`resolveUncached`, `degraded`); a saída é um vetor de
//! `resolve`/`p2p`/`drop`. O lote evita uma travessia por stream no caminho de
//! `applyDebrid`.
//!
//! O ORÁCULO do golden é o TypeScript do worktree `../adom-esm`
//! (`npm run golden:play-disposition:check`): o TS testava as marcas por
//! VERDADE do JS (string vazia e `0` são falsos), então a casca converte para
//! booleano antes de cruzar — a mesma conversão do `if` original.
//!
//! A ORDEM dos ramos é a regra, não estilo: `cached` → multiobra → `degraded` →
//! `resolveUncached`, esta última no núcleo. Multiobra admitida ganha do
//! degradado (coleção fria não é oferecida como torrent inteiro).

use adom_core as core;
use napi_derive::napi;
use serde::Deserialize;

// ---------------------------------------------------------------------------
// Entradas (JSON)
// ---------------------------------------------------------------------------

/// Fatos de UM stream no lote.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StreamInput {
    /// `Boolean(stream.infoHash)` — a casca já converteu a verdade do JS.
    has_info_hash: bool,
    /// `Boolean(stream._multiWorkAdmitted)`.
    multi_work_admitted: bool,
    /// `Boolean(stream.infoHash && cached.has(hash))`.
    cached: bool,
}

/// Argumentos de `playDispositions`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct BatchInput {
    streams: Vec<StreamInput>,
    resolve_uncached: bool,
    degraded: bool,
}

/// `playDispositions`: JSON `["resolve"|"p2p"|"drop", …]` na ordem da entrada.
#[napi(catch_unwind)]
pub fn play_dispositions(input: String) -> napi::Result<String> {
    let req: BatchInput = serde_json::from_str(&input)
        .map_err(|e| napi::Error::from_reason(format!("entrada JSON inválida: {e}")))?;
    let out: Vec<&str> = req
        .streams
        .iter()
        .map(|stream| {
            core::play_disposition(&core::PlayFacts {
                has_info_hash: stream.has_info_hash,
                multi_work_admitted: stream.multi_work_admitted,
                cached: stream.cached,
                resolve_uncached: req.resolve_uncached,
                degraded: req.degraded,
            })
            .as_str()
        })
        .collect();
    serde_json::to_string(&out)
        .map_err(|e| napi::Error::from_reason(format!("saída JSON inválida: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lote_preserva_ordem_e_decide_cada_stream() {
        let out = play_dispositions(
            serde_json::json!({
                "streams": [
                    { "hasInfoHash": true, "multiWorkAdmitted": false, "cached": true },
                    { "hasInfoHash": true, "multiWorkAdmitted": true, "cached": false },
                    { "hasInfoHash": true, "multiWorkAdmitted": false, "cached": false },
                    { "hasInfoHash": false, "multiWorkAdmitted": false, "cached": false },
                ],
                "resolveUncached": false,
                "degraded": false,
            })
            .to_string(),
        )
        .expect("entrada válida");
        assert_eq!(out, r#"["resolve","drop","p2p","p2p"]"#);
    }

    #[test]
    fn multiobra_ganha_do_degradado_e_do_knob() {
        let stream = |multi: bool, cached: bool| {
            serde_json::json!({
                "hasInfoHash": true,
                "multiWorkAdmitted": multi,
                "cached": cached,
            })
        };
        let batch = |resolve_uncached: bool| {
            serde_json::json!({
                "streams": [stream(true, false), stream(true, true), stream(false, false)],
                "resolveUncached": resolve_uncached,
                "degraded": true,
            })
        };
        // Multiobra fria ganha do degradado: `drop`, nunca P2P inteiro.
        assert_eq!(
            play_dispositions(batch(false).to_string()).expect("ok"),
            r#"["drop","resolve","resolve"]"#
        );
        // Com o knob explícito a mesma coleção sai pelo `/resolve`.
        assert_eq!(
            play_dispositions(batch(true).to_string()).expect("ok"),
            r#"["resolve","resolve","resolve"]"#
        );
    }

    #[test]
    fn entrada_invalida_devolve_erro_sem_panico() {
        assert!(play_dispositions("{".into()).is_err());
        assert!(play_dispositions("\"nao-e-lote\"".into()).is_err());
        assert!(play_dispositions(serde_json::json!({"streams": "x"}).to_string()).is_err());
    }
}
