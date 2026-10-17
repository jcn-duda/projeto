//! Fronteira napi da classificação do catálogo durável
//! (`adom_core::catalog_classify`): rótulo da prova, classificação pelo título e
//! pelos arquivos.
//!
//! As listas calibradas (`ptMarkers`/`enGroups`) entram por parâmetro, como em
//! `audio-quality.ts`; nada aqui lê `config`. UMA função com `op`
//! (`label`/`title`/`evidence`) porque a travessia de string é o custo dominante
//! e as três compartilham a mesma entrada — a saída é a MESMA string do golden
//! (`cena`/`audio`/`sim` ou `bucket|audio|foreignProof|ptProof`), não um objeto.

use adom_core as core;
use napi_derive::napi;
use serde::Deserialize;

/// `{ op, filename?, evidence?, candidates, ptMarkers, enGroups }`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct CatalogClassifyInput {
    op: String,
    filename: Option<String>,
    evidence: Option<String>,
    candidates: Vec<String>,
    pt_markers: Vec<String>,
    en_groups: Vec<String>,
}

/// `foreignProofLabel` do TS (`cena`/`audio`/`sim`) ou as duas classificações no
/// formato do golden (`bucket|audio|foreignProof|ptProof`).
#[napi(catch_unwind)]
pub fn catalog_classify(input: String) -> napi::Result<String> {
    let req: CatalogClassifyInput = serde_json::from_str(&input)
        .map_err(|e| napi::Error::from_reason(format!("entrada JSON inválida: {e}")))?;
    let pt: Vec<&str> = req.pt_markers.iter().map(String::as_str).collect();
    let en: Vec<&str> = req.en_groups.iter().map(String::as_str).collect();
    let filename = req.filename.as_deref().unwrap_or("");
    let line = |p: core::Proof| {
        format!(
            "{}|{}|{}|{}",
            p.bucket, p.audio, p.foreign_proof, p.pt_proof
        )
    };
    Ok(match req.op.as_str() {
        "label" => {
            let candidates: Vec<&str> = req.candidates.iter().map(String::as_str).collect();
            core::foreign_proof_label(&candidates, &pt, &en).to_string()
        }
        "title" => line(core::classify_by_title(filename, &pt, &en)),
        "evidence" => line(core::classify_with_evidence(
            filename,
            req.evidence.as_deref(),
            &pt,
            &en,
        )),
        other => {
            return Err(napi::Error::from_reason(format!(
                "op desconhecida: {other}"
            )))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn label_classifica_na_ordem_do_golden() {
        let out = catalog_classify(
            json!({
                "op": "label",
                "candidates": ["Movie 1080p", "Movie FRENCH 1080p"],
                "ptMarkers": ["dublado"],
                "enGroups": ["sparks"],
            })
            .to_string(),
        )
        .expect("ok");
        assert_eq!(out, "audio");
    }

    #[test]
    fn title_devolve_a_linha_canonica() {
        let out = catalog_classify(
            json!({
                "op": "title",
                "filename": "Filme Dublado 1080p",
                "ptMarkers": ["dublado"],
                "enGroups": ["sparks"],
            })
            .to_string(),
        )
        .expect("ok");
        assert_eq!(out, "dub|||titulo");
    }

    #[test]
    fn op_desconhecida_e_json_invalido_viram_erro() {
        assert!(catalog_classify(json!({"op": "outra"}).to_string()).is_err());
        assert!(catalog_classify("{".into()).is_err());
    }
}
