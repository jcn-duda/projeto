//! Seletor de arquivo do debrid (`src/debrid/file-selector.ts`).
//!
//! Só decisão: a lista de arquivos já chegou do Node. Sem IO, sem cache e sem
//! escrita na conta — duas chamadas de API por causa do shadow seriam o bug.
//! `known`/cache não entram aqui. `DubLie` existe como tipo porque o TS o
//! exporta; quem lança é o `audio-audit`, fora desta fase.

mod episode;
mod text;
mod work;

pub use text::{base_name, is_site_ad};
pub use work::{looks_multi_work_files, pick_work_file, work_coverage};

use episode::pick_episode;
use text::{is_sample, is_video, js_size};
use work::pick_by_work;

/// Arquivo dentro de um torrent, como cada serviço o reporta.
///
/// Só `path` e `size` atravessam a fronteira. Campos do serviço (`id`, `link`)
/// ficam no Node: o modo `on` devolve o objeto original da lista.
#[derive(Debug, Clone, PartialEq)]
pub struct DebridFile {
    pub path: String,
    pub size: f64,
}

/// Dica de obra (`w` na URL de play). `pack` liga o desempate por nome.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkHint {
    pub names: Vec<String>,
    pub year: Option<i64>,
    pub pack: bool,
}

/// Pedido do play. `dubbed` não muda a escolha do arquivo: é a promessa
/// que o auditor de áudio desmente depois, no unlock.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PlayHint {
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub work: Option<WorkHint>,
    pub dubbed: bool,
}

/// Códigos dos erros do seletor. `DubLie` não é produzido por `pick_file`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickCode {
    NoVideo,
    EpisodePick,
    WorkPick,
    DubLie,
}

/// Prova do `EpisodePickError` quando o arquivo declara outra temporada/episódio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeEvidence {
    pub wanted_season: i64,
    pub wanted_episode: i64,
    pub declared_seasons: Vec<i64>,
    pub declared_episodes: Vec<i64>,
    pub sample: Option<String>,
}

/// Contexto do pack ambíguo: quantos vídeos e até três nomes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeContext {
    pub video_count: i64,
    pub samples: Vec<String>,
}

/// Resultado estruturado. O Node compara isto no shadow; não é exceção opaca.
#[derive(Debug, Clone, PartialEq)]
pub enum PickOutcome {
    File {
        path: String,
        size: f64,
    },
    Empty,
    Error {
        code: PickCode,
        evidence: Option<EpisodeEvidence>,
        context: Option<EpisodeContext>,
    },
}

/// Rótulo estável do código, o mesmo `code` do `Error` no TS.
pub fn pick_code_label(code: PickCode) -> &'static str {
    match code {
        PickCode::NoVideo => "NO_VIDEO",
        PickCode::EpisodePick => "EPISODE_PICK",
        PickCode::WorkPick => "WORK_PICK",
        PickCode::DubLie => "DUB_LIE",
    }
}

pub(super) fn outcome_file(file: &DebridFile) -> PickOutcome {
    PickOutcome::File {
        path: file.path.clone(),
        size: js_size(file.size),
    }
}

pub(super) fn outcome_no_video() -> PickOutcome {
    PickOutcome::Error {
        code: PickCode::NoVideo,
        evidence: None,
        context: None,
    }
}

pub(super) fn outcome_work() -> PickOutcome {
    PickOutcome::Error {
        code: PickCode::WorkPick,
        evidence: None,
        context: None,
    }
}

pub(super) fn outcome_episode(
    evidence: Option<EpisodeEvidence>,
    context: Option<EpisodeContext>,
) -> PickOutcome {
    PickOutcome::Error {
        code: PickCode::EpisodePick,
        evidence,
        context,
    }
}

/// Escolhe o arquivo de vídeo. Lista vazia → `Empty` (transferência fria).
/// Lista sem vídeo → `NoVideo`. Vários vídeos sem casar o episódio → `EpisodePick`.
pub fn pick_file(files: &[DebridFile], hint: &PlayHint) -> PickOutcome {
    let mut videos: Vec<&DebridFile> = files
        .iter()
        .filter(|file| is_video(&file.path) && !is_sample(&file.path))
        .collect();
    if videos.is_empty() {
        // Com arquivos e nenhum vídeo a prova é determinística. Lista vazia não.
        if files.is_empty() {
            return PickOutcome::Empty;
        }
        return outcome_no_video();
    }
    // Propaganda só sai se sobrar vídeo real. Torrent que é SÓ o anúncio
    // continua vídeo: condená-lo aqui gravaria `bad` por 24h.
    let sem_ad: Vec<&DebridFile> = videos
        .iter()
        .copied()
        .filter(|file| !is_site_ad(&file.path))
        .collect();
    if !sem_ad.is_empty() && sem_ad.len() < videos.len() {
        videos = sem_ad;
    }
    if let (Some(season), Some(episode)) = (hint.season, hint.episode) {
        if let Some(decided) = pick_episode(&videos, season, episode) {
            return decided;
        }
    }
    if let Some(work) = &hint.work {
        if !work.names.is_empty() {
            return pick_by_work(&videos, work);
        }
    }
    outcome_file(largest(&videos))
}

pub(super) fn largest<'a>(files: &[&'a DebridFile]) -> &'a DebridFile {
    // Empate fica com o primeiro: `>` estrito, a ordem do torrent não promove.
    files
        .iter()
        .copied()
        .reduce(|best, next| {
            if js_size(next.size) > js_size(best.size) {
                next
            } else {
                best
            }
        })
        .expect("maior de uma lista vazia")
}
