/// Motivo de rejeição, na mesma grafia do TS (`RelevanceRejectReason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelevanceRejectReason {
    Title,
    MagnetYear,
    NamedSequel,
    Identity,
    Episode,
    SeriesWork,
    MovieIsSeries,
    SeriesIsMovie,
    PreHomeRelease,
    NonFeature,
    /// Só existe no Rust: o TS do `esm` não tem esse corte.
    ForeignMagnet,
}

impl RelevanceRejectReason {
    /// Rótulo idêntico ao literal do TS (`'magnet-year'`, `'series-is-movie'`…).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Title => "title",
            Self::MagnetYear => "magnet-year",
            Self::NamedSequel => "named-sequel",
            Self::Identity => "identity",
            Self::Episode => "episode",
            Self::SeriesWork => "series-work",
            Self::MovieIsSeries => "movie-is-series",
            Self::SeriesIsMovie => "series-is-movie",
            Self::PreHomeRelease => "pre-home-release",
            Self::NonFeature => "non-feature",
            Self::ForeignMagnet => "foreign-magnet",
        }
    }
}
