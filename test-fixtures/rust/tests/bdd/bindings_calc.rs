//! Example rstest-bdd scenario bindings (authored fixture, not compiled).

mod steps_calc;

use rstest_bdd_macros::scenario;

#[scenario(path = "features/calculator_zh.feature", name = "加法")]
fn test_addition() {}

#[scenario(
    path = "features/calculator_en.feature",
    name = "typed addition"
)]
fn test_typed_addition() {}
