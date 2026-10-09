# 单人标签页控制租约与一次性Voice许可

日期：2026-10-09。基线 `48ac52237c1e6edd89541876b511fa23c38ec57c`。
本轮继续真实电话应用的离线接线，身份来源、签名器、预算/intent和供应商仍由
测试显式注入。没有选择或配置登录提供方，没有真实JWT、凭据或供应商调用。
两个solo cloud启动保护和注入应用的回环限制继续；默认本机流程不变。

## 控制权与读取

登录会话和控制标签页分别验证。租约绑定authSession/principal/browserOwner/auth
epoch，以及客户端tab标识、服务器controller epoch、随机不透明凭证和期限。
tab标识只是关联信息，不能凭相同tabId重新领取已有租约凭证；其它标签仍只读。
只有带当前凭证的显式写请求能够续约或撤销；读取status、SSE或重连不续租。
期限受已验证会话的绝对/闲置期限限制，过期、撤销和旧epoch失效。
默认30秒，上限60秒；只有显式续约更新当前期限。认证失效后旧租约也可能保持
占用至原期限，期间拒绝新领取，不能把重新登录当作自动接管。

首轮仅单个controller、单通电话，不增加多租户产品。已有控制权、活动电话或
清理未确认均不允许新标签接管。控制失联到期会停止媒体并独立清理两腿；清理
失败继续阻止下一通，不能仅以本进程没有新音频就宣称线路已经挂断。

## Voice加入与持久许可端口

Voice许可使用每通服务器identity，并绑定当前会话、lease、call和一次性join。
签名器只接受最小授权描述，必须显式注入；没有读取真实secret的默认签名器。
公开outgoingApplicationSid显式固定，并与ConfigStore的TwiML应用一致；签名器
不会收到含secret的配置对象。测试输出只是假字符串，不创建真实Twilio JWT。
许可期限不超过当前租约/会话期限；不使用云全局 `ai-phone`、本机一小时token
或全局presence替代控制许可。入呼权限关闭，原全局token入口继续拒绝。

最小VoiceGrant包含identity和出呼TwiML应用授权，禁止incomingAllow。官方
[Access Tokens](https://www.twilio.com/docs/iam/access-tokens)列出的VoiceGrant并不
提供应用层per-call权限，因此本轮的call限制由已签名 `/voice/client` 回调的
服务器join消费和当前租约检查实现，不能仅靠在描述中添加call字段宣称JWT受限。
错误call/identity/nonce、重复加入或其它SID不能获得新连接；合法迟到SID只清理。
浏览器重复connect产生新SID时拒绝；同一SID的已签名供应商回调重试可幂等返回
原连接，区分为replay，不签发新票、不再绑定/拨号。已经加入的电话由当前租约和
预算许可控制，显式续租不会复活旧join票据，也不把最初票据期限当作电话寿命。

持久预算与创建/清理intent没有实现。生产连接许可缺少该端口必须拒绝；本轮
测试使用明确fake reservation/admission验证调用顺序和失效处理，不能证明落盘、
费用预算或重启恢复已经可用。未来实际端口须在发出浏览器连接许可前持久预留
预算和intent，在后续dial/迟到SID/清理中保持可追踪；不能用READY布尔替代。
同步当前授权检查不会把外部异步存储或签名变成原子事务，准备后必须重查。
reservation通过显式自有数据字段提供同步assertCurrent和异步release；需要时由
未来存储适配器包装方法。普通方法保留原receiver，getter/继承字段、布尔就绪或
Promise形式的最终assert不能作为当前事务许可。
HTTP最终onSend还检查私有签发对象、当前会话/lease/call和预算许可，准备中或
最终写出前撤销时不交付原token/join。加入后到bridge就绪及真正dial前，媒体和
独立生命周期继续检查当前预算许可，不能复用准备时有效的快照。

确认结束后才尝试release。释放失败或reserve发出后的结果未知，保留不确定状态
并拒绝新许可/通话；安全释放可独立重试，没有公开reset或假恢复开关。无安全
释放能力的未知结果须由未来权威持久端口恢复，重启不能证明记录已经清理。
release也不等于持久退款或删除journal：真实JWT在其有效/供应商窗口内可能导致
晚到browser SID，未来端口必须保留可恢复intent和这段残余责任。当前内存保留的
call/join记录可拒绝新增权并清理迟到SID，不能据假端口宣称零残余费用或重启安全。

## 离线路由闭环

所有写操作仍需已验证会话、精确Origin和CSRF；controller凭证来自服务端，不由
客户端tab字段授予。以下路由只存在于显式注入分支，仍限制回环socket。

| 路径 | 作用 |
| --- | --- |
| `POST /api/controller/acquire` | body为tabId；已有控制/活动电话/未确认清理时拒绝领取 |
| `POST /api/controller/renew` / `revoke` | body为原tabId、leaseId、epoch；仅显式持有者可续租/撤销 |
| `POST /api/calls` | body的controller凭证校验后预检并建立服务器reservation；不以presence授权 |
| `POST /api/calls/:id/voice` | 当前call/lease及显式预算intent、签名端口准备最小grant和一次性join |
| 已签名 `/voice/client` 与媒体WS | join首次消费后绑定SID，bridge就绪并再次检查许可才调用fake provider拨出 |
| `GET /api/status` / `events` | 同认证会话其它标签只读；订阅与重连不会续租 |
| `POST /api/calls/:id/hangup` | 带controller凭证接受同步结束意图；两腿异步清理独立继续 |

没有修改现有生产网页以启用该分支。fake Voice SDK测试使用真实router/签名回调
和临时回环媒体/SSE，验证准备→加入→bridge就绪→拨出→字幕→挂断的离线闭环；
真实浏览器UI另保留逐句对话模拟验收，二者不合称供应商实连。

## 翻译与验收范围

云注入默认 `pocket-prefix`；允许明确选择同固定Michael的 `pocket-captions`。
云路径拒绝legacy等其它体验策略，默认本机引擎选择保持原样。中文译成英文由
既有Pocket路径输出；英文回程保持原声，中文字幕旁路，不新增中文配音。
测试只使用fake bridge和既有离线材料，不加载模型或验证实际听感。

真实路由的fake Voice SDK/provider/bridge闭环、权限拒绝、准备中撤销、SSE重连
不续租及失联清理的具体结果以 `PROGRESS.md` 最新记录和精确提交CI为准。
真实登录、JWT签发、HTTPS部署、持久预算/journal、Linux模型warm、麦克风与
普通手机通话、自然度/数字否定/积压和耳听延迟仍未验收。
