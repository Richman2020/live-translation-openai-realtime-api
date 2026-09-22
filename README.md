#  Live Voice Translation with Twilio & OpenAI Realtime

## 本仓库的项目交接入口

本仓库是 ChatGPT 与电脑端 Codex 共同维护项目的交接来源。开始工作前请阅读：

- [AGENTS.md](AGENTS.md)：共享协作、提交与推送规则，以及运行边界。
- [PROJECT_BRIEF.md](PROJECT_BRIEF.md)：用户目标、当前范围与后续功能。
- [PROGRESS.md](PROGRESS.md)：已完成工作、验证结果、尚未验证的内容与下一步。
- [READINESS_REVIEW.md](READINESS_REVIEW.md)：2026-09-22 本机完整复核、缺失配置、实现限制与真实验收清单。
- [LOCAL_SETUP.md](LOCAL_SETUP.md)：本机安装、私密配置和真实通话测试步骤。

## 本机单人通话版（solo）

仓库现已新增独立的中文通话工作台，使用电脑浏览器、Twilio Voice JavaScript SDK、Twilio 电话线路和 OpenAI Realtime。默认方向为：**我说普通话，对方听英语；对方说英语，我听中文**。本模式不需要开通 Flex，也不需要 Studio 或 TaskRouter；原版 Flex 代码保留在仓库中。

已实现桌面入口、主动拨号、来电接听/拒接、挂断、静音、实际字幕事件、可选本机历史记录、私密配置及手动 API 验证。默认模型为 `gpt-realtime-1.5`，实际账户可用性与翻译效果须联网实测。实现依据是 `src/solo/`、`public/` 与 `scripts/`；界面不会生成假对话或把“配置已填写”当作“通话已接通”。

当前验证包括 Windows 本机编译、离线测试、隔离浏览器界面检查和服务启停。**尚无真实 OpenAI/Twilio API 连通、真实电话或端到端延迟结果**。当前本机供应商凭据尚未配置；最终测试数、具体证据和阻塞见 [PROGRESS.md](PROGRESS.md)。

在仓库目录安装并创建桌面入口：

```powershell
npm ci
npm run setup:local
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-DesktopShortcut.ps1
```

点击桌面「AI 电话」打开；首次供应商配置缺失时会进入设置页。也可运行 `scripts/Start-AIPhone.ps1`；停止用 `scripts/Stop-AIPhone.ps1`，关闭浏览器窗口不等于停止本机服务。已有的「AI 电话（预览）」快捷方式保留为旧预览。

接通顺序是：**启动本机服务 → 在设置页保存私密凭据 → 启动 Cloudflare 临时隧道 → `npm run configure:twilio -- --prepare` → 验证 API 连接 → `npm run configure:twilio -- --apply` → 真实双向电话验收**。`--prepare` 准备 API Key/TwiML App，`--apply` 在再次验证成功后才改绑用户已授权复用的号码。完整命令和每步影响见 [LOCAL_SETUP.md](LOCAL_SETUP.md)。

Twilio/OpenAI 仍需联网。本机界面/API 不对公网开放；隧道提供语音回调和媒体流入口。临时域名变化后必须重新配置。点击「开启通话」注册接听设备，拨号/接听时需要麦克风权限，建议戴耳机。WhatsApp、其他翻译供应商与云端部署尚未实现。

## 上游 Flex 示例（独立保留）

以下英文说明仅适用于原版 Flex/Studio/TaskRouter 模式，使用 `npm run dev` 或 `npm start` 和 `npm run check:config`。其两号码、Flex 和 ngrok 配置不要套到上面的 solo 模式。

This application demonstrates how to use Twilio and OpenAI's Realtime API for bidirectional
voice language translation between a caller and a contact center agent.

The AI Assistant intercepts voice audio from one party, translates it, and speaks the audio in the other party's
preferred language. Use of the Realtime API from OpenAI offers significantly reduced latency that is conducive
to a natural two-way voice conversation.

See [here](https://www.loom.com/share/71498319660943638e1ef2c9928bcd2a) for a video demo of the real time translation app in action.

Below is a high level architecture diagram of how this application works:
![Realtime Translation Diagram](/live-translation-readme-images/realtime-voice-translation-app.jpeg)

This application uses the following Twilio products in conjuction with OpenAI's Realtime API, orchestrated by this middleware application:
- Voice
- Studio
- Flex
- Task Router

Two separate Voice calls are initiated, proxied by this middleware service. The caller is asked to choose their preferred language, then the conversation
is queued for the next available agent in Twilio Flex. Once connected to the agent, this middleware intercepts the audio from both parties via
[Media Streams](https://www.twilio.com/docs/voice/media-streams) and forwards to OpenAI Realtime for translation. The translated audio
is then forwarded to the other party.

## Prerequisites
To get up and running, you will need:
1. A Twilio Flex Account ([create](https://console.twilio.com/user/unified-account/details))
2. An OpenAI Account ([sign up](https://platform.openai.com/signup/)) and [API Key](https://platform.openai.com/api-keys)
3. A second Twilio phone number ([instructions](https://help.twilio.com/articles/223135247-How-to-Search-for-and-Buy-a-Twilio-Phone-Number-from-Console))
4. Node v20.10.0 or higher ([install](https://nodejs.org/en/download/package-manager))
5. Ngrok ([sign up](https://dashboard.ngrok.com/signup) and [download](https://ngrok.com/download))

## Local Setup

There are 3 required steps to get the app up-and-running locally for development and testing:
1. Open an ngrok tunnel
2. Configure middleware app
3. Twilio setup

### Open ngrok tunnel
When developing & testing locally, you'll need to open an ngrok tunnel that forwards requests to your local development server.
This ngrok tunnel is used for the Twilio Media Streams that forward call audio to/from this application.

To spin up an ngrok tunnel, open a Terminal and run:
```
ngrok http 5050
```
Once the tunnel has been initiated, copy the `Forwarding` URL. It will look something like: `https://[your-ngrok-subdomain].ngrok.app`. You will
need this when configuring environment variables for the middleware in the next section.

Note that the `ngrok` command above forwards to a development server running on port `5050`, which is the default port configured in this application. If
you override the `API_PORT` environment variable covered in the next section, you will need to update the `ngrok` command accordingly.

Keep in mind that each time you run the `ngrok http` command, a new URL will be created, and you'll need to update it everywhere it is referenced below.

### Configure middleware app locally
1) Clone this repository
2) Run `npm install` to install dependencies
3) Run `cp .env.sample .env` to create your local environment variables file

Once created, open `.env` in your code editor. You are required to set the following environment variables for the app to function properly:
| Variable Name     | Description                                      | Example Value          |
|-------------------|--------------------------------------------------|------------------------|
| `NGROK_DOMAIN` | The forwarding URL of your ngrok tunnel initiated above | `[your-ngrok-subdomain].ngrok.app` |
| `TWILIO_ACCOUNT_SID` | Your Twilio Account SID, which can be found in the Twilio Console. | `ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` |
| `TWILIO_AUTH_TOKEN`  | Your Twilio Auth Token, which is also found in the Twilio Console.  | `your_auth_token_here`  |
| `TWILIO_CALLER_NUMBER`   | The additional Twilio phone number you purchased, **not** connected to Flex. Used for the caller-facing "leg" of the call. | `+18331234567` |
| `TWILIO_FLEX_NUMBER`   | The phone number automatically purchased when provisioning your Flex account. Used for the agent-facing "leg" of the call. | `+14151234567` |
| `TWILIO_FLEX_WORKFLOW_SID` | The Taskrouter Workflow SID, which is automatically provisioned with your Flex account. Used to enqueue inbound call with Flex agents. To find this, in the Twilio Console go to TaskRouter > Workspaces > Flex Task Assignment > Workflows  |`WWXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`|
| `OPENAI_API_KEY`              | Your OpenAI API Key             | `your_api_key_here`                 |

Below are optional environment variables that have default values that can be overridden:
| Variable Name     | Description                                      | Default Value          |
|-------------------|--------------------------------------------------|------------------------|
| `FORWARD_AUDIO_BEFORE_TRANSLATION` | Set to `true` to enable forwarding the original spoken audio between callers. For instance, if Caller is speaking Spanish, this would play the original Spanish audio for the Agent before the translated audio is played. This setting is useful in production contexts to minimize perceived silences. Not recommended for development mode where one person will be simultaneously playing the role of the caller and the agent.     | `false`                 |
| `API_PORT`        | The port your local server runs on.             | `5050`                 |

### Twilio setup

#### Import Studio Flow
You'll need to import the included Studio flow in the [inbound_language_studio_flow.json](inbound_language_studio_flow.json) file into your Twilio Account, then configure the caller-facing Twilio phone number to use this Flow. This Studio Flow will handle the initial inbound call, and present the caller with a basic IVR to select their preferred language to use in the conversation with the agent.

In the Twilio Console, go to the [Studio Flows](https://console.twilio.com/us1/develop/studio/flows?frameUrl=%2Fconsole%2Fstudio%2Fflows%3Fx-target-region%3Dus1) page and click **Create New Flow**. Give your Flow a name, like "Inbound Translation IVR", click Next, then select the option to **Import from JSON** and click Next.

Copy the contents of [inbound_language_studio_flow.json](inbound_language_studio_flow.json) and paste it into the textbox. Search for `[your-ngrok-subdomain]` and replace with your assigned ngrok tunnel subdomain. Click **Next** to import the Studio Flow, then **Publish**. 

The included Studio Flow will play a prerecorded message for the caller asking them to select their preferred language as either:
1. English
2. Spanish
3. French
4. Mandarin
5. Hindi

You can update the Studio Flow logic to change the languages you'd like to support. See [here](https://platform.openai.com/docs/guides/text-to-speech/supported-languages) for more information on OpenAI's supported language options. 

#### Point Caller Phone Number to Studio Flow
Once your Studio Flow is imported and published, the next step is to point your inbound / caller-facing phone number (`TWILIO_CALLER_NUMBER`) to your Studio Flow. In the Twilio Console, go to **Phone Numbers** > **Manage** > **Active Numbers** and click on the additional phone number you purchased (**not** the one auto-provisioned by Flex).

In your Phone Number configuration settings, update the first **A call comes in** dropdown to **Studio Flow**, select the name of the Flow you created above, and click **Save configuration**.
![Point Caller Phone Number to Studio Flow](/live-translation-readme-images/inbound-voice-number-webhook.png)

#### Point Agent Phone Number and TaskRouter Workspace to Middleware
The last step is to point the agent-facing phone number (`TWILIO_FLEX_NUMBER`) and the TaskRouter "Flex Task Assignment" Workspace to this middleware app. This is needed to connect the conversation to a contact center agent in Flex.

In the Twilio Console, go to **Phone Numbers** > **Manage** > **Active Numbers** and click on Flex phone number that was auto-provisioned. In your Phone Number configuration settings, update the first **A call comes in** dropdown to **Webhook** and set the URL to `https://[your-ngrok-subdomain].ngrok.app/outbound-call`, ensure **HTTP** is set to **HTTP POST**, and click **Save configuration**.
![Point Agent Phone Number to Middleware]/live-translation-readme-images(/flex-voice-number-webhook.png)

Ensure that you replace `[your-ngrok-subdomain]` with your assigned ngrok tunnel subdomain.

Then, go to **TaskRouter** > **Workspaces** > **Flex Task Assignment** > **Settings**, and set the **Event callback URL** to `https://[your-ngrok-subdomain].ngrok.app/reservation-accepted`, again replacing `[your-ngrok-subdomain]` with your assigned ngrok tunnel subdomain.

![Point TaskRouter Workspace to Middleware](/live-translation-readme-images/task-router-event-callback-url.png)

Finally, under **Select events**, check the checkbox for **Reservation Accepted**.

![Select events > Reservation Accepted](/live-translation-readme-images/task-router-reservation-accepted.png)

### Run the app
Once dependencies are installed, `.env` is set up, and Twilio is configured properly, run the dev server with the following command:
```
npm run dev
```
### Testing the app
With the development server running, you may now begin to test the translation app. If you are wanting to test the app by yourself, simulating both the agent and the caller, we recommend setting `FORWARD_AUDIO_BEFORE_TRANSLATION` to `false` so you're not hearing duplicative audio.

To answer the call as the agent, you'll need log into the Flex Agent Desktop. The easiest way to do this is go to the [Flex Overview](https://console.twilio.com/us1/develop/flex/overview) page and click **Log in with Console**. Once the Agent Desktop is loaded, be sure that your Agent status is set to **Available** by toggling the dropdown in top-right corner of the window. This ensures enqueued tasks will be routed to you.

With your mobile phone, dial the `TWILIO_CALLER_NUMBER` and make a call (Do **not** dial the `TWILIO_FLEX_NUMBER`). You should hear a prompt to select your desired language, and then be connected to Flex. On the Flex Agent Desktop, once a language preference is selected, you should see the call appear as assigned to you. Use Flex to answer the call.

Once connected, you should now be able to speak on one end of the call, and hear the OpenAI translated audio delivered to the other end of the call (and vice-versa). By default, the Agent's language is set to English. The Realtime API will translate audio from the chosen caller language to English, and the agent's English speech to the chosen caller language.

## OpenAI Realtime API Settings
### Updating Model Instructions
You can update the instructions used to prompt the OpenAI Realtime API in [`src/prompts.ts`](/src/prompts.ts). Note that there are two separate connections to the Realtime API, one for the caller, and one for the agent. This allows for more precision and flexibility in the way the translator behaves for both sides of the call. Note that `[CALLER_LANGUAGE]` is dynamically inserted into the prompt based on the caller's language selection during the initial Studio IVR. The default behavior assumes the agent speaks English.

To change the prompt for the caller, update `AI_PROMPT_CALLER`. For the agent, update `AI_PROMPT_AGENT`. The default instructions used for translation are below:

**Caller**
```
export const AI_PROMPT_CALLER = `
You are a translation machine. Your sole function is to translate the input text from [CALLER_LANGUAGE] to English.
Do not add, omit, or alter any information.
Do not provide explanations, opinions, or any additional text beyond the direct translation.
You are not aware of any other facts, knowledge, or context beyond translation between [CALLER_LANGUAGE] and English.
Wait until the speaker is done speaking before translating, and translate the entire input text from their turn.
Example interaction:
User: ¿Cuantos días hay en la semana?
Assistant: How many days of the week are there?
User: Tengo dos hermanos y una hermana en mi familia.
Assistant: I have two brothers and one sister in my family.
`;
```
**Agent**
```
export const AI_PROMPT_AGENT = `
You are a translation machine. Your sole function is to translate the input text from English to [CALLER_LANGUAGE].
Do not add, omit, or alter any information.
Do not provide explanations, opinions, or any additional text beyond the direct translation.
You are not aware of any other facts, knowledge, or context beyond translation between English and [CALLER_LANGUAGE].
Wait until the speaker is done speaking before translating, and translate the entire input text from their turn.
Example interaction:
User: How many days of the week are there?
Assistant: ¿Cuantos días hay en la semana?
User: I have two brothers and one sister in my family.
Assistant: Tengo dos hermanos y una hermana en mi familia.
`;

```
## Sequence Diagram

The eventual flow of the application is as follows. 
- In this diagram, `Voice/Studio` has colloquially been used to represent the Twilio Voice and Studio.
- The `Agent` represents the human agent who will be connected to the call via Twilio Flex.

```mermaid
sequenceDiagram
    actor Customer
    participant Voice/Studio
    participant BMV
    participant S2S
    actor Agent

    Customer ->> Voice/Studio: Initiates Call
    Voice/Studio -->> Customer: <Say>Welcome to Be My Voice.<br>Your call will be transferred to an AI Assistant.<br>What language would you like to use?</Say><br><Gather ...>
    Customer -->> Voice/Studio: (Customer selects language)
    
    Voice/Studio ->> +BMV: [HTTP] POST /incoming-call
    BMV -->> -Voice/Studio: <Say>...</Say><br><Connect><Stream ... /></Connect>
    Voice/Studio -->> Customer: <Say>Please wait while we connect you.</Say>
    
    Customer ->> +BMV: [WS] Initiate Media Stream
    activate Customer
    activate BMV
    activate S2S
    BMV ->> +S2S: [WS] Establish Websocket Connection to OpenAI

    BMV ->> Voice/Studio: [HTTP] Create Call (to Agent)<br>with TwiML <Connect><Stream ... /></Connect>
    Voice/Studio -->> Agent: Incoming Task
    Agent ->> BMV: [WS] Establish Websocket Connection
    activate Agent
    Agent ->>+ BMV: [HTTP] Accept Task
    BMV -->>- Agent: Ok 200
    note right of BMV: BMV is now intercepting both <br>Agent and Customer Media Stream
    note right of BMV: For every Media that comes, stream the data to S2S<br>and stream the response back to Agent/Customer
    note right of BMV: For example, it may look something like
    
    loop A conversation loop
    Customer ->> BMV: [WS] (Speaks in their language)
    BMV ->> S2S: [WS] Stream audio in original language
    S2S -->> BMV: [WS] Audio stream in English
    BMV ->> Agent: [WS] Steam audio to Agent in English
    Agent -->> BMV: [WS] (Replies in English)
    BMV ->> S2S: [WS] Stream audio in English language
    S2S -->> BMV: [WS] Audio stream in original language
    BMV ->> Customer: [WS] Stream audio to Customer in original language
    end 


    note right of BMV: At some point, the conversation over<br>and the Customer hangs up
    BMV -->> Customer: [WS] Close
    deactivate Customer

    BMV -->> S2S: [WS] Close
    deactivate S2S
    BMV -->> Agent: [WS] Close
    deactivate BMV
    deactivate Agent
