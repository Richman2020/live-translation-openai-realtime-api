# 个人 cloud phone 工作台导航修复（2026-10-12）

修复分支 `codex/cloud-phone-google-login-fix-20261012` 从精确线上
`efb1443b89eeb0a22084e29f6cd28a8c88e1a5cf` 建立。父线程确认该 SHA 的
Railway deployment `c90c8a93-d787-4c12-97fb-9221df043db5` 于
2026-10-12 00:27:50 UTC SUCCESS；实际服务为 `CLOUD_SERVICE_MODE=phone`、
`AI_PHONE_RUNTIME_MODE=cloud`、`CLOUD_PUBLIC_CALLBACK_CONFIRMED=true`、单副本。
这些运行事实由父线程提供，本任务没有修改平台或重新发布。

## 根因与补丁

用户截图地址栏明确是本站 `/controlled`，无 query；响应为精确
`{"error":"LOCAL_ACCESS_ONLY"}`。Google 登录按钮可以到达账户选择页，
因此不能把这个错误归因于 OAuth 入口、凭据或 token 验证。

`src/solo/server.ts` 的 `controlledPublicRequest` 原来只允许该公开 HTML 页
`Sec-Fetch-Site=none/same-origin` 的 `navigate/document` 请求。从 ChatGPT 等
外站链接进入时，浏览器使用 `cross-site`；其他同站来源会使用 `same-site`。
phone 模式因此拒绝公开工作台。旧 web-workbench 没有此静态导航门槛。
`cc21d647aff25587e1db3c82222ab41fc35c1814` 到 `efb1443` 的 server、Google
login 和 ingress 源码相同；这是切换运行模式后暴露的既有路径差异。

唯一生产补丁：仅 `/controlled` 的 GET/HEAD、`navigate/document` 导航增加
`same-site` 和 `cross-site`。它仍只返回公开静态 HTML，没有会话或控制许可。
固定 Host、真实 loopback、提供时的精确 Origin、重复/转发头、query、CSP
与缓存保护保持。跨站 fetch/iframe/素材请求、认证/JSON 控制接口、本地配置
和管理接口继续拒绝；Google state/nonce/PKCE/issuer/签名/audience/身份、
CSRF、controller、Twilio 签名规则没有改动。取消应用五美元预算与清理实现
原样保留，没有新增依赖、OAuth、凭据或角色。

## 复现与隔离验证

原线上源码的真实 `createCloudService → createCloudIngress → loopback app`
HTTP 复现（固定假配置，供应商调用 0）：

| `/controlled` 顶层导航 site | 原 phone | 旧 web-workbench | 修复 phone |
| --- | --- | --- | --- |
| none / same-origin | 200 | 200 | 200 |
| same-site / cross-site | 403 LOCAL_ACCESS_ONLY | 200 | 200 |

新 HTTP 回归在补丁前为 2 fail / 1 pass，精确见证上述误拒绝。
Google 浏览器脚本升级为生产 phone 配置和完整 ingress 组合，TLS 代理只模拟
平台 HTTPS 转发；从独立假外站链接进入，由 Chrome 生成原生 Fetch Metadata。
原源码无法到达工作台（等待超时），修复后 26/26：外站进入、Google 一次性
登录与 PKCE、RSA OIDC、callback 返回无认证参数的 `/controlled`、cookie
边界、控制权领取、CSRF 拒绝、退出撤销、刷新和 replay 拒绝均通过。
全部 Google 导航和交换都被明确离线端口拦截，外部请求、真实电话/模型调用
和浏览器异常均为 0。实际 Google 账号登录另由父线程已授权浏览器验收。

最终完整测试、编译和其它浏览器结果记录在 [PROGRESS](../PROGRESS.md)。
本任务只交付本地 commit/patch/bundle，不推送、不建 PR、Railway patch 或部署，
不主动拨号、不进行付费模型握手、不连接用户电脑。父线程核对精确提交后
协调已授权 devpush/发布，再验收真实 Google 登录及已有页面/会话行为。
