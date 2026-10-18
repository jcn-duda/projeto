//! Testes do BUILD da lista — helpers comuns.

pub use crate::list_builder::*;
pub use crate::raw_item::RawItem;
pub use adom_core::StreamDisplayConfig;

pub fn base_ctx() -> BuildContext {
    BuildContext {
        names: vec!["Filme Teste".to_string()],
        year: "2024".into(),
        now_ms: 1_700_000_000_000,
        ..BuildContext::default()
    }
}

pub fn release(title: &str, hash: &str) -> RawItem {
    RawItem {
        title: Some(title.into()),
        info_hash: Some(hash.into()),
        seeders: Some(20.0),
        ..RawItem::default()
    }
}

pub struct StubDebrid {
    pub cached: Vec<String>,
    pub known: bool,
    pub unusable: bool,
}

impl StubDebrid {
    pub fn none() -> Self {
        StubDebrid {
            cached: vec![],
            known: false,
            unusable: false,
        }
    }
    pub fn all() -> Self {
        StubDebrid {
            cached: vec!["*".into()],
            known: true,
            unusable: false,
        }
    }
}

impl DebridCheck for StubDebrid {
    fn check(&mut self, stream: &RankingStream) -> DebridAnswer {
        if self.unusable {
            return DebridAnswer::Unusable;
        }
        let hash = stream.info_hash.clone().unwrap_or_default();
        let hit = self.cached.iter().any(|c| c == "*" || *c == hash);
        if hit {
            DebridAnswer::Cached {
                url: Some(format!("/resolve/{hash}?sig=1")),
            }
        } else if self.known {
            DebridAnswer::Missing
        } else {
            DebridAnswer::Unknown
        }
    }
}

pub fn build(
    raw: Vec<RawItem>,
    ctx: &BuildContext,
    opts: &BuildOptions,
    debrid: &mut dyn DebridCheck,
) -> BuiltList {
    build_stream_list(&raw, ctx, opts, debrid, &StreamDisplayConfig::default())
}
