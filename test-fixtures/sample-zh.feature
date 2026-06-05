# language: zh-CN
功能: order_info wire 空值

  场景: POST major null 落库 NULL
    假设 用户 90232 订单 ET_INT_CLR_MAJOR header 专业为 Physics
    当 运营 POST order_info 清空 major 为 null
    那么 订单 ET_INT_CLR_MAJOR header 专业为 NULL

  场景: POST major 空字符串落库 NULL
    假设 用户 90233 订单 ET_INT_CLR_MAJOR2 header 专业为 Chem
    当 运营 POST order_info 清空 major 为空字符串
    那么 订单 ET_INT_CLR_MAJOR2 header 专业为 NULL

  场景: 多步骤测试
    假如 用户 10001 有订单 ORD_001
    而且 订单状态为 "待处理"
    当 用户提交订单
    但是 系统检测到余额不足
    那么 订单状态变为 "失败"

  场景大纲: 参数化测试 - <用户ID>
    假设 用户 <用户ID> 订单 <订单号> 存在
    当 查询订单状态
    那么 返回状态为 <预期状态>

    例子:
      | 用户ID | 订单号     | 预期状态 |
      | 10001  | ORD_001   | 成功    |
      | 10002  | ORD_002   | 失败    |

  @smoke
  场景: 带标签的测试
    假设 系统已启动
    当 发送健康检查请求
    那么 响应状态码为 200

  规则: 订单创建规则

    场景: 创建新订单
      假设 用户已登录
      当 用户选择商品 "手机" 并提交订单
      那么 系统创建订单成功
      而且 返回订单编号

  背景:
    假设 数据库连接正常
    而且 用户服务可用
