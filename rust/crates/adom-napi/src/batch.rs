//! Avaliação em lote de releases: uma chamada NAPI devolve, para cada release,
//! todos os veredictos que o lado Node precisa (normalização, origem BR,
//! infoHash, nome do `dn=`, S/E, filtro estrito de título e segurança do link).
//!
//! O ganho vem do lote: por chamada o napi é mais lento que o TS (travessia de
//! string na fronteira), então só compensa mandar muitas releases de uma vez.
//!
//! Toda a decisão mora em `evaluate_one`, função pura e testável sem Node. A
//! função exposta (`evaluate_releases`) só mapeia o vetor.
//!
//! Convenção de vazio: no contrato TS, `null`/`undefined` chega como `""`
//! (magnet, link, name, year) ou como lista vazia (`allNames`). Cada campo
//! vazio vira o equivalente falso ou `None` do lado Rust, sem inventar valor.

use adom_core::{
    br_origin_mark, extract_info_hash, has_pt_signs, is_safe_download_url, magnet_display_name,
    matches_br_title, normalize_title, parse_title_season_episode,
};
use napi_derive::napi;

/// Entrada de uma release. Strings vazias significam "ausente".
#[napi(object)]
pub struct ReleaseProbe {
    /// Título cru da release.
    pub title: String,
    /// URI magnet (`""` = sem magnet).
    pub magnet: String,
    /// Link de download (`""` = sem link).
    pub link: String,
    /// Nome da obra procurada (`""` = sem nome).
    pub name: String,
    /// Ano da obra (`""` = sem ano). Vazio não contradiz nenhum ano.
    pub year: String,
    /// `true` para série, `false` para filme.
    pub is_series: bool,
    /// Todos os nomes da obra. Lista vazia pula o portão de precisão.
    pub all_names: Vec<String>,
    /// Espelha `config.search.titlePrecisionTailCut` do TS.
    pub cut_tail: bool,
}

/// Veredictos calculados para uma release, na mesma ordem da entrada.
#[napi(object)]
pub struct ReleaseVerdict {
    /// `normalize_title(title)`.
    pub normalized: String,
    /// `has_pt_signs(title)`.
    pub has_pt_signs: bool,
    /// `br_origin_mark(title)`.
    pub br_origin_mark: bool,
    /// infoHash do magnet; `None` quando não há magnet ou não é reconhecido.
    pub info_hash: Option<String>,
    /// Nome escondido no `dn=` do magnet (`""` quando não há).
    pub display_name: String,
    /// Temporadas do título.
    pub seasons: Vec<i64>,
    /// Episódios do título.
    pub episodes: Vec<i64>,
    /// Série completa ("todas as temporadas").
    pub complete: bool,
    /// Pack de temporada ("temporada completa").
    pub season_pack: bool,
    /// Filtro estrito de título. Sem `name` é `false`: não há o que casar.
    pub matches_br_title: bool,
    /// Link seguro para download público. Sem link é `false`.
    pub safe_link: bool,
}

/// Calcula os veredictos de uma release. Função pura: sem I/O e sem estado.
pub(crate) fn evaluate_one(probe: &ReleaseProbe) -> ReleaseVerdict {
    let title = probe.title.as_str();
    let parsed = parse_title_season_episode(title);

    // `extract_info_hash("")` já devolve `None`; o ramo explícito deixa claro
    // que magnet vazio nunca chega ao parser.
    let info_hash = if probe.magnet.is_empty() {
        None
    } else {
        extract_info_hash(&probe.magnet)
    };

    // `magnet_display_name` trata `None` e `""` como falsy; passar `None` para
    // magnet vazio mantém a mesma leitura do `||` do JS.
    let magnet_arg = (!probe.magnet.is_empty()).then_some(probe.magnet.as_str());
    let display_name = magnet_display_name(magnet_arg, None, None);

    // Sem `name` não há obra para casar: o filtro falha em vez de aceitar tudo.
    // `all_names` vazio vira `None` (sem medida de precisão), como `null` no TS.
    let matches = if probe.name.is_empty() {
        false
    } else {
        let all_names = (!probe.all_names.is_empty()).then_some(probe.all_names.as_slice());
        matches_br_title(
            title,
            &probe.name,
            &probe.year,
            probe.is_series,
            all_names,
            None,
            None,
            probe.cut_tail,
        )
    };

    let safe_link = !probe.link.is_empty() && is_safe_download_url(&probe.link, false);

    ReleaseVerdict {
        normalized: normalize_title(title),
        has_pt_signs: has_pt_signs(title),
        br_origin_mark: br_origin_mark(title),
        info_hash,
        display_name,
        seasons: parsed.seasons,
        episodes: parsed.episodes,
        complete: parsed.complete,
        season_pack: parsed.season_pack,
        matches_br_title: matches,
        safe_link,
    }
}

/// Avalia um lote de releases. Devolve um veredicto por entrada, na mesma ordem.
#[napi(catch_unwind)]
pub fn evaluate_releases(probes: Vec<ReleaseProbe>) -> Vec<ReleaseVerdict> {
    probes.iter().map(evaluate_one).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "aabbccddeeff00112233445566778899aabbccdd";

    fn probe(title: &str) -> ReleaseProbe {
        ReleaseProbe {
            title: title.to_string(),
            magnet: String::new(),
            link: String::new(),
            name: String::new(),
            year: String::new(),
            is_series: false,
            all_names: Vec::new(),
            cut_tail: true,
        }
    }

    fn series_probe(title: &str) -> ReleaseProbe {
        ReleaseProbe {
            name: "Show".to_string(),
            is_series: true,
            all_names: vec!["Show".to_string()],
            ..probe(title)
        }
    }

    #[test]
    fn serie_episodio_s01e02() {
        let v = evaluate_one(&series_probe("Show S01E02 1080p DUBLADO"));
        assert_eq!(v.seasons, vec![1]);
        assert_eq!(v.episodes, vec![2]);
        assert!(!v.season_pack);
        assert!(v.matches_br_title);
        assert!(v.has_pt_signs);
        assert!(v.br_origin_mark);
    }

    #[test]
    fn pack_de_temporada() {
        let v = evaluate_one(&series_probe("Show Temporada Completa 1080p"));
        assert!(v.season_pack);
        assert_eq!(
            v.normalized,
            normalize_title("Show Temporada Completa 1080p")
        );
    }

    #[test]
    fn magnet_com_dn_extrai_hash_e_nome() {
        let mut p = series_probe("Show S01E02 1080p");
        p.magnet = format!("magnet:?xt=urn:btih:{HASH}&dn=Show.S01E02");
        let v = evaluate_one(&p);
        assert_eq!(v.info_hash.as_deref(), Some(HASH));
        assert_eq!(v.display_name, "Show.S01E02");
    }

    #[test]
    fn magnet_vazio_nao_tem_hash_nem_nome() {
        let v = evaluate_one(&series_probe("Show S01E02 1080p"));
        assert_eq!(v.info_hash, None);
        assert_eq!(v.display_name, "");
    }

    #[test]
    fn link_privado_nao_e_seguro() {
        let mut p = probe("Show 1080p");
        p.link = "http://127.0.0.1/x".to_string();
        assert!(!evaluate_one(&p).safe_link);
    }

    #[test]
    fn link_publico_e_seguro() {
        let mut p = probe("Show 1080p");
        p.link = "https://example.com/x".to_string();
        assert!(evaluate_one(&p).safe_link);
    }

    #[test]
    fn link_vazio_nao_e_seguro() {
        assert!(!evaluate_one(&probe("Show 1080p")).safe_link);
    }

    #[test]
    fn name_vazio_nao_casa_titulo() {
        let mut p = probe("Show S01E02 1080p DUBLADO");
        p.all_names = vec!["Show".to_string()];
        assert!(!evaluate_one(&p).matches_br_title);
    }

    #[test]
    fn filme_br_dublado_casa_titulo() {
        let p = ReleaseProbe {
            name: "Filme".to_string(),
            year: "2020".to_string(),
            all_names: vec!["Filme".to_string()],
            ..probe("Filme 2020 1080p DUBLADO")
        };
        let v = evaluate_one(&p);
        assert!(v.matches_br_title);
        assert!(v.br_origin_mark);
    }

    #[test]
    fn ano_vazio_nao_contradiz() {
        let p = ReleaseProbe {
            name: "Filme".to_string(),
            all_names: vec!["Filme".to_string()],
            ..probe("Filme 2020 1080p")
        };
        assert!(evaluate_one(&p).matches_br_title);
    }

    #[test]
    fn lote_preserva_ordem_e_tamanho() {
        let out = evaluate_releases(vec![
            series_probe("Show S01E02 1080p"),
            series_probe("Show Temporada Completa 1080p"),
        ]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].episodes, vec![2]);
        assert!(out[1].season_pack);
    }

    #[test]
    fn lote_vazio_devolve_vazio() {
        assert!(evaluate_releases(Vec::new()).is_empty());
    }
}
