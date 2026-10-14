//! Wrapper fino de `pick_file`. A lista já veio do Node; isto não chama rede.

use napi_derive::napi;

#[napi(object)]
pub struct DebridFileIn {
    pub path: Option<String>,
    pub size: Option<f64>,
}

#[napi(object)]
pub struct DebridWorkHintIn {
    pub names: Option<Vec<String>>,
    pub year: Option<f64>,
    pub pack: Option<bool>,
}

#[napi(object)]
pub struct DebridPlayHintIn {
    pub season: Option<f64>,
    pub episode: Option<f64>,
    pub work: Option<DebridWorkHintIn>,
}

#[napi(object)]
pub struct DebridPickEvidence {
    pub wanted_season: i64,
    pub wanted_episode: i64,
    pub declared_seasons: Vec<i64>,
    pub declared_episodes: Vec<i64>,
    pub sample: Option<String>,
}

#[napi(object)]
pub struct DebridPickContext {
    pub video_count: i64,
    pub samples: Vec<String>,
}

/// `{ kind: 'file'|'null'|'error', ... }`. Evidência só quando o TS a preenche.
#[napi(object)]
pub struct DebridPickResult {
    pub kind: String,
    pub path: Option<String>,
    pub size: Option<f64>,
    pub code: Option<String>,
    pub evidence: Option<DebridPickEvidence>,
    pub context: Option<DebridPickContext>,
}

fn js_i64(value: f64) -> Option<i64> {
    if value.is_finite()
        && value.fract() == 0.0
        && (i64::MIN as f64..=i64::MAX as f64).contains(&value)
    {
        Some(value as i64)
    } else {
        None
    }
}

fn hint_of(hint: Option<DebridPlayHintIn>) -> adom_core::PlayHint {
    let Some(hint) = hint else {
        return adom_core::PlayHint::default();
    };
    let work = hint.work.map(|work| adom_core::WorkHint {
        names: work.names.unwrap_or_default(),
        year: work.year.and_then(js_i64),
        pack: work.pack.unwrap_or(false),
    });
    adom_core::PlayHint {
        season: hint.season.and_then(js_i64),
        episode: hint.episode.and_then(js_i64),
        work,
    }
}

/// Escolhe o arquivo de vídeo. Não lança: erro volta como `kind: 'error'`.
#[napi(catch_unwind)]
pub fn pick_file(files: Vec<DebridFileIn>, hint: Option<DebridPlayHintIn>) -> DebridPickResult {
    let files: Vec<adom_core::DebridFile> = files
        .into_iter()
        .map(|file| adom_core::DebridFile {
            path: file.path.unwrap_or_default(),
            size: file.size.unwrap_or(0.0),
        })
        .collect();
    match adom_core::pick_file(&files, &hint_of(hint)) {
        adom_core::PickOutcome::File { path, size } => DebridPickResult {
            kind: "file".into(),
            path: Some(path),
            size: Some(size),
            code: None,
            evidence: None,
            context: None,
        },
        adom_core::PickOutcome::Empty => DebridPickResult {
            kind: "null".into(),
            path: None,
            size: None,
            code: None,
            evidence: None,
            context: None,
        },
        adom_core::PickOutcome::Error {
            code,
            evidence,
            context,
        } => DebridPickResult {
            kind: "error".into(),
            path: None,
            size: None,
            code: Some(adom_core::pick_code_label(code).into()),
            evidence: evidence.map(|item| DebridPickEvidence {
                wanted_season: item.wanted_season,
                wanted_episode: item.wanted_episode,
                declared_seasons: item.declared_seasons,
                declared_episodes: item.declared_episodes,
                sample: item.sample,
            }),
            context: context.map(|item| DebridPickContext {
                video_count: item.video_count,
                samples: item.samples,
            }),
        },
    }
}
