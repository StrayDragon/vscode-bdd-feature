"""Example pytest-bdd step definitions (authored for this repo's fixtures).

Covers all matcher kinds and the multi-line decorator edge case that used to
break jump positioning.
"""

from pytest_bdd import given, parsers, then, when


@given(parsers.parse('用户 "{name}" 已经注册'))
def registered_user(db, name):
    db.create_user(name)


@when("她使用正确密码登录")
def login_with_correct_password(page):
    page.login()


@then("登录成功并且看到欢迎页")
def sees_welcome(page):
    assert page.welcome_visible()


# Multi-line decorator — paren inside a string must not confuse scanning.
@given(
    parsers.parse("订单 {action} 已提交"),
)
def order_submitted(db, action):
    db.create_order(action)


@when(parsers.parse("{role} 审核通过 该订单"))
def approve_order(role, db):
    db.approve(by=role)


@then(parsers.parse("订单状态变为 {status}"))
def order_status(status, db):
    assert db.status() == status


# Regex matcher with a Python named group.
@given(parsers.re(r"会员等级为 (?P<level>\w+)"))
def member_level(level, db):
    db.set_level(level)


# Exact string steps (no parser wrapper).
@given("an approved merchant")
def approved_merchant(db):
    pass


@given(parsers.parse("user {uid:d} has {count:d} pending orders"))
def pending_orders(uid, count, db):
    pass


@when(parsers.parse("the user cancels order {oid:d}"))
def cancel_order(oid, db):
    pass


@then(parsers.re(r"the pending count is (?P<n>\d+)"))
def pending_count(n, db):
    pass
