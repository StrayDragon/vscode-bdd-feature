"""Central binding file — mirrors the real-world pattern of one module
calling scenarios() for many feature files (paths relative to this file,
as pytest-bdd resolves them)."""

from pytest_bdd import scenarios

pytest_plugins = ["steps.login_steps"]

scenarios("features/login_zh.feature")

scenarios("features/order_en.feature")
