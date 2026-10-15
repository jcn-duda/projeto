//! Efeito do `/resolve` para o Node gravar. Esta camada não toca magnetdb,
//! cache nem ledger: o L1 mora no processo do Node.
//!
//! O corpo é o texto que o usuário vê. A mensagem do `DebridError` continua
//! a do construtor TS, que o `/debrid/link` já devolve.

use adom_core::{EpisodeContext, EpisodeEvidence};
use serde_json::{json, Value};

use crate::error::DebridError;

const NO_VIDEO_BODY: &str = "nenhum arquivo de vídeo no torrent";
const RATE_BODY: &str = "o debrid está limitando as requisições; espere um pouco e tente de novo";
const BLOCKED_BODY: &str = "o debrid bloqueou este conteúdo por motivo legal";
const DUB_BODY: &str = "o torrent anunciado como dublado contém conteúdo em inglês";
const WORK_BODY: &str = "não foi possível identificar este filme dentro do pack";
const EPISODE_BODY: &str = "este episódio não foi encontrado no pack";
const FAIL_BODY: &str = "falha ao resolver no debrid";

/// Decisão do play. `service` só liga `noteBlocked` no Real-Debrid.
pub fn resolve_effect(service: &str, err: &DebridError) -> Value {
    match err {
        DebridError::NoVideo(_) => effect(
            404,
            "no_video",
            NO_VIDEO_BODY,
            Some("bad"),
            false,
            false,
            "obra",
            None,
            None,
            None,
        ),
        DebridError::RateLimit { .. } => neutral(429, "rate_limit", RATE_BODY),
        DebridError::Blocked(_) => effect(
            451,
            "blocked",
            BLOCKED_BODY,
            None,
            service == "realdebrid",
            false,
            "streams",
            None,
            None,
            None,
        ),
        DebridError::DubLie {
            evidence, context, ..
        } => effect(
            404,
            "dub_lie",
            DUB_BODY,
            Some("lie"),
            false,
            true,
            "obra",
            Some("lied"),
            evidence_json(evidence.as_deref()),
            context_json(context.as_deref()),
        ),
        DebridError::WorkPick(_) => neutral(404, "work_pick", WORK_BODY),
        DebridError::EpisodePick {
            evidence, context, ..
        } => episode_effect(evidence.as_deref(), context.as_deref()),
        other => neutral(502, other.kind(), FAIL_BODY),
    }
}

/// JSON de erro do `/debrid/link`. O status HTTP não muda; prova só entra
/// quando o seletor a trouxe. Cliente antigo ignora a chave.
pub fn link_error_json(err: &DebridError, message: &str) -> Value {
    let (evidence, context) = err.pick_parts();
    let mut body = json!({
        "error": err.kind(),
        "kind": err.kind(),
        "message": message,
    });
    if let Some(map) = body.as_object_mut() {
        if let Some(value) = evidence_json(evidence) {
            map.insert("evidence".into(), value);
        }
        if let Some(value) = context_json(context) {
            map.insert("context".into(), value);
        }
    }
    body
}

fn episode_effect(evidence: Option<&EpisodeEvidence>, context: Option<&EpisodeContext>) -> Value {
    // Sem prova o 404 fica sozinho: invalidar a obra apagaria stream bom
    // quando o pack só não nomeou o episódio. Sem segunda tentativa de download.
    let index = evidence.map(|item| {
        if item.declared_episodes.is_empty() {
            "missing-season"
        } else {
            "missing"
        }
    });
    let invalidate = if evidence.is_some() { "obra" } else { "none" };
    effect(
        404,
        "episode_pick",
        EPISODE_BODY,
        None,
        false,
        false,
        invalidate,
        index,
        evidence_json(evidence),
        context_json(context),
    )
}

fn neutral(status: u16, kind: &str, body: &str) -> Value {
    effect(
        status, kind, body, None, false, false, "none", None, None, None,
    )
}

#[allow(clippy::too_many_arguments)] // um campo por eixo do efeito, todos no JSON
fn effect(
    status: u16,
    kind: &str,
    body: &str,
    mark: Option<&str>,
    note_blocked: bool,
    unprotect: bool,
    invalidate: &str,
    index: Option<&str>,
    evidence: Option<Value>,
    context: Option<Value>,
) -> Value {
    json!({
        "status": status,
        "kind": kind,
        "body": body,
        "mark": mark,
        "noteBlocked": note_blocked,
        "unprotect": unprotect,
        "invalidate": invalidate,
        "index": index,
        "evidence": evidence,
        "context": context,
    })
}

fn evidence_json(evidence: Option<&EpisodeEvidence>) -> Option<Value> {
    evidence.map(|item| {
        json!({
            "wantedSeason": item.wanted_season,
            "wantedEpisode": item.wanted_episode,
            "declaredSeasons": item.declared_seasons,
            "declaredEpisodes": item.declared_episodes,
            "sample": item.sample,
        })
    })
}

fn context_json(context: Option<&EpisodeContext>) -> Option<Value> {
    context.map(|item| {
        json!({
            "videoCount": item.video_count,
            "samples": item.samples,
        })
    })
}

#[cfg(test)]
mod tests {
    use adom_core::{EpisodeContext, EpisodeEvidence, PickCode};
    use serde_json::{json, Value};

    use super::*;
    use crate::error::DebridError;

    fn evidence(episodes: Vec<i64>) -> EpisodeEvidence {
        EpisodeEvidence {
            wanted_season: 2,
            wanted_episode: 5,
            declared_seasons: vec![2],
            declared_episodes: episodes,
            sample: Some("ep.mkv".into()),
        }
    }

    fn context() -> EpisodeContext {
        EpisodeContext {
            video_count: 3,
            samples: vec!["a.mkv".into(), "b.mkv".into()],
        }
    }

    fn keys(value: &Value) -> Vec<&str> {
        let mut names: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        names.sort_unstable();
        names
    }

    #[test]
    fn chaves_do_efeito_sao_so_as_do_contrato() {
        let value = resolve_effect(
            "premiumize",
            &DebridError::other("apikey=segredo magnet:?xt=urn"),
        );
        assert_eq!(
            keys(&value),
            vec![
                "body",
                "context",
                "evidence",
                "index",
                "invalidate",
                "kind",
                "mark",
                "noteBlocked",
                "status",
                "unprotect",
            ]
        );
        let text = value.to_string();
        assert!(!text.contains("apikey"));
        assert!(!text.contains("magnet:"));
        assert!(!text.contains("url"));
    }

    #[test]
    fn no_video_marca_bad_e_invalida_a_obra() {
        let value = resolve_effect("premiumize", &DebridError::NoVideo("n".into()));
        assert_eq!(value["status"], 404);
        assert_eq!(value["kind"], "no_video");
        assert_eq!(value["body"], "nenhum arquivo de vídeo no torrent");
        assert_eq!(value["mark"], "bad");
        assert_eq!(value["invalidate"], "obra");
        assert_eq!(value["noteBlocked"], false);
        assert_eq!(value["unprotect"], false);
        assert!(value["index"].is_null());
        assert!(value["evidence"].is_null());
    }

    #[test]
    fn rate_limit_e_work_pick_ficam_neutros() {
        let rate = resolve_effect(
            "realdebrid",
            &DebridError::RateLimit {
                message: "slow".into(),
                retry_after_ms: Some(1),
            },
        );
        assert_eq!(rate["status"], 429);
        assert_eq!(rate["kind"], "rate_limit");
        assert_eq!(
            rate["body"],
            "o debrid está limitando as requisições; espere um pouco e tente de novo"
        );
        assert!(rate["mark"].is_null());
        assert_eq!(rate["invalidate"], "none");
        assert_eq!(rate["noteBlocked"], false);

        let work = resolve_effect("premiumize", &DebridError::WorkPick("w".into()));
        assert_eq!(work["status"], 404);
        assert_eq!(work["kind"], "work_pick");
        assert_eq!(
            work["body"],
            "não foi possível identificar este filme dentro do pack"
        );
        assert!(work["mark"].is_null());
        assert_eq!(work["invalidate"], "none");
        assert!(work["index"].is_null());
    }

    #[test]
    fn blocked_nunca_e_bad_e_so_anota_no_realdebrid() {
        let rd = resolve_effect("realdebrid", &DebridError::Blocked("legal".into()));
        assert_eq!(rd["status"], 451);
        assert_eq!(
            rd["body"],
            "o debrid bloqueou este conteúdo por motivo legal"
        );
        assert!(rd["mark"].is_null());
        assert_eq!(rd["noteBlocked"], true);
        assert_eq!(rd["invalidate"], "streams");
        assert_eq!(rd["unprotect"], false);

        let other = resolve_effect("premiumize", &DebridError::Blocked("legal".into()));
        assert_eq!(other["noteBlocked"], false);
        assert_eq!(other["invalidate"], "streams");
        assert!(other["mark"].is_null());
    }

    #[test]
    fn dub_lie_protege_menos_e_carrega_a_prova() {
        let err =
            DebridError::from_pick(PickCode::DubLie, Some(evidence(vec![1])), Some(context()));
        let value = resolve_effect("alldebrid", &err);
        assert_eq!(value["status"], 404);
        assert_eq!(value["kind"], "dub_lie");
        assert_eq!(
            value["body"],
            "o torrent anunciado como dublado contém conteúdo em inglês"
        );
        assert_eq!(value["mark"], "lie");
        assert_eq!(value["unprotect"], true);
        assert_eq!(value["invalidate"], "obra");
        assert_eq!(value["index"], "lied");
        assert_eq!(value["evidence"]["wantedSeason"], 2);
        assert_eq!(value["evidence"]["declaredEpisodes"], json!([1]));
        assert_eq!(value["context"]["videoCount"], 3);
        assert_eq!(value["noteBlocked"], false);
    }

    #[test]
    fn episodio_com_prova_marca_missing_ou_a_temporada() {
        let with_ep = DebridError::from_pick(PickCode::EpisodePick, Some(evidence(vec![4])), None);
        let missing = resolve_effect("debridlink", &with_ep);
        assert_eq!(missing["status"], 404);
        assert_eq!(missing["kind"], "episode_pick");
        assert_eq!(missing["body"], "este episódio não foi encontrado no pack");
        assert!(missing["mark"].is_null());
        assert_eq!(missing["invalidate"], "obra");
        assert_eq!(missing["index"], "missing");
        assert_eq!(missing["evidence"]["sample"], "ep.mkv");

        let season = DebridError::from_pick(
            PickCode::EpisodePick,
            Some(evidence(Vec::new())),
            Some(context()),
        );
        let value = resolve_effect("premiumize", &season);
        assert_eq!(value["index"], "missing-season");
        assert_eq!(value["invalidate"], "obra");
        assert_eq!(value["evidence"]["declaredEpisodes"], json!([]));
        assert_eq!(value["context"]["samples"][0], "a.mkv");
    }

    #[test]
    fn episodio_sem_prova_nao_invalida_nem_pede_outro_download() {
        let err = DebridError::from_pick(PickCode::EpisodePick, None, Some(context()));
        let value = resolve_effect("torbox", &err);
        assert_eq!(value["status"], 404);
        assert!(value["mark"].is_null());
        assert_eq!(value["invalidate"], "none");
        assert!(value["index"].is_null());
        assert!(value["evidence"].is_null());
        assert_eq!(value["context"]["videoCount"], 3);
        assert!(value.get("url").is_none());
    }

    #[test]
    fn outro_vira_502_neutro_sem_vazar_a_mensagem() {
        let auth = resolve_effect("realdebrid", &DebridError::Auth("apikey=segredo".into()));
        assert_eq!(auth["status"], 502);
        assert_eq!(auth["kind"], "auth");
        assert_eq!(auth["body"], "falha ao resolver no debrid");
        assert_eq!(auth["invalidate"], "none");
        assert!(auth["mark"].is_null());
        assert!(!auth.to_string().contains("segredo"));

        let quota = resolve_effect("premiumize", &DebridError::Quota("quota".into()));
        assert_eq!(quota["status"], 502);
        assert_eq!(quota["kind"], "quota");
    }

    #[test]
    fn link_ganha_prova_sem_trocar_o_formato_antigo() {
        let plain = link_error_json(&DebridError::NoVideo("n".into()), "n");
        assert_eq!(
            plain,
            json!({ "error": "no_video", "kind": "no_video", "message": "n" })
        );

        let err = DebridError::from_pick(PickCode::EpisodePick, Some(evidence(vec![9])), None);
        let body = link_error_json(&err, err.message());
        assert_eq!(body["error"], "episode_pick");
        assert_eq!(body["kind"], "episode_pick");
        assert_eq!(body["evidence"]["declaredEpisodes"], json!([9]));
        assert!(body.get("context").is_none());
        assert!(body.get("status").is_none());
    }
}
