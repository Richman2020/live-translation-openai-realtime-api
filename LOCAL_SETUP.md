# 在电脑上的 Codex 中安装运行

仓库：<https://github.com/Richman2020/live-translation-openai-realtime-api>

开始前先阅读 [AGENTS.md](AGENTS.md)、[PROJECT_BRIEF.md](PROJECT_BRIEF.md) 和 [PROGRESS.md](PROGRESS.md)。当前交接分支、同步情况和各环境的验证结果以 `PROGRESS.md` 及远端实际提交为准；不要仅凭旧聊天中的安装说明判断进度。

这是 Twilio 通话翻译的后端中间服务，操作通话需要 Twilio Flex。它目前不是独立桌面拨号软件。代码放入 GitHub、安装依赖或编译成功，都不代表真实电话链路已接通。

## 1. 安装依赖与创建本地配置

安装 Git 和 Node.js；项目最低版本为 Node 20.10.0，建议本次安装使用 Node 24 LTS。

在电脑上用 Codex 打开项目文件夹。第一次下载时执行：

```sh
git clone https://github.com/Richman2020/live-translation-openai-realtime-api.git
cd live-translation-openai-realtime-api
```

确认当前分支已经包含本指南所对应的安装脚本；若交接记录指定了开发分支，先检出该分支，再执行：

```sh
npm ci
npm run setup:local
```

如果已经下载了项目，先由 Codex 检查并保留本地修改，再获取和整合远端更新；不要覆盖本机已有的桌面程序或快捷方式相关代码，也不要重复应用已经合入的旧补丁。`setup:local` 仅在 `.env` 不存在时复制模板，保留已有配置。命令适用于 Windows、macOS 和 Linux。

## 2. 填写私密配置

在本机编辑器中打开 `.env`，填入自己的 OpenAI API 密钥、Twilio Account SID/Auth Token、两个不同的 Twilio 电话号码、Flex Workflow SID，以及 ngrok 域名。

密钥应只保存在本机 `.env` 或运行环境的私密变量中，不要发到聊天、写进源代码或提交到 GitHub。创建 OpenAI 密钥不会自动将它配置到本机 Codex。

保留 `NODE_ENV=development`、`API_PORT=5050`，测试时保留 `FORWARD_AUDIO_BEFORE_TRANSLATION=false`。

`OPENAI_REALTIME_MODEL` 默认使用 `gpt-realtime-1.5`。此版本已将旧 Beta 会话配置和音频事件迁移至 GA 格式，并等待 OpenAI 确认会话配置后再传入音频。两条音频流仍使用 Twilio 的 G.711 μ-law 编码。模型是否可用、实际翻译效果和费用需要用自己的账户验证。

安装并登录 ngrok，在另一个终端运行：

```sh
ngrok http 5050
```

将 ngrok 显示的公网地址的**主机名**填入 `NGROK_DOMAIN`，不要带 `https://`、路径或末尾斜杠。例如公网地址是 `https://abc123.ngrok.app`，配置中填写 `abc123.ngrok.app`。

## 3. 完成 Twilio 配置，再启动

按顺序完成原版 [README 的 Twilio setup](README.md#twilio-setup)：

1. 导入 `inbound_language_studio_flow.json`，将其中的 ngrok 地址改成自己的地址并发布。
2. 将 `TWILIO_CALLER_NUMBER` 对应号码的来电处理设为刚发布的 Studio Flow。
3. 将 `TWILIO_FLEX_NUMBER` 的来电 Webhook 设为 `https://自己的域名/outbound-call`（POST），将 TaskRouter Workspace 的 Event callback URL 设为 `https://自己的域名/reservation-accepted`，订阅 Reservation Accepted 事件。

每次 ngrok 公网域名变化，都要同步修改 `.env` 和上述三处回调地址。根据仓库 `AGENTS.md`，Twilio 配置完成且 ngrok 正在运行后，才启动真实应用。

先检查本地配置并编译：

```sh
npm run check:config
npm run build
npm test
```

`check:config` 只输出变量名及是否缺失、占位符、格式错误等状态，不输出值、不联网、不验证账户余额或远端权限。状态有误时返回非零退出码；全部通过仍需要完成 Twilio 配置和实测。

`npm test` 使用内存中的模拟音频连接验证双向转发、会话就绪和挂断边界，不连接任何付费 API。`npm run dev` 和 `npm start` 都先运行配置检查；未填写的示例配置会阻止启动。

配置完成后启动：

```sh
npm run dev
```

## 4. 验证双向通话

打开 Twilio Flex Agent Desktop，将坐席状态设为 **Available**。用手机拨打 `TWILIO_CALLER_NUMBER`，选择普通话（Mandarin），再在 Flex 接听任务。不要拨打 `TWILIO_FLEX_NUMBER` 来测试。

分别验证中文到英文、英文到中文，记录说话结束到对方实际听见翻译的延迟，并测试短句、长句、打断和连续通话。只有真实语音测试通过后，才能判断通话链路及延迟表现。

这个原版流程由用户拨入 Twilio 号码并由 Flex 接听；直接输入美国客户号码向外拨号、中文操作页、字幕及 WhatsApp 接入仍需另行实现。

## 当前安装的边界

当前工作尚不代表部署或接通电话。缺少私密配置或未完成 Twilio/ngrok 配置时，可以安装、编译和检查代码，但不能声称已经接入 API 或通过真实通话测试。配置检查不会创建、购买或修改任何远端资源。
