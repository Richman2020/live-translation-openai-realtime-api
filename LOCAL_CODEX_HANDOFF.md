# 电脑端 Codex 接手：GitHub 同步与本地电话翻译

日期：2026-09-22。目标仓库：https://github.com/Richman2020/live-translation-openai-realtime-api 。

本文件描述待执行工作。当前没有新的真实 API 连通、双向翻译或延迟实测结果。

## 已确定的用户决定

1. 先在用户电脑上的 Codex 开发与运行，暂不部署 Railway 或其他云主机。
2. 现有 Twilio 号码关联的旧系统无需保留其语音接入，可在新服务就绪后改绑；无需再次询问是否允许替换旧语音回调。这不授权删除旧系统数据或其他资源。
3. 目标仍是中文使用者主动呼叫美国电话，中英双向语音翻译，可显示字幕，重点测试真实端到端延迟。
4. 单人通话模式是建议路线，用户正在了解它与 Flex 的区别。尚未据此完成架构选择、开发或验收；不要把原版的 Flex 回调误认为主动拨号功能。
5. 所有共享修改必须提交到这个仓库；密钥和用户私密配置不得提交。

## 先读取并核对共享进度

此前 Work 环境的 GitHub 连接器写文件返回 `403 Resource not accessible by integration`，网页编辑器也加载异常。2026-09-22 用户调整权限后，真实写入已成功，首笔需求文档提交为 `d1ebefe2cb15e2ecaf05a11a2b728aa6726d4238`。当前能力以最新写入与远端核验为准，不再把“只能读取”当成永久限制。

1. 在用户电脑确认当前仓库路径、分支、`git status` 与远端，保留用户本地未提交改动。读取最新的 `AGENTS.md`、`PROJECT_BRIEF.md`、`PROGRESS.md`。
2. 获取远端最新 `main`；`f1021446c3ee760a3c00d9683ec68ff72684a639` 是本轮同步前的基线，不再作为最新提交。确认工作区已包含本批三份共享文档，并保留同期其他开发者的修改。
3. 如果用户带来了 `translation-handoff-20260922.patch`，先检查远端是否已有对应内容。该补丁是写入恢复前准备的备用交接件，包含较旧的同步状态；已经获取本批文档时不要重复应用。不要重复应用此前已合并的 18 项安装/Realtime 代码修改。有冲突时安全整合，不重置用户代码。
4. 使用电脑上已有、正常授权的 Git 工作流提交和推送。若 Git 未认证，通过 GitHub 官方的交互式登录流程处理，不要求把密码或令牌发到聊天里，不创建无限制权限凭据。
5. 核对远端能读取新文档，记录分支、commit 和是否合入 `main`。只有本地 commit 或补丁不能称为“GitHub 已同步”。

## 再核对电脑端实际实现与配置

- 用户已报告有桌面快捷方式，但 Work 环境无法读取电脑文件。先确认快捷方式启动什么程序、对应什么代码目录及版本，避免重复开发。
- 在电脑执行 `npm run check:config`。此脚本仅检查本地值与格式，不联网、不打印密钥；通过不代表 API 真正连通。当前版本仍要求 Flex 变量，不能用虚假 Flex 值绕过检查。
- Work 环境的 7 项必需变量都是占位值；此结论不能推断用户电脑也是相同状态。
- 在电脑的私密运行环境配置真实 OpenAI 与 Twilio 凭据。已有 OpenAI key 若可用可继续使用，不必重复创建；未取得完整密钥时使用可用的受信任安全设置流程，禁止把密钥写进 Git、对话或日志。
- 先验证 Twilio 只读 API 与号码归属，以及 OpenAI Realtime 身份验证、当前模型权限和 `session.updated`。不要把简单 HTTP 200、网页余额或离线测试当成真实语音链路验收。

## 单人模式的建议实现范围（待选择及开发）

基础组合为 Twilio Voice JavaScript SDK 的本地浏览器界面、电脑上的 Node 服务、Twilio Voice/Media Streams，以及 OpenAI Realtime。可以后续用 Electron 或桌面快捷方式封装，不需要因为桌面形态直接引入 Flex。

- 新增拨号、接听/挂断、连接状态和字幕入口；操作入口需要鉴权，不能向公网提供任意人可用的外呼接口。
- 浏览器音频与远端电话分别进入独立语音流，由翻译桥输出给另一方；不得用直接转接原始语音冒充翻译。
- 标准 Voice SDK 路线还需要本账户的 TwiML App、用于签发短期 Access Token 的 API Key/Secret，以及服务器上的 webhook 签名验证。不要将长期密钥发给网页。
- 用唯一通话会话 ID 配对两侧，处理忙线、未接听、拒接、掉线、挂断和重复回调，及时结束对侧通话及 OpenAI 会话，避免留下计费中的电话。
- 配置检查按实际模式区分；单人模式不应继续要求 Flex 号码和 TaskRouter Workflow，但只有其新流程实现后才能移除相应启动依赖。
- 本地服务仍需 Twilio 可访问的公网 HTTPS 回调和 WSS 音频地址，可使用 ngrok 等开发隧道。电脑必须开机联网，地址变化时更新相关回调。暂不云端部署不代表 Twilio/OpenAI 离线运行或免费。

## 真实验收

1. 新服务与公网入口可访问后，再修改已获授权的号码语音回调；主动外呼流程也要配置相应 TwiML App。入站与主动外呼分别验证。
2. 使用用户明确指定的测试号码拨打电话。原来的旧系统号码不能自动当成测试接听对象。
3. 验证中文到英语、英语到中文；测试数字、姓名、长短句、打断以及任一侧挂断。
4. 分别记录从说话结束到另一侧实际听到翻译的时间。模型首音频耗时只是局部指标；不用 Flex 也不能承诺亚秒延迟。
5. 将实际结果、限制和后续工作写入进度文件，提交推送并核验远端。

## 官方参考

- GitHub 连接与写入边界：https://help.openai.com/en/articles/11145903-connecting-github-to-chatgpt
- GitHub 权限错误：https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api
- Flex 定位：https://www.twilio.com/docs/flex/admin-guide/what-is-twilio-flex
- 浏览器电话与 Electron：https://www.twilio.com/docs/voice/sdks/javascript
- 本地 webhook 隧道：https://www.twilio.com/docs/usage/webhooks/getting-started-twilio-webhooks
- Media Streams：https://www.twilio.com/docs/voice/media-streams
