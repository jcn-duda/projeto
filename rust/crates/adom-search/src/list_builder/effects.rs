//! SELEÇÃO dos efeitos de CAUDA que o `applyDebrid` do Node decide depois da
//! checagem (`debrid-pipeline-core.ts:213-243,379-382`).
//!
//! Aqui só entram as DUAS decisões que dependem do lote pós-debrid e que não
//! precisam de conta/inventário/cache do processo Node:
//!
//! - **interrogatório de áudio** (`dub_audit`): os ⚡ dublados confirmados
//!   nesta busca (prova/promessa) mais, em série, o que NÃO nomeia o episódio
//!   pedido — o pack pode conter outra coisa;
//! - **warmer do RD** (`rd_warmer`): os três tiers do `applyDebrid` (BR
//!   dublado, dublado global, melhor swarm), cada um com teto de 10 hashes.
//!
//! A decisão é PURA: recebe o lote já materializado (pós-`playDisposition`,
//! PRÉ-`limitReservingBr`, como o `applyDebrid`) e o conjunto de hashes
//! cacheados da checagem. Quem enfileira/gateia é o Node (o marker do Chupim, a
//! blacklist de mentiras, o dedupe da fila do colhedor, etc.) — por isso o
//! payload só carrega HASHES e os fatos mínimos, nunca credencial.
//!
//! O que NÃO mora aqui de propósito: `autofetch` (depende da seleção com teto
//! por obra, holds, fila persistente e portões de marker/budget — estado do
//! processo Node) e `br_probe`/colhedor da via do índice (dependem do
//! `releaseIndex.lookup` e do banco de magnets). Ver
//! `docs/rust-effects-contract.md`.

use std::collections::HashSet;

use adom_core::{
    parse_title_season_episode, pick_any_dubbed_candidates, pick_br_dubbed_candidates,
    pick_top_seeded_candidates, PoolOptions, PoolStream, RankingStream,
};

use super::helpers::ranking_to_pool;

/// Teto por tier do warmer (`const topN = 10` do `applyDebrid`).
const WARMER_TOP_N: i64 = 10;
/// Piso do tier de swarm (`{ minSeeders: 1 }` no TS).
const WARMER_MIN_SEEDERS: i64 = 1;

/// Candidato do interrogatório de áudio. `pack` é a marca multiobra do stream
/// (o Node monta `work.pack` a partir dela).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditSeed {
    pub hash: String,
    pub dubbed: bool,
    /// Claim sem prova: o OK do resolve precisa promover a lista (`_dubbed`).
    pub needs_promote: bool,
    pub pack: bool,
}

/// Release que o Node pontua e enfileira no warmer do RD.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WarmerSeed {
    pub hash: String,
    pub title: String,
    pub is_br: bool,
    pub dubbed: bool,
}

/// Saída da seleção; cada campo vira UM efeito no fio (vazio = sem efeito).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EffectSeeds {
    pub audit: Vec<AuditSeed>,
    pub warmer: Vec<WarmerSeed>,
}

fn flag(stream: &RankingStream, canonical: &str, legacy: &str) -> bool {
    stream
        .extra
        .get(canonical)
        .or_else(|| stream.extra.get(legacy))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

/// `_fromFallback` (a foto do índice NÃO conta como reserva aqui: o TS só
/// exclui `_fromFallback`).
fn from_fallback(stream: &RankingStream) -> bool {
    flag(stream, "_fromFallback", "fromFallback")
}

fn hash_of(stream: &RankingStream) -> Option<&str> {
    stream.info_hash.as_deref().filter(|hash| !hash.is_empty())
}

fn lower_hash(stream: &RankingStream) -> Option<String> {
    hash_of(stream).map(str::to_lowercase)
}

/// `nomeiaEpisodio` (`dub-audit.ts:215`): o título NOMEIA este episódio? O
/// pack de temporada casa o episódio no `matchesEpisode` de propósito, mas não
/// o nomeia — e é essa diferença que autoriza o interrogatório.
pub fn nomeia_episodio(title: &str, season: i64, episode: i64) -> bool {
    let parsed = parse_title_season_episode(title);
    parsed.episodes.contains(&episode)
        && (parsed.seasons.is_empty() || parsed.seasons.contains(&season))
}

/// `collectAuditCandidates` (`dub-audit.ts:42-86`).
fn audit_seeds(
    streams: &[RankingStream],
    cached: &HashSet<String>,
    season: Option<i64>,
    episode: Option<i64>,
) -> Vec<AuditSeed> {
    let mut out: Vec<AuditSeed> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let is_cached_hash = |hash: &str| cached.iter().any(|h| h.eq_ignore_ascii_case(hash));

    // Grupo 1 — promessa/prova de dublado em cache.
    for stream in streams {
        if from_fallback(stream) {
            continue;
        }
        let Some(hash) = hash_of(stream) else {
            continue;
        };
        let dubbed = stream.dubbed.unwrap_or(false);
        let claim = stream.dub_claim.unwrap_or(false);
        if !(dubbed || claim) || !is_cached_hash(hash) {
            continue;
        }
        if !seen.insert(hash.to_lowercase()) {
            continue;
        }
        out.push(AuditSeed {
            hash: hash.to_string(),
            dubbed: true,
            needs_promote: claim && !dubbed,
            pack: stream.multi_work.unwrap_or(false),
        });
    }

    // Grupo 2 (só série) — em cache e sem nomear o episódio pedido.
    let (Some(season), Some(episode)) = (season, episode) else {
        return out;
    };
    for stream in streams {
        if from_fallback(stream) {
            continue;
        }
        let Some(hash) = hash_of(stream) else {
            continue;
        };
        // A variante dublada já interroga este hash: a prova vale para os dois.
        if !is_cached_hash(hash) || !seen.insert(hash.to_lowercase()) {
            continue;
        }
        let title = stream
            .title
            .as_deref()
            .or(stream.name.as_deref())
            .unwrap_or("");
        if nomeia_episodio(title, season, episode) {
            continue;
        }
        out.push(AuditSeed {
            hash: hash.to_string(),
            dubbed: false,
            needs_promote: false,
            pack: stream.multi_work.unwrap_or(false),
        });
    }
    out
}

fn seed_of(stream: &RankingStream) -> Option<WarmerSeed> {
    Some(WarmerSeed {
        hash: lower_hash(stream)?,
        title: stream
            .title
            .as_deref()
            .or(stream.name.as_deref())
            .unwrap_or("")
            .to_string(),
        is_br: stream.br.unwrap_or(false),
        dubbed: stream.dubbed.unwrap_or(false),
    })
}

/// Os três tiers do `applyDebrid` (`debrid-pipeline-core.ts:227-242`) sobre a
/// lista `warmable` (`!multiWorkAdmitted && !fromFallback`), na ordem do Node.
fn warmer_seeds(
    streams: &[RankingStream],
    cached: &HashSet<String>,
    season: Option<i64>,
) -> Vec<WarmerSeed> {
    // Índices no lote ORIGINAL: os picks devolvem índices do subconjunto.
    let warmable: Vec<usize> = streams
        .iter()
        .enumerate()
        .filter(|(_, stream)| {
            !stream.multi_work_admitted.unwrap_or(false) && !from_fallback(stream)
        })
        .map(|(index, _)| index)
        .collect();
    let pool: Vec<PoolStream> = warmable
        .iter()
        .map(|&i| ranking_to_pool(&streams[i]))
        .collect();
    let opts = PoolOptions {
        season,
        min_seeders: WARMER_MIN_SEEDERS,
        pt_first: true,
    };
    let mut out: Vec<WarmerSeed> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let tiers = [
        pick_br_dubbed_candidates(&pool, cached, WARMER_TOP_N, &opts),
        pick_any_dubbed_candidates(&pool, cached, WARMER_TOP_N, &opts),
        pick_top_seeded_candidates(&pool, cached, WARMER_TOP_N, &opts),
    ];
    for tier in tiers {
        for local in tier {
            let Some(seed) = seed_of(&streams[warmable[local]]) else {
                continue;
            };
            if seen.insert(seed.hash.clone()) {
                out.push(seed);
            }
        }
    }
    out
}

/// Seleção dos efeitos do lote pós-debrid. `cached` é o conjunto da checagem
/// (hashes crus; a comparação é caso-insensível, como o `hashSet` do Node).
pub fn collect(
    streams: &[RankingStream],
    cached: &HashSet<String>,
    season: Option<i64>,
    episode: Option<i64>,
) -> EffectSeeds {
    EffectSeeds {
        audit: audit_seeds(streams, cached, season, episode),
        warmer: warmer_seeds(streams, cached, season),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stream(hash: &str, title: &str) -> RankingStream {
        RankingStream {
            info_hash: Some(hash.into()),
            title: Some(title.into()),
            name: Some(title.into()),
            ..RankingStream::default()
        }
    }

    fn cached(hashes: &[&str]) -> HashSet<String> {
        hashes.iter().map(|h| h.to_string()).collect()
    }

    #[test]
    fn audita_so_o_dublado_em_cache_fora_da_reserva() {
        let mut br = stream("aaa", "Filme 2024 1080p DUBLADO");
        br.dubbed = Some(true);
        let mut reserva = stream("bbb", "Filme 2024 1080p DUBLADO");
        reserva.dubbed = Some(true);
        reserva.extra.insert("_fromFallback".into(), json!(true));
        let mut frio = stream("ccc", "Filme 2024 1080p DUBLADO");
        frio.dubbed = Some(true);
        let streams = vec![br, reserva, frio];
        let seeds = collect(&streams, &cached(&["aaa", "bbb"]), None, None);
        assert_eq!(seeds.audit.len(), 1);
        assert_eq!(seeds.audit[0].hash, "aaa");
        assert!(seeds.audit[0].dubbed);
        assert!(!seeds.audit[0].needs_promote);
    }

    #[test]
    fn claim_sem_prova_pede_promocao() {
        let mut claim = stream("aaa", "Filme 2024 1080p");
        claim.dub_claim = Some(true);
        let seeds = collect(&[claim], &cached(&["aaa"]), None, None);
        assert_eq!(seeds.audit.len(), 1);
        assert!(seeds.audit[0].needs_promote);
    }

    #[test]
    fn serie_interroga_pack_que_nao_nomeia_o_episodio() {
        let mut pack = stream("ddd", "Serie S01 COMPLETE 1080p");
        pack.br = Some(true);
        // Nomeia o EPISÓDIO PEDIDO (E01): a prova dele não é assunto do tail.
        let mut episodio = stream("eee", "Serie S01E01 1080p");
        episodio.br = Some(true);
        let seeds = collect(
            &[pack, episodio],
            &cached(&["ddd", "eee"]),
            Some(1),
            Some(1),
        );
        // O pack não nomeia o E01 → entra; o E02 nomeia → fica fora.
        assert_eq!(seeds.audit.len(), 1);
        assert_eq!(seeds.audit[0].hash, "ddd");
        assert!(!seeds.audit[0].dubbed);
    }

    #[test]
    fn filme_nao_entra_no_grupo_de_episodio() {
        let frio = stream("fff", "Filme 2024 1080p");
        let seeds = collect(&[frio], &cached(&["fff"]), None, None);
        assert!(seeds.audit.is_empty());
    }

    #[test]
    fn warmer_pega_os_tres_tiers_e_corta_reserva_e_multiobra() {
        let mut br = stream("aaa", "Filme 2024 1080p DUBLADO");
        br.br = Some(true);
        br.dubbed = Some(true);
        br.seeders = Some(50.0);
        br.quality = Some("1080p".into());
        let mut global = stream("bbb", "Movie 2024 1080p DUBLADO");
        global.dubbed = Some(true);
        global.seeders = Some(5.0);
        let mut swarm = stream("ccc", "Movie 2024 720p");
        swarm.seeders = Some(900.0);
        swarm.quality = Some("720p".into());
        let mut reserva = stream("ddd", "Filme 2024 1080p DUBLADO");
        reserva.dubbed = Some(true);
        reserva.extra.insert("_fromFallback".into(), json!(true));
        let mut multi = stream("eee", "Colecao 1080p DUBLADO");
        multi.dubbed = Some(true);
        multi.multi_work_admitted = Some(true);

        let seeds = collect(
            &[br, global, swarm, reserva, multi],
            &cached(&[]),
            None,
            None,
        );
        let hashes: Vec<&str> = seeds.warmer.iter().map(|s| s.hash.as_str()).collect();
        assert_eq!(hashes, vec!["aaa", "bbb", "ccc"]);
        assert!(seeds.warmer[0].is_br && seeds.warmer[0].dubbed);
        assert!(!seeds.warmer[2].dubbed);
    }

    #[test]
    fn warmer_nao_repete_hash_entre_tiers() {
        let mut br = stream("aaa", "Filme 2024 1080p DUBLADO");
        br.br = Some(true);
        br.dubbed = Some(true);
        br.seeders = Some(9.0);
        br.quality = Some("1080p".into());
        let seeds = collect(&[br], &cached(&[]), None, None);
        // O mesmo hash apareceria nos 3 tiers; o payload carrega UMA vez.
        assert_eq!(seeds.warmer.len(), 1);
        assert_eq!(seeds.warmer[0].hash, "aaa");
    }
}
