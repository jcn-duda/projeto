//! Porte puro da SELEÇÃO DE POOL do autofetch BR — `brDubbedPool`,
//! `anyDubbedPool`, `topSeededPool` (`src/utils/autofetch-pools.ts`) e
//! `pickBrDubbedByTargetQualities` (`src/utils/autofetch-picks.ts`, no submódulo
//! [`target`]).
//!
//! Todas são funções de ENTRADA→SAÍDA: recebem a lista de streams e as opções,
//! devolvem os índices do pool já ordenado. Não leem config, runtime, debrid,
//! banco nem rede — a fronteira impura (o `Stream` real, cache, kill-switch)
//! fica no chamador. Por isso elas entram na classe Rust sem arrastar o grafo
//! do addon.
//!
//! Os módulos de apoio já portados são reusados, nunca reimplementados:
//! `source_from_title` (`release_labels`), `has_explicit_foreign_audio`
//! (`pt_audio_guards`), `looks_pt_br` (`audio_presentation`), `has_pt_signs`
//! (`br_origin`), `is_season_pack_release` (`episode_matching`) e
//! `quality_from_title` (`stream_quotas_extra`).
//!
//! # Ordem e estabilidade
//!
//! O TS usa `[...candidates].sort(...)` (cópia, ES2019 estável). Aqui a ordem é
//! calculada por `sort_by` (também estável) sobre um vetor de índices: empate
//! preserva a ordem de entrada, e a fatia de entrada nunca é mutada. O
//! comparador devolve a DIFERENÇA assinada (nunca `-1/0/1`), como no TS.
//!
//! # Tipo de entrada
//!
//! `PoolStream` carrega só os campos que as funções leem. `info_hash` é
//! `Option<String>`: `None`/vazio são o "falsy" do JS (`s.infoHash`). `seeders`
//! é `Option<i64>` com DOIS leitores no TS: `br`/`any` usam o número puro
//! (`_seeders || 0`, sem ler o `name`) e só o `top` cai no `👤 <n>` do `name`
//! (`seedersOf`, o `?? ` do JS). `Some(0)` é 0; seeders/limite são inteiros —
//! fracionários ou strings numéricas estão fora da classe coberta pelo golden.

use std::cmp::Ordering;
use std::sync::OnceLock;

use regex::Regex;

use crate::audio_presentation::looks_pt_br;
use crate::br_origin::has_pt_signs;
use crate::episode_matching::is_season_pack_release;
use crate::matching_vocabulary::JS_SPACE;
use crate::pt_audio_guards::has_explicit_foreign_audio;
use crate::release_labels::source_from_title;
use crate::stream_quotas_extra::{quality_from_title, UNKNOWN_QUALITY};

mod target;
pub use target::pick_br_dubbed_by_target_qualities;

/// Faixas que o Chupim cobre com 1 download cada (mesmo balde canônico).
pub const AUTOFETCH_TARGET_QUALITIES: [&str; 3] = ["1080p", "720p", "2160p"];

/// `isAutofetchTargetQuality`: 4K e 2160p são o MESMO balde; unknown/SD/480p
/// ficam de fora.
pub fn is_autofetch_target_quality(q: &str) -> bool {
    AUTOFETCH_TARGET_QUALITIES.contains(&q)
}

/// Peso de resolução dos pools (1080p/720p vencem 2160p: o download esquenta o
/// cache para o play rápido, não baixa o maior arquivo). `UNKNOWN_QUALITY` pesa
/// 3; resolução desconhecida fora do vocabulário pesa 0 (como `|| 0` do TS).
fn quality_weight(q: &str) -> i64 {
    if q == "1080p" {
        6
    } else if q == "720p" {
        5
    } else if q == "2160p" {
        4
    } else if q == UNKNOWN_QUALITY {
        3
    } else if q == "480p" {
        2
    } else if q == "SD" {
        1
    } else {
        0
    }
}

/// Stream visto por estas funções puras (o `Stream` do addon é maior).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PoolStream {
    pub info_hash: Option<String>,
    pub title: Option<String>,
    pub name: Option<String>,
    /// `_quality` — resolução já resolvida; vazio/`None` cai no título.
    pub quality: Option<String>,
    /// `_seeders` — número puro em `br`/`any` (`None`→0, o `|| 0`); só o `top`
    /// cai no `👤` do `name` quando `None`.
    pub seeders: Option<i64>,
    pub is_br: bool,
    pub is_dubbed: bool,
    pub is_dub_claim: bool,
    pub is_bank_dub: bool,
    pub is_lied: bool,
    pub from_fallback: bool,
    pub fallback_fetchable: bool,
}

impl PoolStream {
    /// `stream.title || stream.name || ''`: título vazio cai no name.
    fn title_text(&self) -> &str {
        match self.title.as_deref() {
            Some(t) if !t.is_empty() => t,
            _ => self.name.as_deref().unwrap_or(""),
        }
    }

    /// `Boolean(s.infoHash)` com string vazia contando como ausente.
    fn has_hash(&self) -> bool {
        self.info_hash.as_deref().is_some_and(|h| !h.is_empty())
    }

    /// `String(stream.infoHash).toLowerCase()` — chave de dedupe/cache.
    fn hash_key(&self) -> String {
        self.info_hash.as_deref().unwrap_or("").to_lowercase()
    }

    /// `streamQuality`: `_quality` não-vazio, senão `qualityFromTitle(título)`.
    fn quality_text(&self) -> String {
        match self.quality.as_deref() {
            Some(q) if !q.is_empty() => q.to_string(),
            _ => quality_from_title(self.title_text()).to_string(),
        }
    }

    /// `_seeders || 0` (`br`/`any`): o número puro, SEM o `👤` do `name`.
    /// `None` vira 0 como o `|| 0` do JS.
    fn seeders_value(&self) -> i64 {
        self.seeders.unwrap_or(0)
    }

    /// `seedersOf` (SÓ `top`): `_seeders` quando presente, senão `👤 <n>` do `name`.
    fn seeders_number(&self) -> i64 {
        if let Some(v) = self.seeders {
            return v;
        }
        seeders_from_name(self.name.as_deref().unwrap_or(""))
    }
}

/// Opções dos pools. `season` ausente = busca de filme.
#[derive(Debug, Clone)]
pub struct PoolOptions {
    pub season: Option<i64>,
    pub min_seeders: i64,
    pub pt_first: bool,
}

impl Default for PoolOptions {
    fn default() -> Self {
        Self {
            season: None,
            min_seeders: 0,
            pt_first: true,
        }
    }
}

/// `/👤\s*(\d+)/` sobre o `name` (o `\s`/`\d` do JS).
fn seeders_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(r"👤{s}*([0-9]+)", s = JS_SPACE)).expect("regex de seeders compila")
    })
}

fn seeders_from_name(name: &str) -> i64 {
    seeders_re()
        .captures(name)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<i64>().ok())
        .unwrap_or(0)
}

/// `fallbackBlocked(s)`: reserva do banco nunca aprovada (indexer falho). Ela
/// fica fora de candidato E de cobertura cached.
pub fn fallback_blocked(s: &PoolStream) -> bool {
    s.from_fallback && !s.fallback_fetchable
}

/// Converte a diferença assinada do comparador JS num `Ordering` estável.
fn ord(diff: i64) -> Ordering {
    diff.cmp(&0)
}

/// Bônus de pack da temporada pedida, um por candidato (o `packOf` do TS).
fn pack_flags(
    streams: &[PoolStream],
    candidates: &[usize],
    season: Option<i64>,
) -> Option<Vec<bool>> {
    season.map(|season| {
        candidates
            .iter()
            .map(|&i| is_season_pack_release(streams[i].title_text(), Some(season)))
            .collect()
    })
}

/// `brDubbedPool`: pool BR dublado, ordenado por marca de áudio → pack →
/// resolução → seeders. `_br` + prova (`_dubbed`) OU promessa (`_dubClaim`) OU
/// banco (`_bankDub`), nunca `_lied`, nunca CAM.
pub fn br_dubbed_pool(streams: &[PoolStream], opts: &PoolOptions) -> Vec<usize> {
    let br: Vec<usize> = streams
        .iter()
        .enumerate()
        .filter(|(_, s)| {
            s.has_hash()
                && !fallback_blocked(s)
                && s.is_br
                && source_from_title(s.title_text()) != "CAM"
        })
        .map(|(i, _)| i)
        .collect();
    if br.is_empty() {
        return Vec::new();
    }
    let candidates: Vec<usize> = br
        .into_iter()
        .filter(|&i| {
            let s = &streams[i];
            (s.is_dubbed || s.is_dub_claim || s.is_bank_dub) && !s.is_lied
        })
        .collect();
    let pack = pack_flags(streams, &candidates, opts.season);
    let mut order: Vec<usize> = (0..candidates.len()).collect();
    order.sort_by(|&x, &y| {
        let a = &streams[candidates[x]];
        let b = &streams[candidates[y]];
        let dub = i64::from(b.is_dubbed) - i64::from(a.is_dubbed);
        if dub != 0 {
            return ord(dub);
        }
        if let Some(pack) = &pack {
            let pd = i64::from(pack[y]) - i64::from(pack[x]);
            if pd != 0 {
                return ord(pd);
            }
        }
        let qd = quality_weight(&b.quality_text()) - quality_weight(&a.quality_text());
        if qd != 0 {
            return ord(qd);
        }
        ord(b.seeders_value() - a.seeders_value())
    });
    order.into_iter().map(|k| candidates[k]).collect()
}

/// `anyDubbedPool`: fallback global dublado. Exige `_dubbed` (prova de arquivo)
/// — claim sem evidência não entra. `_br` é indiferente e `_lied` NÃO corta.
pub fn any_dubbed_pool(streams: &[PoolStream], opts: &PoolOptions) -> Vec<usize> {
    let candidates: Vec<usize> = streams
        .iter()
        .enumerate()
        .filter(|(_, s)| {
            s.has_hash()
                && !fallback_blocked(s)
                && s.is_dubbed
                && source_from_title(s.title_text()) != "CAM"
        })
        .map(|(i, _)| i)
        .collect();
    let pack = pack_flags(streams, &candidates, opts.season);
    let mut order: Vec<usize> = (0..candidates.len()).collect();
    order.sort_by(|&x, &y| {
        let a = &streams[candidates[x]];
        let b = &streams[candidates[y]];
        if let Some(pack) = &pack {
            let pd = i64::from(pack[y]) - i64::from(pack[x]);
            if pd != 0 {
                return ord(pd);
            }
        }
        let qd = quality_weight(&b.quality_text()) - quality_weight(&a.quality_text());
        if qd != 0 {
            return ord(qd);
        }
        ord(b.seeders_value() - a.seeders_value())
    });
    order.into_iter().map(|k| candidates[k]).collect()
}

/// `topSeededPool`: rede de segurança que prioriza o SWARM (não a resolução)
/// para o download terminar. Exclui áudio estrangeiro explícito; com `ptFirst`
/// o candidato com sinal de português baixa antes do mais semeado.
pub fn top_seeded_pool(streams: &[PoolStream], opts: &PoolOptions) -> Vec<usize> {
    let candidates: Vec<usize> = streams
        .iter()
        .enumerate()
        .filter(|(_, s)| {
            s.has_hash()
                && !fallback_blocked(s)
                && source_from_title(s.title_text()) != "CAM"
                && s.seeders_number() >= opts.min_seeders
                && !has_explicit_foreign_audio(s.title_text())
        })
        .map(|(i, _)| i)
        .collect();
    let pack = pack_flags(streams, &candidates, opts.season);
    let pt: Option<Vec<bool>> = if opts.pt_first {
        Some(
            candidates
                .iter()
                .map(|&i| {
                    let t = streams[i].title_text();
                    looks_pt_br(t) || has_pt_signs(t)
                })
                .collect(),
        )
    } else {
        None
    };
    let mut order: Vec<usize> = (0..candidates.len()).collect();
    order.sort_by(|&x, &y| {
        let a = &streams[candidates[x]];
        let b = &streams[candidates[y]];
        if let Some(pack) = &pack {
            let pd = i64::from(pack[y]) - i64::from(pack[x]);
            if pd != 0 {
                return ord(pd);
            }
        }
        if let Some(pt) = &pt {
            let pd = i64::from(pt[y]) - i64::from(pt[x]);
            if pd != 0 {
                return ord(pd);
            }
        }
        let sd = b.seeders_number() - a.seeders_number();
        if sd != 0 {
            return ord(sd);
        }
        ord(quality_weight(&b.quality_text()) - quality_weight(&a.quality_text()))
    });
    order.into_iter().map(|k| candidates[k]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `_seeders` ausente NÃO cai no `👤 <n>` do `name` em `br`/`any`: vale o
    /// `|| 0`, então quem declarou 5 vence quem só traz `👤 99` no nome (o
    /// contraexemplo do revisor). O `top` continua lendo o nome.
    #[test]
    fn br_e_any_ignoram_seeders_do_name() {
        let streams = vec![
            PoolStream {
                info_hash: Some("hash-a".into()),
                name: Some("Release A 👤 99".into()),
                quality: Some("1080p".into()),
                is_br: true,
                is_dubbed: true,
                ..Default::default()
            },
            PoolStream {
                info_hash: Some("hash-b".into()),
                seeders: Some(5),
                quality: Some("1080p".into()),
                is_br: true,
                is_dubbed: true,
                ..Default::default()
            },
        ];
        let opts = PoolOptions::default();
        assert_eq!(br_dubbed_pool(&streams, &opts), vec![1, 0]);
        assert_eq!(any_dubbed_pool(&streams, &opts), vec![1, 0]);
        // O `top` (seedersOf) CONTINUA priorizando o `👤` do nome.
        assert_eq!(top_seeded_pool(&streams, &opts), vec![0, 1]);
    }

    /// `Some(0)` é 0 (não cai no `👤 42` do nome): o `top` com `min_seeders=1`
    /// corta o candidato e o `br` o mantém com seeders 0.
    #[test]
    fn seeders_zero_nao_cai_no_name() {
        let streams = vec![PoolStream {
            info_hash: Some("hash-a".into()),
            name: Some("Release A 👤 42".into()),
            quality: Some("1080p".into()),
            seeders: Some(0),
            is_br: true,
            is_dubbed: true,
            ..Default::default()
        }];
        let min1 = PoolOptions {
            min_seeders: 1,
            ..PoolOptions::default()
        };
        assert!(top_seeded_pool(&streams, &min1).is_empty());
        assert_eq!(br_dubbed_pool(&streams, &PoolOptions::default()), vec![0]);
    }
}
