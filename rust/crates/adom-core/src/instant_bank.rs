//! Regra PURA da seleção da via instantânea do banco de magnets.
//!
//! Porte da parte sem I/O de `collectInstantItems`
//! (`src/providers/magnet-bank-instant.ts`): a leitura do SQLite
//! (`worksForObraMany`/`sourcesForMany`) e a janela adaptativa
//! (`adom_core::search_bank::instant_window`) ficam FORA; aqui entram as linhas
//! já lidas e os fatos da requisição, e saem os itens que o build consome com o
//! selo 📦 (`fromFallback` no item de fio).
//!
//! Regras preservadas do TS:
//!
//! - dedupe por hash mantendo o MAGNET da primeira linha e a OBRA "medida"
//!   (`passed_filter == 1`) quando alguma linha do hash já passou no filtro vivo;
//! - `lied` e linha sem hash/magnet saem antes de tudo;
//! - elegibilidade: `passed_filter == 1` OU fonte index-only (o só-colhedor
//!   nunca passa pela busca viva); a fonte ainda precisa ser permitida pela
//!   config do pedido (`allowed`);
//! - hash já no índice (`exclude_hashes`) não vira 📦 — o idx é evidência
//!   melhor;
//! - com `prefer_dubbed`, o dublado do acervo vem ANTES do teto: ordenar só por
//!   seeders deixava o global mais semeado ocupar a vaga e cortava o BR;
//! - ordenação `dubRank`, `seedersMax` desc, `lastSeen` desc (estável), depois
//!   teto por indexer e global (o global por último, como no TS).
//!
//! A cobertura (`idx_pool_covered`) e a reaplicação do filtro de título
//! (`filter_relevant_raw`) rodam no CHAMADOR: são as mesmas regras já portadas
//! e o chamador tem a config viva do pedido.

use std::collections::{BTreeMap, HashSet};

use crate::audio_lang::names_foreign_dub_language;
use crate::audio_presentation::{audio_from_title, looks_pt_br};
use crate::br_origin::has_pt_signs;
use crate::search_bank::{pick_source, SourceRow};

/// `PER_INDEXER_MAX` do TS (piso do teto por indexer).
pub const INSTANT_PER_INDEXER_MAX: i64 = 40;
/// Teto global default do TS (`fallbackGlobalMax`).
pub const INSTANT_GLOBAL_MAX: i64 = 40;

/// Uma linha do acervo (`magnet`) como a seleção a lê.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstantMagnet {
    pub hash: String,
    pub uri: String,
    pub title: String,
    pub size: i64,
    pub is_br: bool,
    pub dubbed: bool,
    pub quality: String,
    pub seeders_max: i64,
    pub seeders_last: i64,
    pub last_seen: i64,
    pub lied: bool,
}

/// Obra do banco + o magnet dela (`magnet_work` + `magnet`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstantWork {
    pub hash: String,
    pub passed_filter: i64,
    pub last_seen: i64,
    pub first_seen: i64,
    pub magnet: Option<InstantMagnet>,
}

/// Fonte do hash (`magnet_source`), já com o veredito de `allowedSourceIndexer`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstantSource {
    pub indexer: String,
    pub tracker: String,
    pub last_seen: i64,
    pub allowed: bool,
}

/// Entrada da seleção. A janela adaptativa/`stale` é decidida antes (o chamador
/// tem o relógio e as linhas de TODOS os alvos) — aqui é só a escolha.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstantInput {
    /// `passed_filter`/`index_only`/ordem são lidos daqui.
    pub works: Vec<InstantWork>,
    pub sources: BTreeMap<String, Vec<InstantSource>>,
    /// Hashes já presentes no índice (evidência melhor; não viram 📦).
    pub exclude_hashes: HashSet<String>,
    pub index_only_indexers: Vec<String>,
    pub prefer_dubbed: bool,
    /// `fallbackMaxPerIndexer` já clampado pelo chamador.
    pub per_indexer_max: i64,
    /// `fallbackGlobalMax` já clampado pelo chamador.
    pub global_max: i64,
}

/// Item da reserva instantânea, na forma do `toRawItem` do TS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstantItem {
    pub title: String,
    pub info_hash: String,
    pub magnet: Option<String>,
    pub size: Option<i64>,
    pub seeders: i64,
    pub indexer: String,
    pub tracker: String,
    pub is_br: bool,
    pub dubbed: bool,
    pub quality: String,
    pub fallback_fetchable: bool,
}

/// Resultado da seleção (sem filtro de título/cobertura, que são do chamador).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InstantSelection {
    pub items: Vec<InstantItem>,
    /// Quantos hashes já indexados foram excluídos (métrica `skip.idx-hash`).
    pub idx_hash_skipped: usize,
}

fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

fn limit_per_indexer(raw: i64) -> i64 {
    let value = if raw == 0 {
        INSTANT_PER_INDEXER_MAX
    } else {
        raw
    };
    value.clamp(1, INSTANT_PER_INDEXER_MAX)
}

fn limit_global(raw: i64) -> i64 {
    let value = if raw == 0 { INSTANT_GLOBAL_MAX } else { raw };
    value.clamp(1, 500)
}

/// `\b(?:LEGENDAD[OA]|DUBLAD[OA]|NACIONAL)\b` do TS, sobre tokens ASCII (o `\b`
/// do JS também é ASCII): "LEGENDADO" prova origem, não idioma estrangeiro.
fn pt_label(text: &str) -> bool {
    const LABELS: [&str; 5] = ["LEGENDADO", "LEGENDADA", "DUBLADO", "DUBLADA", "NACIONAL"];
    let mut token = String::new();
    let check = |token: &mut String| -> bool {
        let upper = token.to_ascii_uppercase();
        let hit = LABELS.contains(&upper.as_str());
        token.clear();
        hit
    };
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            token.push(ch);
        } else if check(&mut token) {
            return true;
        }
    }
    check(&mut token)
}

/// `fallbackIsBr` SEM `brSource` (a via instantânea não decide a fonte BR): o
/// `is_br` gravado só SOBE e pode ser de antes da guarda — idioma estrangeiro no
/// título sem NENHUM sinal PT desmente o rótulo velho.
fn instant_is_br(magnet: &InstantMagnet) -> bool {
    if !magnet.is_br {
        return false;
    }
    let title = magnet.title.as_str();
    !(names_foreign_dub_language(title)
        && !has_pt_signs(title)
        && !looks_pt_br(title)
        && !pt_label(title))
}

/// `dubRank`: quem prefere dublado recebe o dublado do acervo antes do teto.
fn dub_rank(magnet: &InstantMagnet, prefer_dubbed: bool) -> i64 {
    if !prefer_dubbed {
        return 0;
    }
    let audio = audio_from_title(&magnet.title);
    let dubbed = looks_pt_br(&magnet.title)
        || (magnet.is_br && matches!(audio, "Dublado" | "Dual" | "Nacional"));
    if dubbed {
        0
    } else {
        1
    }
}

fn to_item(
    magnet: &InstantMagnet,
    source: &InstantSource,
    work: &InstantWork,
    index_only: &HashSet<String>,
) -> InstantItem {
    let uri = magnet.uri.as_str();
    let indexer_id = normalize(&source.indexer);
    let fetchable = work.passed_filter == 1 || index_only.contains(&indexer_id);
    InstantItem {
        title: if magnet.title.is_empty() {
            "Torrent".to_string()
        } else {
            magnet.title.clone()
        },
        info_hash: magnet.hash.clone(),
        magnet: uri.starts_with("magnet:").then(|| uri.to_string()),
        size: (magnet.size > 0).then_some(magnet.size),
        seeders: magnet.seeders_last,
        indexer: source.indexer.clone(),
        tracker: source.tracker.clone(),
        is_br: instant_is_br(magnet),
        dubbed: magnet.dubbed,
        quality: magnet.quality.clone(),
        fallback_fetchable: fetchable,
    }
}

/// Seleciona a reserva instantânea. Lista vazia = nenhum candidato elegível; o
/// chamador conta o motivo (`no-live-collection` no TS) e segue ao vivo.
pub fn select_instant(input: &InstantInput) -> InstantSelection {
    let mut out = InstantSelection::default();
    let per_indexer_max = limit_per_indexer(input.per_indexer_max);
    let global_max = limit_global(input.global_max);
    let index_only: HashSet<String> = input
        .index_only_indexers
        .iter()
        .map(|id| normalize(id))
        .collect();

    // 1. Dedupe por hash na ORDEM das linhas. O magnet fica o primeiro; a obra
    //    pode ser trocada pela linha medida (`passed_filter == 1`), porque o
    //    MESMO magnet tem até três linhas (episódio/temporada/raiz) e o pack
    //    achado na busca do episódio pode estar `passed_filter=0` ali mesmo
    //    quando a busca da temporada o validou.
    let mut magnets: Vec<&InstantMagnet> = Vec::new();
    let mut works_by_hash: BTreeMap<&str, &InstantWork> = BTreeMap::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for row in &input.works {
        let Some(magnet) = row.magnet.as_ref() else {
            continue;
        };
        if magnet.hash.is_empty() {
            continue;
        }
        if magnet.lied {
            continue;
        }
        if !seen.insert(magnet.hash.as_str()) {
            if let Some(prior) = works_by_hash.get(magnet.hash.as_str()) {
                if prior.passed_filter != 1 && row.passed_filter == 1 {
                    works_by_hash.insert(magnet.hash.as_str(), row);
                }
            }
            continue;
        }
        magnets.push(magnet);
        works_by_hash.insert(magnet.hash.as_str(), row);
    }

    // 2. Candidatos: exclusão do idx, fonte permitida e elegibilidade.
    let mut candidates: Vec<(&InstantMagnet, &InstantSource, &InstantWork)> = Vec::new();
    for magnet in magnets {
        if input.exclude_hashes.contains(&magnet.hash) {
            out.idx_hash_skipped += 1;
            continue;
        }
        let all_sources = input
            .sources
            .get(&magnet.hash)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let allowed: Vec<&InstantSource> =
            all_sources.iter().filter(|source| source.allowed).collect();
        let work = works_by_hash[magnet.hash.as_str()];
        let eligible = work.passed_filter == 1
            || allowed
                .iter()
                .any(|source| index_only.contains(&normalize(&source.indexer)));
        if !eligible {
            continue;
        }
        // Sem "indexer falho" nesta via: qualquer source do banco vale; a mais
        // recente vence (`pick_source` com `all_failed`).
        let rows: Vec<SourceRow<'_>> = allowed
            .iter()
            .map(|source| SourceRow {
                indexer: source.indexer.as_str(),
                last_seen: source.last_seen,
            })
            .collect();
        let Some(index) = pick_source(&rows, &HashSet::new(), true) else {
            continue;
        };
        candidates.push((magnet, allowed[index], work));
    }

    // 3. Ordem do TS (estável): dublado, seedersMax, lastSeen.
    candidates.sort_by(|(ma, _, _), (mb, _, _)| {
        dub_rank(ma, input.prefer_dubbed)
            .cmp(&dub_rank(mb, input.prefer_dubbed))
            .then_with(|| mb.seeders_max.cmp(&ma.seeders_max))
            .then_with(|| mb.last_seen.cmp(&ma.last_seen))
    });

    // 4. Tetos por ÚLTIMO (o candidato que morreria no build não ocupa vaga).
    let mut per_indexer: BTreeMap<String, i64> = BTreeMap::new();
    for (magnet, source, work) in candidates {
        if out.items.len() as i64 >= global_max {
            break;
        }
        let indexer_id = {
            let id = normalize(&source.indexer);
            if id.is_empty() {
                "unknown".to_string()
            } else {
                id
            }
        };
        let used = per_indexer.get(&indexer_id).copied().unwrap_or(0);
        if used >= per_indexer_max {
            continue;
        }
        per_indexer.insert(indexer_id, used + 1);
        out.items.push(to_item(magnet, source, work, &index_only));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn magnet(
        hash: &str,
        title: &str,
        is_br: bool,
        dubbed: bool,
        seeders: i64,
        seen: i64,
    ) -> InstantMagnet {
        InstantMagnet {
            hash: hash.to_string(),
            uri: format!("magnet:?xt=urn:btih:{hash}&dn={title}"),
            title: title.to_string(),
            size: 10,
            is_br,
            dubbed,
            quality: "1080p".to_string(),
            seeders_max: seeders,
            seeders_last: seeders,
            last_seen: seen,
            lied: false,
        }
    }

    fn work(hash: &str, passed: i64, seen: i64, magnet: Option<InstantMagnet>) -> InstantWork {
        InstantWork {
            hash: hash.to_string(),
            passed_filter: passed,
            last_seen: seen,
            first_seen: seen - 100,
            magnet,
        }
    }

    fn source(indexer: &str, allowed: bool) -> InstantSource {
        InstantSource {
            indexer: indexer.to_string(),
            tracker: String::new(),
            last_seen: 10,
            allowed,
        }
    }

    fn base(
        works: Vec<InstantWork>,
        sources: BTreeMap<String, Vec<InstantSource>>,
    ) -> InstantInput {
        InstantInput {
            works,
            sources,
            exclude_hashes: HashSet::new(),
            index_only_indexers: vec!["redetorrent".to_string()],
            prefer_dubbed: false,
            per_indexer_max: 40,
            global_max: 40,
        }
    }

    #[test]
    fn so_passed_filter_ou_index_only_entra() {
        let mut sources = BTreeMap::new();
        sources.insert("aa".to_string(), vec![source("bludv", true)]);
        sources.insert("bb".to_string(), vec![source("bludv", true)]);
        sources.insert("cc".to_string(), vec![source("redetorrent", true)]);
        let works = vec![
            work("aa", 0, 5, Some(magnet("aa", "Dublado", true, true, 1, 5))),
            work("bb", 1, 6, Some(magnet("bb", "Film", false, false, 9, 6))),
            work(
                "cc",
                0,
                7,
                Some(magnet("cc", "Index only", false, false, 2, 7)),
            ),
        ];
        let out = select_instant(&base(works, sources));
        let hashes: Vec<&str> = out
            .items
            .iter()
            .map(|item| item.info_hash.as_str())
            .collect();
        assert_eq!(
            hashes,
            ["bb", "cc"],
            "0 sem index-only fora; os dois medidos entram"
        );
        assert!(
            out.items[0].fallback_fetchable,
            "passed_filter=1 é baixável"
        );
        assert!(
            out.items[1].fallback_fetchable,
            "index-only é a porta do colhedor"
        );
    }

    #[test]
    fn fonte_fora_da_config_nao_entra() {
        let mut sources = BTreeMap::new();
        sources.insert("aa".to_string(), vec![source("torrentio", false)]);
        let works = vec![work(
            "aa",
            1,
            5,
            Some(magnet("aa", "Film", false, false, 9, 5)),
        )];
        let out = select_instant(&base(works, sources));
        assert!(out.items.is_empty());
    }

    #[test]
    fn prefers_dubbed_antes_do_teto() {
        let mut sources = BTreeMap::new();
        sources.insert("en".to_string(), vec![source("a", true)]);
        sources.insert("br".to_string(), vec![source("b", true)]);
        let works = vec![
            work(
                "en",
                1,
                9,
                Some(magnet(
                    "en",
                    "Movie 2024 1080p BluRay",
                    false,
                    false,
                    5000,
                    9,
                )),
            ),
            work(
                "br",
                1,
                8,
                Some(magnet("br", "Filme Dublado 1080p", true, true, 1, 8)),
            ),
        ];
        let mut input = base(works, sources);
        input.global_max = 1;
        input.prefer_dubbed = true;
        let out = select_instant(&input);
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.items[0].info_hash, "br", "o dublado ocupa a vaga única");
    }

    #[test]
    fn teto_por_indexer() {
        let mut sources = BTreeMap::new();
        let works: Vec<_> = (0..3)
            .map(|i| {
                let hash = format!("h{i}");
                sources.insert(hash.clone(), vec![source("bludv", true)]);
                work(
                    &hash,
                    1,
                    10 + i,
                    Some(magnet(&hash, "Dublado", true, true, 5, 10 + i)),
                )
            })
            .collect();
        let mut input = base(works, sources);
        input.per_indexer_max = 2;
        let out = select_instant(&input);
        assert_eq!(out.items.len(), 2);
    }

    #[test]
    fn hash_do_indice_e_excluido() {
        let mut sources = BTreeMap::new();
        sources.insert("aa".to_string(), vec![source("bludv", true)]);
        let works = vec![work(
            "aa",
            1,
            5,
            Some(magnet("aa", "Film", false, false, 9, 5)),
        )];
        let mut input = base(works, sources);
        input.exclude_hashes.insert("aa".to_string());
        let out = select_instant(&input);
        assert!(out.items.is_empty());
        assert_eq!(out.idx_hash_skipped, 1);
    }

    #[test]
    fn linha_medida_vence_no_mesmo_hash() {
        let mut sources = BTreeMap::new();
        sources.insert("aa".to_string(), vec![source("bludv", true)]);
        // A primeira linha (episódio) não passou; a segunda (temporada) passou.
        let works = vec![
            work("aa", 0, 9, Some(magnet("aa", "Pack", true, true, 1, 9))),
            work(
                "aa",
                1,
                5,
                Some(magnet("aa", "Pack repetido", true, true, 1, 5)),
            ),
        ];
        let out = select_instant(&base(works, sources));
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.items[0].title, "Pack", "magnet da primeira linha");
        assert!(
            out.items[0].fallback_fetchable,
            "obra medida libera o download"
        );
    }

    #[test]
    fn lied_e_sem_magnet_ficam_fora() {
        let mut sources = BTreeMap::new();
        sources.insert("aa".to_string(), vec![source("bludv", true)]);
        let mut lied = magnet("aa", "Mentiroso", true, true, 1, 5);
        lied.lied = true;
        let works = vec![work("aa", 1, 5, Some(lied)), work("bb", 1, 5, None)];
        let out = select_instant(&base(works, sources));
        assert!(out.items.is_empty());
    }

    #[test]
    fn rotulo_br_velho_desmentido_por_idioma_estrangeiro() {
        let mut sources = BTreeMap::new();
        sources.insert(
            "aa".to_string(),
            vec![InstantSource {
                indexer: "rutracker".to_string(),
                tracker: String::new(),
                last_seen: 10,
                allowed: true,
            }],
        );
        let works = vec![work(
            "aa",
            1,
            5,
            Some(magnet(
                "aa",
                "Coyote Ugly [2000, USA, Drama] Dub",
                true,
                true,
                1,
                5,
            )),
        )];
        let out = select_instant(&base(works, sources));
        assert!(!out.items[0].is_br, "DUB russo sem sinal PT não é BR");
    }

    #[test]
    fn legenda_pt_mantem_origem_br() {
        let mut sources = BTreeMap::new();
        sources.insert("aa".to_string(), vec![source("bludv", true)]);
        let works = vec![work(
            "aa",
            1,
            5,
            Some(magnet("aa", "Filme [1080p LEGENDADO]", true, false, 1, 5)),
        )];
        let out = select_instant(&base(works, sources));
        assert!(out.items[0].is_br);
    }
}
