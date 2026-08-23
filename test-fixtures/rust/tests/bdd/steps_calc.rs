//! Example rstest-bdd step definitions (authored fixture, not compiled).

use rstest_bdd_macros::{given, then, when};

#[given("计算器已清零")]
#[allow(dead_code)]
fn given_cleared() {
}

#[when("我输入 {value:u32}")]
fn enter_value(value: u32) {
    let _ = value;
}

#[given("配置了 mock 模型 {name:string}")]
pub(crate) fn mock_model(name: String) {
    let _ = name;
}

// Multi-line attribute + raw string edge cases.
#[then(
    r#"显示结果为 {expected:u32}"#
)]
fn display_shows(expected: u32) {
    let _ = expected;
}

#[when(r#"操作 "{op}" 执行"#)]
fn run_operation(op: String) {
    let _ = op;
}

#[when("我再输入 {value:u32}")]
fn enter_more(value: u32) {
    let _ = value;
}

#[then("操作成功")]
fn op_succeeds() {
}
