# 电话应用入口：授权组件的离线集成

日期：2026-10-09。基线 `709806b8c545a725c3f3cba83c28f52972973e8a`。
本文件记录已完成的 `48ac522` 接线路径；随后增加的标签页controller lease及
per-call Voice许可离线闭环见 [控制租约与Voice许可](CLOUD_CONTROLLER_VOICE.md)。
本轮在真实 `buildSoloServer()` / `SessionManager` 调用路径集成授权，
使用显式注入的测试身份、provider、bridge及预检验证。两个solo启动入口仍拒绝
cloud；默认本机流程、loopback/Host/Origin/token及Twilio验签保持。
它是可审查的应用代码与离线证据，不是已经启用的公网云电话。

## 可独立完成的路径

服务端依赖注入只来自代码，不能通过环境布尔、query/body、cookie中的owner字段
或 `AUTH_READY` 开关开启。注入分支仍要求真实socket来自回环地址，使用固定
HTTPS目标、当前会话cookie、独立CSRF及 [浏览器来源策略](CLOUD_ACCESS_BOUNDARY.md)。
主启动程序不注入该依赖；配置为cloud时，依赖齐全也不能绕过拒绝启动。
注入必须显式提供同一个SessionManager、ConfigStore、两种预检函数及provider/bridge
工厂；不回退到真实供应商默认实现。异步预检同时最多一个，任何结束路径释放名额。

| 真实入口 | 本轮边界 |
| --- | --- |
| `GET /api/status` | 当前认证会话的电话投影；不返回他人的activeSession或全局私密/桌面配置 |
| `POST /api/calls` | 显式受控预检后最终同步重查，再建立服务器归属和本地会话；第一条call事件之前已绑定身份 |
| `POST /api/calls/:id/hangup` | 校验归属及写权限后同步接受结束意图；异步线路清理独立继续，完成响应再校验 |
| `GET /api/events` | 认证会话订阅；服务器按稳定call ID授权每条输出，快照只含本人电话，撤销/到期关闭 |
| `/voice/client`、`/voice/connect`、状态回调和 `/voice/media` | 原验签、账户、nonce、SID和媒体格式校验继续；已绑定会话才接受入流，撤销后的合法迟到SID仅走清理 |

网页没有连接本后端的浏览器语音WS。它使用Twilio Voice SDK，唯一实际媒体WS
为供应商 `/voice/media`；不会把浏览器cookie守卫套到供应商握手上。

服务器归属包含authSession/principal/browserOwner/epoch；客户端传入的owner和call
参数不能授予身份。电话继续全局单通，重复创建得到busy，不创建第二通；重复挂断
复用现有清理，未确认时保持占用。归属按旧call ID保留，不能把迟到字幕或最终
取消/未确认诊断转交下一通电话的owner。
当前累计最多登记100通，失败且尚未发布的创建安全回滚登记；已经发布的会话
保留归属并清理。达到累计上限后拒绝新建，不通过删除旧归属换取容量；这仍是
单实例内存安全上限，不是持久历史或重启恢复方案。

供应商媒体输入和bridge输出每帧检查当前授权；静默通话默认每秒复核。
撤销后停止新音频，合法迟到SID继续清理。严格匹配原stream的clear仅供清理旧播放，
不能携带新音频；已写出或已经听到的声音无法撤回。终止事件订阅者异常也不会
阻止bridge和媒体socket同步关闭，随后独立执行provider两腿挂断。

SSE不使用普通缓冲响应的onSend代替流校验。它在快照、每条事件和心跳最终写出
前重新检查当前会话，按call事件的 `data.id`、其它事件的 `data.sessionId` 过滤。
未知/他人ID不发送；认证失效则关闭。订阅、单帧和未写缓冲有界；断开/异常/停机
释放订阅及计时器。SSE断开仅释放订阅，不续租或代表手机已经挂断；后续新增的
控制租约独立到期清理，SSE重连不会延长期限。
默认最多16条订阅、每认证会话2条、64KiB单帧及256KiB待写缓冲；静默授权复核
间隔为1秒，心跳20秒。计时器受事件循环调度影响，不承诺跨系统瞬时撤销。

## 继续拒绝的路径与决策点

原全局GET语音令牌、presence、普通来电，以及settings、verify、shutdown和
connection-maintenance等管理API继续拒绝。默认本机模式仍使用其现有行为。
后续新增per-call许可使用显式签名/预算intent端口，测试仅假令牌；没有真实登录、
生产签名器/持久许可或生产启动，不能称网页到手机端到端就绪。

| 必须先解决的决定 | 最小选项与完成门槛 |
| --- | --- |
| 已验证登录及当前会话来源 | 采用已有文档的单账户自托管验证，或明确选择外部身份来源；实现cookie签发/轮换/撤销与当前会话存储，不能用测试resolver代替 |
| 标签页控制与Voice身份 | 后续离线代码已实现controller lease及一次性join；生产签名器与浏览器实连尚待验收，不使用全局 `ai-phone` 云身份 |
| 持久预算与创建/清理记录 | 确定单实例持久事务存储或受管事务存储及恢复策略；浏览器资源许可和provider创建前落盘预算/intent，迟到SID可恢复清理 |
| 实际HTTPS/代理/单实例warm | 明确目标环境、固定origin、可信ingress、持久卷和终止宽限，实际回读并故障验收；不是变量齐全就ready |
| 模型与真人验收 | 补历史Python freeze/预置资产，Linux离线warm与资源实测；另明确真实API/电话费用授权，再由用户验收麦克风、普通手机和听感 |

这些选择不阻塞本轮的注入式离线代码验收，但阻塞解除cloud总保护、开放公网、
签发实际连接许可或宣称生产端到端完成。外部异步provider/数据库操作没有由同步
会话检查自动变成原子事务；已接受的安全清理不会因随后撤销而取消。

## 验收证据

使用真实router和SessionManager、显式测试身份与模拟provider/bridge，禁止供应商
网络回退；覆盖A/B归属、来源/读写、预检等待期间撤销、订阅断开/回收、重复操作、
签名/nonce/SID错误、两腿模拟生命周期和旧call晚到事件。具体测试名、数量及当前
通过/失败/未测以 `PROGRESS.md` 最新记录和精确提交CI为准。

```bash
npm run typecheck
npm run build
npm test
npm run test:conversation:browser
```

真实登录、TLS部署、供应商API、Linux模型合成、实际麦克风/手机音频、翻译质量、
数字否定和人耳延迟仍未验收。没有修改Twilio回调、下载模型、使用真实凭据或付费调用。
