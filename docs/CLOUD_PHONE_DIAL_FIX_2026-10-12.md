# 个人电话首次拨号与回调入口修正（2026-10-12）

基线 `fd6ec0921d4551de03d3afe95306b3072b746369`，本地分支
`codex/cloud-phone-conversation-dial-fix-20261012`。本任务验收后已授权推送独立分支，不自动stage/deploy，
不创建 Railway patch，不拨号、不访问付费模型、不改 Twilio 资源或凭据。

## 已有真实证据与未闭合部分

父线程报告：用户自行发布该基线，部署
`94058041-e24c-4b58-8495-ca81d5b53915` 于 01:35:59 UTC SUCCESS。
01:37:30 的 Google callback、公开工作台和受保护 browser-session 均 200；
01:38:45 与 01:39:03 的 calls/voice 均 200，随后的 `/voice/client` 均 403，
之后 hangup 200。用户提供的 01:39:04 Request Inspector 明确响应
`{"error":"CLOUD_INGRESS_FORBIDDEN"}`，错误 11200；固定 HTTPS URL 与标准 form
字段齐备。这证明 ingress 在应用验签/业务处理之前拒绝，不能归因于预算、
OAuth、模型或未证明的 Auth Token 错误。真实 nonce/join/号码未复制到仓库。

原始请求头没有提供，因此尚未证明具体哪项头条件触发。当前环境无 Twilio
凭据/读取工具，Railway 仅返回变量名，不能读取原事件或修改凭据。
截图精确 Library ID 已解析，但材料下载失败，未见像素，不用自动说明替代
视觉验收。真实电话恢复、模型握手和双向音频仍未验收。

## 最小实现

- `controller-client.js` 保留原 `canStart`/`startCall` 的持权要求，新增显式
  `dial`：空闲已登录页面可直接拨打，既有 acquire → 确实应用的最新服务端
  bootstrap → 原 startCall。boot、普通刷新与 SSE 不领取或恢复控制权。
  单次本地锁、generation、读取序号及原 proof 保护重复点击、取消、隐藏、
  断线、导航、退出、迟到许可和并发刷新；迟到有效许可被撤销。
- 工作台拨打按钮使用 `canDial`，领取期间可以取消准备；其他页面持权提示
  明确，忙线/清理未确认不能接管。手动控制保留为可选操作。
- ingress 仅对精确 `POST /voice/client`、form 类型、非空单值签名头候选
  剥离 Forwarded/X-Forwarded-For/Host/Proto 元数据。签名头存在只是传输分类，
  不是授权。真实 Host 仍精确固定；URL/正文不改，后端原官方 SDK 继续用固定
  HTTPS public URL 验签，账户、nonce、From、join、SID、控制权/会话继续检查。
  浏览器、管理 API 和其他 Voice 路径保持原规则；重复安全头、CL-TE 歧义、
  Connection 提名、encoding、体积、超时和 loopback 保持。
- 拒绝诊断只输出固定事件、固定 `/voice/client` 和固定 reason 枚举，区分
  ingress 头形状/重复/规范化/Host/代理数据/Connection/framing 与原验签或
  通话绑定错误；未知映射固定 fallback，日志失败不改变授权/清理。
  不输出 header 值、签名、token、nonce、join、SID、号码或原始异常。

## 隔离红绿与验证边界

原页面已登录且 canAcquire=true，但 canStart=false，必须先手动领取；新
controller 回归见证原失败。正式签名标准表单在未改后端时已能通过生产组合
返回 200 Stream TwiML，排除了通用 form/固定URL/HMAC 实现损坏的推测。
加入代理链样本后，旧 ingress 精确 403 CLOUD_INGRESS_FORBIDDEN，新范围返回
200；这个样本证明协议兼容缺陷，不冒充原请求头。原始具体头仍待证据。

真实 createCloudService/parser/Google RSA/PKCE/client.dial/controller/Voice
grant/HTTP ingress/官方 SDK 签名/URLSearchParams form 组合覆盖标准成功、
同 SID replay、代理链/重复代理头成功，以及重复签名/Host、CL-TE、Connection
提名、伪造签名、错误账户/nonce/身份/join/SID 拒绝。fake PSTN creates=0，
模型 bridge=0，唯一 fake 本地腿经原挂断路径清理。JWT fixture 采用实际 SDK
同源实时时钟，保留生产严格过期检查，并在失败时 dispose 防止定时器残留。

最后测试与编译结果见 [PROGRESS](../PROGRESS.md)。当前安全评审通过；不宣称
原真实回调已恢复。父线程可先取得现有网关原始请求头，或在批准更新后使用
固定 reason 分类收敛；也可用已有授权凭据签名一个明确不存在 sessionId 的
非收费回调探针，期望经过 ingress/验签后 INVALID_SESSION，绝不创建通话。
探针不复制旧 nonce/join、不创建会话或拨号，此环境因无凭据未执行。
