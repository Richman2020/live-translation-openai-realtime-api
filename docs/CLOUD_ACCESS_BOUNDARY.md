# 云会话与通话归属：独立授权组件

日期：2026-10-09。依据 [已审查方案](CLOUD_AUTH_DEPLOYMENT_PLAN.md)。
本里程碑提供授权组件与离线 HTTP/WebSocket 证据；**没有接入生产电话路由，
没有登录提供方，cloud 两个启动入口仍拒绝 `CLOUD_AUTH_NOT_IMPLEMENTED`**。
本机 loopback/Host/Origin/token 与 Twilio 签名边界保持原样。

## 当前接口与信任边界

- `src/solo/cloud-access.ts` 的 `CloudAccessPolicy` 仅接受服务端配置的当前会话
  resolver；缺 resolver 时拒绝。它不验证密码、不签发 cookie、不提供登录接口。
  内存模拟身份仅存在于 `tests/`，没有生产默认模拟器、环境开关或请求参数开关。
- resolver 必须同步查询已验证会话的当前状态。返回记录经过字段与到期校验，
  包括 principal、authSession、browserOwner、epoch、绝对/闲置到期和撤销状态。
  Promise/thenable resolver 不受支持并拒绝；异步登录、数据库查询或事务需要以后
  单独设计，不能把缓存的异步快照当作最终权限。
- 身份仅来自唯一、规范的 `__Host-ai-phone-session` cookie。固定 HTTPS 目标与
  Host 必须匹配；来源按下面的读取/修改/WS策略验证，歧义头和 forwarded 头拒绝。
  body/query/Authorization 中的身份或本机 token 不会授予权限。
- 认证上下文由策略实例私有 WeakMap 识别；复制或构造相同字段不能冒充。
  服务端登记的通话绑定 authSession、principal、browserOwner 与 epoch，登记数量
  有上限且 ID 不能重复重绑。不同登录即使共享 principal 或 owner 字段仍不能越权。
- 写操作及输入音频还须匹配会话 CSRF；原文/译文和输出音频按读取权限验证。
  接管一律拒绝。本组件未实现控制 lease、预算或实际拨号授权。

## 兼容浏览器的请求来源策略

请求类型与 HTTP method 由服务端适配器读取真实请求并传给策略，不来自 body/query。
未显式传入来源类型的核心调用仍要求精确 Origin，不自动猜测读取请求。

| 请求                                   | 独立组件的允许条件                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP `GET`/`HEAD` 读取、输出音频、字幕 | 有 Origin 时必须精确匹配固定 origin；没有 Origin 时，必须同时带 `Sec-Fetch-Site: same-origin`、`Sec-Fetch-Mode: cors` 或 `same-origin`、`Sec-Fetch-Dest: empty` |
| HTTP 修改、输入音频                    | 只允许 `POST`，必须有精确、非 null Origin，且会话 CSRF 匹配；读取的缺 Origin 例外不能用于写                                                                     |
| 浏览器 WS 握手与后续帧                 | 握手必须有精确、非 null Origin，没有读取例外；写帧继续验证独立 CSRF 与已绑定 call                                                                               |

固定 Host、有效 cookie/当前会话和通话归属在每种请求中都不可省略。有错误 Origin
时不能改走 Fetch Metadata；出现 cross-site、same-site、none 或不完整/歧义 metadata
时拒绝。导航、图片/no-cors、来源不明的旧客户端没有缺 Origin 的降级通道。
来源限制绑定到私有授权上下文；GET/HEAD 读取上下文即使带有效 CSRF，也不能被
后续调用提升为注册通话、写入或输入音频权限。

此读取规则使用 [Fetch 的 Origin 行为](https://fetch.spec.whatwg.org/#origin-header)
及 [W3C Fetch Metadata](https://www.w3.org/TR/fetch-metadata/) 描述的浏览器来源信息。
metadata 是来源防护，不是身份凭据；非浏览器客户端能伪造它，仍须通过 cookie、
服务端当前会话和归属检查。HTTP 响应禁用私有内容缓存，并声明来源/cookie 的 Vary。
本轮实际 Chromium 同源 fetch 与 EventSource 的请求头证据包含在浏览器验收中，
不由测试代码人为设置 Origin 或 Sec-Fetch 头。

## 最终检查与传输

`runAuthorizedCall()` 在同步当前状态查询与归属检查后，于同一执行栈调用同步
commit/send。异步准备发生在它之前；准备期间撤销、过期或 epoch 变化会在最终
检查拒绝。它不使外部异步电话/API/数据库操作变成原子事务，也不能撤回已经写出
的网络数据；将来实际后端必须另有 lease、预算、幂等、取消与持久清理门槛。

`src/solo/cloud-access-transport.ts` 仅导出可注册的适配器，不注册路由或监听端口：

| 接口                   | 本轮保护                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `httpRoute()`          | 配套请求与最终 `onSend` 授权；未认证或跨通话请求不进入后端，等待响应期间失效也不交付原内容 |
| `executeHttp()`        | 异步准备后重新检查，再执行同步模拟副作用；错误转换为固定响应，避免泄露身份或后端异常       |
| `browserSocketGuard()` | 在浏览器升级入口验证会话、固定来源、通话归属并限制连接数量                                 |
| `bindBrowserSocket()`  | 绑定唯一通话；每条输入和每次输出重新授权，撤销/过期后拒绝处理与发送，并关闭流              |

HTTP 仅支持缓冲完成的响应；流式响应被拒绝并销毁，未实现 SSE 逐块校验。

浏览器 WS 无法设置自定义升级 CSRF header；写帧中仅允许独立 `csrfToken` 字段
映射到校验，帧的 cookie/owner/session 字段不能替换握手身份。未知字段、其他
call ID、接管、非法或过大帧拒绝。连接数、待处理帧/输出与缓冲有界，关闭释放名额。
输出音频和字幕都不能绕过最终授权。空闲连接定期复核，默认间隔一秒；不是瞬时
跨系统撤销保证。

这些接口专用于浏览器。`/voice/*` 明确拒绝使用该适配器；Twilio 的签名、账户、
CallSid、role/nonce 与媒体绑定是另一边界，现有实现未改。供应商回调与未来云
owner/journal 的绑定尚未接线，不能把浏览器 cookie 当作 Twilio 鉴权。

## 离线验收与尚未接线部分

```bash
npm run typecheck
node --import tsx --test tests/cloud-access.test.ts tests/cloud-access-transport.test.ts
npm test
npm run build
npm run test:conversation:browser
```

测试只创建明确标记的内存模拟身份、模拟通话/音频/字幕与后端计数器。
HTTP 使用 Fastify 注入，WS 使用云端容器内临时回环端口与锁定插件的真实升级/帧路径；无公网入口、
供应商请求、录音或普通手机呼叫。覆盖缺身份、来源/CSRF失败、到期/撤销/epoch、
跨会话读写/音频/字幕、伪造上下文、禁止接管、准备后撤销和队列/连接回收。
具体数量和实际结果以 `PROGRESS.md` 最新记录及当前 PR CI 为准。

已独立验证浏览器读取的来源规则；**没有实现登录或现有电话入口接线，也没有提供
生产 SSE**。缺 resolver、缺可信来源证据的读取、未授权写/WS与流式响应继续拒绝。
真实 HTTPS/反向代理、cookie签发、会话存储和 SSE 逐块授权仍须各自实现并验收；
不能将组件测试或浏览器请求头观察称作已接入电话的端到端通过。

实际登录/cookie签发轮换、会话存储、控制 lease、允许号码/费用预算、持久 journal、
供应商回调清理、既有全局 SessionManager/SSE 的 owner 接线、真实 HTTPS/代理和
Linux Pocket warm 均未完成。本次内存通话归属表不能作为重启恢复保证。
保持 cloud 总保护，按 [授权配置清单](CLOUD_AUTH_DEPLOYMENT_PLAN.md#后续执行前需要用户确定的具体配置)
和分步门槛推进，不据这些离线组件宣称云电话 ready。
