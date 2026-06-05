# language: zh-CN
功能: Mixed Chinese and English steps

  场景: Test with English steps
    Given user logs in with "admin" and "password123"
    When user clicks the submit button
    Then the dashboard is displayed

  场景: Test with Chinese steps
    假设 用户使用 "admin" 和 "password123" 登录
    当 用户点击提交按钮
    那么 显示控制面板

  场景: Mixed language steps
    Given 用户已登录系统
    When 用户访问 "/settings" 页面
    那么 页面标题应为 "Settings"
    而且 用户名显示为 "admin"
