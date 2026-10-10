# AI 电话云模式：第一里程碑边界与后续接入设计

日期：2026-10-09。适用入口：`src/solo/index.ts` / `buildSoloServer()`。

本文记录首轮云运行配置及拒绝启动保护；**云模式尚不能运行电话**。后续已完成独立授权组件及真实应用路径的模拟依赖集成，仍不代表生产云认证、真实麦克风、普通手机通话或延迟已经通过。未部署云服务、未改 Twilio 回调、未调用付费接口、未下载模型。

下一里程碑的可审查方案见 [云认证、会话隔离与部署准备](CLOUD_AUTH_DEPLOYMENT_PLAN.md)：推荐无需外部 provider 的单账户自托管 scrypt 验证与 opaque 会话 cookie，身份方案及具体配置待确认。本文运行配置和拒绝启动行为保持不变。

后续组件见 [会话/通话授权边界](CLOUD_ACCESS_BOUNDARY.md)；最新 [电话应用离线集成](CLOUD_PHONE_APPLICATION_INTEGRATION.md) 通过显式依赖对象保护真实 status/create/hangup/SSE 及关联媒体生命周期。默认生产入口不启用该对象，不实现登录，也不解除本文 cloud guard。

进一步的 [控制租约与Voice许可](CLOUD_CONTROLLER_VOICE.md)提供单标签页租约、一次性加入及显式签名/预算intent端口的离线闭环；测试只有假令牌，生产登录、签名和持久许可仍未实现。

原上游 Flex 的 `src/index.ts` / `npm start` 是独立入口，不受此 solo 保护控制。不能用它绕过云模式保护，或把该入口的启动成功当作本方案完成。

## 已实现的运行配置

`src/solo/cloud-runtime.ts` 独立于本机设置页面和供应商秘密配置：

| 变量                    | 当前行为                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `AI_PHONE_RUNTIME_MODE` | 默认 `local`；仅接受 `local` / `cloud`，其他值拒绝。`PORT`、`NODE_ENV` 不会自动切换模式。                                            |
| `CLOUD_PUBLIC_ORIGIN`   | `cloud` 必须显式指定固定 HTTPS 根地址；拒绝凭据、路径、查询、片段及 loopback / wildcard 主机，规范化为 origin。WSS origin 由它派生。 |
| `PORT`                  | `cloud` 必须指定 1–65535 的整数端口；解析计划绑定 `0.0.0.0`。`local` 继续使用现有 `API_HOST` / `API_PORT`，不受平台 `PORT` 影响。    |
| `CLOUD_WARM_INSTANCES`  | 默认为 `1`，仅允许 `1`。这是启动规划约束，还没有操作云平台扩缩容。                                                                   |

示例仅用于离线检查配置，**不是可部署配置**：

```dotenv
AI_PHONE_RUNTIME_MODE=cloud
CLOUD_PUBLIC_ORIGIN=https://phone.example.com
PORT=8080
CLOUD_WARM_INSTANCES=1
```

运行配置读取和 `ConfigStore` 相同的私密 `.env` 文件，环境变量优先。不在浏览器设置 API 中增加云模式开关。即使所有 cloud 字段格式有效，`src/solo/index.ts` 和导出的 `buildSoloServer()` 都会抛出 `CLOUD_AUTH_NOT_IMPLEMENTED`，不监听端口、不启动模型、不给现有本机控制 API 开放网络访问。命令入口在本机 token 自动生成之前拒绝。

`src/solo/security.ts` 的 socket loopback、允许的 Host、拒绝 forwarded headers、同源检查、本机访问 token 均保留。Twilio webhook 签名、账户验证、媒体 nonce 与 call SID 绑定也保留；现有 `/api/health` 仍仅返回应用标识。

## 云认证与通话隔离的实现门槛

默认本机路径仍使用 Twilio 浏览器 identity `ai-phone`、共享 presence / activeSession 和全局 SSE，只适用于受 loopback 保护的本机单人模式。显式注入路径生成每通服务器 identity、隔离 owner 状态/SSE并校验控制租约及一次性加入；实际登录、Voice签名器、持久许可与生产启动尚未启用。将来独立 cloud server 必须完成下面流程后才能解除拒绝启动保护；不能通过设置 `AUTH_READY=true` 或删除本机检查实现。

1. **浏览器登录与服务端会话。** 第一版推荐单账户自托管验证：使用 Node 内置异步 `crypto.scrypt` 验证独立密码，服务端保存带随机 salt 的验证摘要，不复用本机 token。登录交付随机、不透明的短期会话 cookie，`HttpOnly`、`Secure`、`SameSite`，设定到期及撤销机制，轮换登录前会话 ID；稳定 principal 与登录会话、browser owner、控制 lease 分开。具体参数、标签页控制和授权清单见 [认证方案](CLOUD_AUTH_DEPLOYMENT_PLAN.md)。推荐尚待确认/实现，不生成秘密或安装外部认证服务；外部 IdP 仅作为以后另行授权选项。
2. **固定 origin 与请求防护。** 浏览器修改状态的请求必须匹配 `CLOUD_PUBLIC_ORIGIN`，并验证独立 CSRF token；服务端按 cookie 会话授权，禁止通配跨域。TLS 由部署入口终止，HTTPS/WSS 外部地址固定；只信任部署入口明确定义的代理来源，不以任意 `X-Forwarded-*` / `Host` 推导签名地址或授权。HTTP 到 HTTPS 跳转及 cookie 不走明文须在实际部署入口验收。
3. **每浏览器 owner。** 登录会话内部生成稳定 owner ID；每通电话、浏览器 presence、Twilio 浏览器 identity、字幕账本及 SSE 订阅绑定该 owner。浏览器重连可延续所有权，其他标签页默认不自动接管，接管要明确处理。浏览器不能通过传入 `ownerId`、call ID 或 Twilio identity 取得权限。`status`、`events`、`token`、`presence`、`calls` 和 `calls/:id/hangup` 均从已认证 owner 决定可见范围；owner A 不得读取或结束 owner B 的电话。
4. **单实例不等于单一 owner。** 第一阶段仅一个 warm 进程、一个固定 Pocket worker；可以限制全局仅一通电话，其他 owner 得到 busy，仍必须逐 owner 授权。供应商签发的短期浏览器语音令牌仅包含对应 owner 的 voice identity / 应用 grant；`/voice/client` 必须把已签名的 Twilio identity、owner、通话及角色 nonce 对齐，不能仅凭已知 session ID 使用别人的电话。每腿媒体仍验证账户、call SID、role、nonce、首次 start 消息；禁止跨会话混音。
5. **SSE 和断线生命周期。** 云 SSE 使用同源 cookie 鉴权，禁止复用本机长期 `?token=`。每个 owner 有订阅数限制、事件大小/缓冲限制，重放只返回该 owner 的通话事件。断开立即释放订阅、heartbeat 和缓冲；浏览器 lease 在允许的有限重连宽限内保留通话，宽限到期才结束对应 owner 的两腿与翻译/合成队列。页面关闭 best-effort 通知不能作为唯一清理机制，后台 lease 到期必须独立生效；不得因一次 SSE 重连立即挂断。
6. **确认清理与停机。** 复用现有 `SessionManager.end()` 的 provider 清理确认；挂断失败或状态未知继续标为 cleanup unconfirmed，不能宣称 safe。取消翻译、TTS 和媒体排队、拒绝晚到块、关闭 socket，并保留受限的回调清理状态。`SIGTERM` 先拒绝新通话、按预算清理两腿，再关闭事件流和服务；不因进程退出就假设普通手机已经挂断。公网浏览器不能调用当前本机 `/api/shutdown`、供应商配置写入或桌面恢复 API。

## 部署与 warm 规划

- 使用固定 HTTPS 域名及 WSS 媒体入口，提供平台 `PORT`；供应商 callback URL 必须由同一固定 origin 生成，不从请求 Host 猜测。将来云 origin 与 `PUBLIC_BASE_URL` 不一致要在启动时拒绝。本轮不改现有 `.env` 私密配置或 Twilio callback。
- 仅一个持续运行实例，关闭 scale-to-zero / 多副本；云平台实际上是否保持 warm 需要部署时回读，配置解析不能证明它已生效。进程重启会丢失本阶段内存会话，应保留必要的供应商清理线索或禁止将它作为生产能力。
- Pocket 固定 Michael 声音及锁定依赖/模型哈希继续使用；Linux 可执行路径参数化由独立兼容实现处理。不换引擎、不即时下载模型、不克隆本人声音。现有模型须事先安全提供，在接电话前校验并完成 warm；worker 未 ready 时拒绝电话，不能在第一通电话中冷启动。
- 中文出程仍译为自然英文；英文回程直接传原声，中文只显示字幕。字幕 owner / session / utterance ID 和原译文配对独立于 TTS 生命周期，待播放、发往线路、线路确认分别记录；确认播放不等于真人耳听或译意验收。

## 离线门槛与未验收项

本轮回归必须覆盖：默认 local、本机 `PORT` 不切模式、非法云配置、cloud 命令和 builder 都拒绝、拒绝前不写本机 token，以及原 loopback / Host / forwarded / Origin / token / Twilio 签名拒绝规则。

后续解除保护前，至少做两个模拟 owner 的越权读取/挂断/token/SSE 测试、过期/撤销会话、CSRF / origin / 代理伪造、浏览器断线宽限及到期、慢 SSE 订阅者、媒体乱序及跨会话 nonce、TTS 晚到块、关机清理未确认等离线验收。逐句字幕模拟还需覆盖插话、晚到译文、否定/数字修订和播放积压；这些不能由云配置解析代替。

未验收：真实登录服务、云平台 warm/HTTPS/代理配置、供应商资源配置、真实麦克风、普通手机双向电话、自然度与实际耳听延迟。后续新增服务、密钥/访问权限、付费调用或实际部署按用户授权边界另行处理。
