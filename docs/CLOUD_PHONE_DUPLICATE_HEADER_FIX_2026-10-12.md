# 固定 Voice 回调普通重复头修复（2026-10-12）

精确基线 `f26006cb944e02700c32eb0ac7ad1f87105c86ee`，独立分支
`codex/cloud-phone-conversation-duplicate-header-fix-20261012`。
用户自行发布基线，deployment `e571df69-2931-4db6-a19b-d9f5713ba533`
于 02:28:36 UTC SUCCESS。父线程回读两次真实拨号日志：
02:30:24.994746Z、02:30:31.029782Z 固定事件
`CLOUD_VOICE_CLIENT_REJECTED`、route `/voice/client`、reason
`INGRESS_DUPLICATE_HEADER`；Twilio响应仍为 `CLOUD_INGRESS_FORBIDDEN`。
自动领取控制权、session、call及voice准备已通过。

## 根因与范围

入口原始头循环除四项代理元数据外要求所有字段唯一，连不参与认证的
普通传输头重复也提前403。真实日志已确认此拒绝分支；缺原始请求头，
不能断言具体重复字段是Accept、User-Agent或其他普通字段。

仅既有精确 `POST /voice/client`、form类型、非空单值签名头的传输候选，
普通字段完全剥离，不拼接、不任选一个转发。Host、X-Twilio-Signature、
Content-Type/Length/Encoding、Transfer-Encoding、Connection、Upgrade、
Expect、TE、Trailer、Keep-Alive及代理认证、Authorization、Origin、Cookie、
全部 `x-phone-*` 与 `sec-*` 保持原重复/规范化检查。四项代理元数据仍剥离。
签名头存在只选择传输处理，后端仍使用固定公开HTTPS URL、原始完整表单
和官方SDK验签，原Account/nonce/From/join/SID/会话/controller继续检查。

浏览器/API/其他Voice路径、loopback、本地特权限制、Origin/CSRF、体积/超时、
预算移除及挂断/失联/到期清理均保持。生产源码只修改cloud-ingress；固定
诊断枚举保持，不记录任意头名/值或签名/token/nonce/join/号码/原始异常。
关键头重复必须继续拒绝，不能为真实请求自动扩大豁免。

## 真实HTTP隔离红绿

同一个生产配置parser/createCloudService、Google RSA/PKCE、实际client.dial、
公开ingress、正式SDK签名及URLSearchParams表单组合中，旧版重复Accept
精确403，新版Accept/User-Agent/X-Request-Id重复均200 Stream TwiML，
并从私有HTTP上游确认这些普通头不存在。

浏览器API重复Accept仍403；重复Host/签名/Content-Type/Connection/TE/
Origin/Authorization/CSRF/Fetch Metadata/WebSocket安全头仍403。Cookie数组
被Node客户端自动合并，测试改用真实socket发送两条Cookie确认403；重复
Content-Length由Node解析器400，CL-TE歧义仍400。普通重复头加伪造签名仍
403 INVALID_TWILIO_SIGNATURE；错误URL/Host/账户/nonce/身份/join/SID仍拒绝。
同SID重放、会话刷新/续期/过期、控制权及本地特权拒绝原回归保留。

该fixture无外部提供方请求，fake PSTN create=0、model bridge=0，唯一fake
本地腿按原挂断路径清理。定向HTTP13/13，独立安全审查及ingress/HTTP/
diagnostics30/30通过。完整检查结果见 [PROGRESS](../PROGRESS.md)。

本任务只代码/隔离验收/开发分支推送，不stage/deploy、不创建Railway patch、
不实际拨号/付费模型调用、不改供应商资源或凭据。真实新版回调和真人
电话恢复仍须父线程核验，隔离通过不能替代。
