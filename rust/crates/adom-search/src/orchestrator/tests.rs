#[path = "test_support.rs"]
pub mod test_support;

#[path = "tests_pipeline.rs"]
mod tests_pipeline;

#[path = "tests_routes_sources.rs"]
mod tests_routes_sources;

#[path = "tests/live_state_wiring.rs"]
mod live_state_wiring;

#[path = "tests_fallback_wiring.rs"]
mod fallback_wiring;

#[path = "tests_fallback_support.rs"]
mod fallback_support;

#[path = "tests/account_task.rs"]
mod account_task;

#[path = "tests_fallback_tail.rs"]
mod fallback_wiring_tail;
