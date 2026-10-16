//! Porte em lote do laço de decisão de `filterSeriesEpisodeRaw`
//! (`src/providers/stream-builder-episode-filter.ts`).
//!
//! O corte `preAirReleases` (I/O do banco de magnets) e o enriquecimento do
//! magnet pelo banco (`bankByHash`) ficam do lado Node: o caller já recebe os
//! itens com o magnet enriquecido e manda a lista de hashes excluídos por
//! pré-estreia. Aqui roda SÓ o laço por item, na MESMA ordem do TS:
//!
//! 1. `pre-air` — hash na lista de pré-estreia ( TS: `preAir.has(hashOfRaw)` )
//! 2. `episode` — `matchesEpisode` sobre o título
//! 3. `series-work` — no global sem marcador, `matchesGlobalSeriesNoMarker`
//!    reprova (TS solta sem rótulo; este é o único corte "de trabalho" do
//!    ramo global)
//! 4. `unaired` — episódio ainda não exibido e nenhum título/dn o nomeia
//! 5. `article` — conta/BR: `foreignArticle` (abre com artigo estrangeiro aos
//!    nomes da obra)
//!
//! Os rótulos são desta build (o TS atual não rotula este laço); ficam
//! estáveis como posição do enum — o Node traduz código → string.
//!
//! `cut_tail` espelha `config.search.titlePrecisionTailCut` (default `true`),
//! lido dentro de `matchesGlobalSeriesNoMarker` no TS.

use crate::episode_matching::matches_episode;
use crate::episode_parse::parse_title_season_episode;
use crate::episode_series_matching::matches_global_series_no_marker;
use crate::info_hash::extract_info_hash;
use crate::magnet_display_name::magnet_display_name;
use crate::release_guards::magnet_season_contradicts;
use crate::title_normalization::normalize_title;

/// Campos de `RawItem` que o laço lê. `None`/vazio = ausente (o `||` do JS).
/// `magnet` chega JÁ ENRIQUECIDO pelo banco (o TS clona o item antes do laço).
pub struct EpisodeFilterItem<'a> {
    pub title: Option<&'a str>,
    pub title_pascal: Option<&'a str>,
    pub magnet: Option<&'a str>,
    pub magnet_uri: Option<&'a str>,
    pub guid: Option<&'a str>,
    pub info_hash: Option<&'a str>,
    pub from_account: bool,
    pub is_br: bool,
}

/// Motivo do corte, na ordem em que o TS dispara o `continue`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeriesEpisodeRejectReason {
    PreAir = 0,
    Episode = 1,
    SeriesWork = 2,
    Unaired = 3,
    Article = 4,
}

/// Partição do lote: índices mantidos e, em ordem de disparo, os cortados.
pub struct SeriesEpisodeOutcome {
    pub kept: Vec<u32>,
    pub rejected: Vec<(u32, SeriesEpisodeRejectReason)>,
}

/// ARTICLES do TS: `new Set(['a', 'o', 'as', 'os', 'the'])`.
fn is_article(token: &str) -> bool {
    matches!(token, "a" | "o" | "as" | "os" | "the")
}

/// `normalizeTitle(s).split(' ').filter(Boolean)[0] || ''`.
fn first_token(s: &str) -> String {
    normalize_title(s)
        .split(' ')
        .find(|t| !t.is_empty())
        .unwrap_or("")
        .to_string()
}

/// `hashOfRaw`: `extractInfoHash(r.infoHash || r.magnet)`, minúsculo.
fn hash_of(item: &EpisodeFilterItem) -> String {
    let raw = match item.info_hash {
        Some(h) if !h.is_empty() => h,
        _ => item.magnet.unwrap_or(""),
    };
    extract_info_hash(raw).unwrap_or_default()
}

/// `magnetDisplayName(r)`: dn do primeiro campo preenchido.
fn dn_of(item: &EpisodeFilterItem) -> String {
    magnet_display_name(item.magnet, item.magnet_uri, item.guid)
}

/// `namesEpisode`: título OU dn nomeiam o episódio pedido.
fn names_episode(item: &EpisodeFilterItem, title: &str, episode: i64) -> bool {
    let dn = dn_of(item);
    let hit = [title, dn.as_str()]
        .into_iter()
        .any(|t| parse_title_season_episode(t).episodes.contains(&episode));
    hit
}

/// `foreignArticle`: título e dn sem marcador de série nenhum + o 1º token do
/// título é artigo ausente do 1º token de todos os nomes da obra.
fn foreign_article(item: &EpisodeFilterItem, title: &str, names: &[String]) -> bool {
    if names.is_empty() {
        return false;
    }
    let dn = dn_of(item);
    for t in [title, dn.as_str()] {
        let p = parse_title_season_episode(t);
        if !p.seasons.is_empty() || !p.episodes.is_empty() || p.complete || p.season_pack {
            return false;
        }
    }
    let first = first_token(title);
    if !is_article(&first) {
        return false;
    }
    !names.iter().any(|n| *first_token(n) == first)
}

/// O laço em lote, na ordem exata do TS.
///
/// `universe_tokens` é `seriesUniverse`; `names` são os nomes da obra
/// (aliases); `pre_air_hashes` já vêm minúsculos do Node.
#[allow(clippy::too_many_arguments)]
pub fn filter_series_episode(
    items: &[EpisodeFilterItem],
    season: i64,
    episode: i64,
    universe_tokens: &[String],
    names: &[String],
    unaired: bool,
    pre_air_hashes: &[String],
    cut_tail: bool,
) -> SeriesEpisodeOutcome {
    let mut kept = Vec::new();
    let mut rejected = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let title = item
            .title
            .filter(|t| !t.is_empty())
            .or(item.title_pascal)
            .unwrap_or("");
        if pre_air_hashes.iter().any(|h| *h == hash_of(item)) {
            rejected.push((i as u32, SeriesEpisodeRejectReason::PreAir));
            continue;
        }
        if !matches_episode(title, Some(season), Some(episode)) {
            rejected.push((i as u32, SeriesEpisodeRejectReason::Episode));
            continue;
        }
        if magnet_season_contradicts(
            item.magnet,
            item.magnet_uri,
            item.guid,
            season,
            Some(episode),
        ) {
            // Mesmo corte do ramo 2, mas por evidência do dn; mesmo rótulo.
            rejected.push((i as u32, SeriesEpisodeRejectReason::Episode));
            continue;
        }
        if unaired && !names_episode(item, title, episode) {
            rejected.push((i as u32, SeriesEpisodeRejectReason::Unaired));
            continue;
        }
        if item.from_account || item.is_br {
            if foreign_article(item, title, names) {
                rejected.push((i as u32, SeriesEpisodeRejectReason::Article));
            } else {
                kept.push(i as u32);
            }
            continue;
        }
        let tokens: Vec<String> = first_token_runs(title);
        if matches_global_series_no_marker(title, &tokens, universe_tokens, cut_tail) {
            kept.push(i as u32);
        } else {
            rejected.push((i as u32, SeriesEpisodeRejectReason::SeriesWork));
        }
    }
    SeriesEpisodeOutcome { kept, rejected }
}

/// `normalizeTitle(title).split(' ').filter(Boolean)` — o TS passa ESTES tokens
/// ao `matchesGlobalSeriesNoMarker` (não é o `titleTokens` do vocabulário).
fn first_token_runs(title: &str) -> Vec<String> {
    normalize_title(title)
        .split(' ')
        .filter(|t| !t.is_empty())
        .map(String::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(title: &str) -> EpisodeFilterItem<'_> {
        EpisodeFilterItem {
            title: Some(title),
            title_pascal: None,
            magnet: None,
            magnet_uri: None,
            guid: None,
            info_hash: None,
            from_account: false,
            is_br: false,
        }
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn run<'a>(
        items: &[EpisodeFilterItem<'a>],
        pre_air: &[&str],
        unaired: bool,
        names: &[String],
        universe: &[String],
    ) -> SeriesEpisodeOutcome {
        let hashes: Vec<String> = pre_air.iter().map(|s| s.to_string()).collect();
        filter_series_episode(items, 1, 2, universe, names, unaired, &hashes, true)
    }

    #[test]
    fn episódio_errado_corta_com_rótulo_episode() {
        let items = [item("Serie S01E03 1080p"), item("Serie S01E02 1080p")];
        let out = run(&items, &[], false, &[], &names(&["Serie"]));
        assert_eq!(out.kept, vec![1]);
        assert_eq!(out.rejected, vec![(0, SeriesEpisodeRejectReason::Episode)]);
    }

    #[test]
    fn pack_da_temporada_passa_sem_episódio_no_título() {
        let items = [
            item("Serie S01 2160p WEB-DL"),
            item("Serie Temporada 1 Completa"),
        ];
        let out = run(&items, &[], false, &[], &names(&["Serie"]));
        assert_eq!(out.kept, vec![0, 1]);
        assert!(out.rejected.is_empty());
    }

    #[test]
    fn dn_do_magnet_contradiz_o_episódio() {
        let mut a = item("Serie S01E02 1080p");
        a.magnet =
            Some("magnet:?xt=urn:btih:0123456789012345678901234567890123456789&dn=Serie+S01E05");
        let items = [a];
        let out = run(&items, &[], false, &[], &names(&["Serie"]));
        assert_eq!(out.rejected, vec![(0, SeriesEpisodeRejectReason::Episode)]);
    }

    #[test]
    fn pre_air_corta_pelo_hash_antes_de_tudo() {
        let hash = "0123456789012345678901234567890123456789";
        let mut a = item("Serie S01E02 1080p");
        a.info_hash = Some(hash);
        let items = [a];
        let out = run(&items, &[hash], false, &[], &names(&["Serie"]));
        assert_eq!(out.rejected, vec![(0, SeriesEpisodeRejectReason::PreAir)]);
    }

    #[test]
    fn pre_air_só_bate_hash_igual() {
        let items = [item("Serie S01E02 1080p")];
        let out = run(
            &items,
            &["ffffffffffffffffffffffffffffffffffffffff"],
            false,
            &[],
            &names(&["Serie"]),
        );
        assert_eq!(out.kept, vec![0]);
    }

    #[test]
    fn unaired_sem_nome_do_episódio_corta_pack() {
        let items = [item("Serie S01 2160p"), item("Serie S01E02 1080p")];
        let out = run(&items, &[], true, &[], &names(&["Serie"]));
        assert_eq!(out.kept, vec![1]);
        assert_eq!(out.rejected, vec![(0, SeriesEpisodeRejectReason::Unaired)]);
    }

    #[test]
    fn unaired_com_dn_nomeando_passa() {
        let mut a = item("Serie Temporada 1");
        a.magnet =
            Some("magnet:?xt=urn:btih:0123456789012345678901234567890123456789&dn=Serie+S01E02");
        let items = [a];
        let out = run(&items, &[], true, &[], &names(&["Serie"]));
        assert_eq!(out.kept, vec![0]);
    }

    #[test]
    fn unaired_falso_não_corta_pack() {
        let items = [item("Serie S01 2160p")];
        let out = run(&items, &[], false, &[], &names(&["Serie"]));
        assert_eq!(out.kept, vec![0]);
    }

    #[test]
    fn artigo_estrangeiro_na_conta_corta() {
        // "A Origem" = Inception; o nome pt da obra ("From") não abre com "a".
        let mut a = item("A Origem 4k 2160p Dual Audio");
        a.from_account = true;
        let items = [a, item("A Origem 4k 2160p Dual Audio")];
        let out = run(&items, &[], false, &names(&["From"]), &names(&["From"]));
        // O gêmeo global do mesmo título cai no portão de precisão do global
        // ("a" é artigo, não soma precisão contra o universo "From").
        assert_eq!(
            out.rejected,
            vec![
                (0, SeriesEpisodeRejectReason::Article),
                (1, SeriesEpisodeRejectReason::SeriesWork)
            ]
        );
        assert!(out.kept.is_empty());
    }

    #[test]
    fn artigo_presente_no_nome_pt_não_corta() {
        // "O Urso" (The Bear): o nome pt tem o artigo.
        let mut a = item("O Urso S01E02 Dual Audio");
        a.is_br = true;
        let items = [a];
        let out = run(
            &items,
            &[],
            false,
            &names(&["O Urso", "The Bear"]),
            &names(&["O Urso", "The Bear"]),
        );
        assert_eq!(out.kept, vec![0]);
    }

    #[test]
    fn com_marcador_de_série_o_artigo_se_cala() {
        let mut a = item("A Origem S01E02 Dual Audio");
        a.from_account = true;
        let items = [a];
        let out = run(&items, &[], false, &names(&["From"]), &names(&["From"]));
        assert_eq!(out.kept, vec![0]);
    }

    #[test]
    fn global_sem_marcador_e_outra_obra_corta_series_work() {
        let items = [item("Filme Qualquer 2020 1080p")];
        let out = run(&items, &[], false, &[], &names(&["Serie Original"]));
        assert_eq!(
            out.rejected,
            vec![(0, SeriesEpisodeRejectReason::SeriesWork)]
        );
    }

    #[test]
    fn br_sem_marcador_não_passa_pelo_portão_global() {
        let mut a = item("Serie Nacional Dublada Completa");
        a.is_br = true;
        let items = [a];
        let out = run(&items, &[], false, &names(&["Serie"]), &names(&["Serie"]));
        assert_eq!(out.kept, vec![0]);
    }

    #[test]
    fn ordem_dos_cortes_no_lote() {
        let hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let mut pre = item("Serie S01E02 1080p");
        pre.info_hash = Some(hash);
        let items = [pre, item("Serie S01E09 1080p"), item("Serie S01E02 1080p")];
        let out = run(&items, &[hash], false, &[], &names(&["Serie"]));
        assert_eq!(out.kept, vec![2]);
        assert_eq!(
            out.rejected,
            vec![
                (0, SeriesEpisodeRejectReason::PreAir),
                (1, SeriesEpisodeRejectReason::Episode)
            ]
        );
    }

    #[test]
    fn title_vazio_cai_no_title_pascal() {
        let mut a = item("");
        a.title_pascal = Some("Serie S01E02 1080p");
        let items = [a];
        let out = run(&items, &[], false, &[], &names(&["Serie"]));
        assert_eq!(out.kept, vec![0]);
    }
}
