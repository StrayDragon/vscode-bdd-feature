from pytest_bdd import given, when, then, scenarios

scenarios("../sample-en.feature")


@given("the user is logged in", target_fixture="context")
def step_given_logged_in():
    return {}


@when('the user clicks the "Login" button')
def step_when_click_login():
    pass


@then('the user should see the "Welcome" page')
def step_then_see_welcome():
    pass


@given("a product exists in the catalog")
def step_given_product_exists():
    pass


@when("the user adds the product to the cart")
def step_when_add_to_cart():
    pass


@then("the cart should contain {count:d} item")
def step_then_cart_count(count):
    pass


@then("the cart total should be ${total}")
def step_then_cart_total(total):
    pass
