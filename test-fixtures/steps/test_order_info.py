from pytest_bdd import given, when, then, scenarios

scenarios("../sample-zh.feature")


@given("用户 {user_id} 订单 {order_type} header 专业为 {major}")
def step_given_user_order(user_id, order_type, major):
    pass


@when("运营 POST order_info 清空 major 为 null")
def step_when_post_order_info():
    pass


@then("订单 {order_type} header 专业为 NULL")
def step_then_order_major_null(order_type):
    pass


@given("用户已登录系统", target_fixture="user_context")
def step_given_user_logged_in():
    return {"logged_in": True}


@when("用户查看个人中心")
def step_when_view_profile():
    pass


@then("显示用户信息")
def step_then_show_user_info():
    pass
