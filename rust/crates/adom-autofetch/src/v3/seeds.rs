//! Decisão pura do stop gate e da reposição seeds.

use adom_core::{decide_seeds_stop, DecideSeedsStopInput, DecideSeedsStopOutput};

pub fn seeds_stop(input: &DecideSeedsStopInput) -> DecideSeedsStopOutput {
    decide_seeds_stop(input)
}

#[cfg(test)]
#[path = "seeds_tests.rs"]
mod tests;
