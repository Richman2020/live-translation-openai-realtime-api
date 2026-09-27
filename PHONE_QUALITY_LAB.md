# 连续翻译准确度与固定声音实验

本轮实现两个隔离实验：同一份声音比较 OpenAI 连续翻译的输入降噪，和用已核对译文比较 ElevenLabs 固定声音。电话服务不加载这些实验脚本；号码、回调、默认引擎和真人通话录音设置均不变。本人声音克隆和电话候选接入分别在后续验收。

**2026-09-27 后续决定**：用户要求先限定现有电脑、无新增硬件支出，已批准优先验证开源 RVC 的本机承载能力。下文 ElevenLabs 部分保留为已实现原型的操作记录，不代表当前要继续开通或调用付费服务。新的环境、实测与边界见 [RVC 硬件验证](RVC_HARDWARE_CHECK_2026-09-27.md)。

所有命令从仓库根目录执行。原声、译文事件、模型输出、电话转码输出和私密报告只能留在已忽略的 `.runtime/`，不要加入 Git。只有脱敏结果和实验程序进入共享仓库。

## 1. 准备相同输入

固定稿件为 [V1 十二句与两段长讲话](PHONE_TEST_V1.md)，机器可读版本在 `tests/fixtures/phone-quality-v1.json`。中文六短一长、英文六短一长，每个条件各重复三遍，共 84 个独立会话。

### 真人素材（正式质量评估需要）

在电话服务运行时打开 <http://127.0.0.1:5050/quality-capture.html>。这是一张独立本机页面，不会拨号，也不会自动上传录音。

1. 使用耳麦，关闭手机免提及其他外放。参与者阅读并勾选测试用途同意后，才能点击录制。
2. 按正常速度、正常音量逐条读稿。录制时核对页面显示的实际麦克风名称；若不是预期设备，先更改浏览器/系统默认输入，再重录。这里使用浏览器默认输入，不继承电话工作台的设备选项。
3. 每句停止后先本机试听；录音最多 60 秒，过短/过静会拒绝。离页、停止、权限失败、设备断开均释放采音；设备断开时不保存残缺句。
4. 全部 14 条录完后导出 JSON。刷新或关闭页面会清除内存录音。只下载文件不会调用供应商。
5. 导入到一个新的私密目录：

```powershell
npm run quality:import -- --input "C:\Users\admin\Downloads\phone-quality-recordings-实际时间.json" --out .runtime/quality-check/human-source
```

导入器验证用途标志、格式、14 个唯一稿件 ID、PCM 长度与能量，写出试听 WAV、8 kHz μ-law 和 manifest。它不会读取密钥或联网。浏览器采音请求 AEC、降噪、自动音量，再经浏览器低通重采样至 8 kHz；后续矩阵只改变**供应商输入降噪**，不会把浏览器采音处理误称为原始环境未处理音频。

### 合成素材（先验证实验及发现部分问题）

没有真人录音时，可使用本机 Windows Speech 生成同一稿件，不调用付费语音 API：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Prepare-PhoneQualityFixtures.ps1 -OutputDirectory .runtime/quality-check/synthetic-source
```

需要 Windows PowerShell 5.1、Microsoft Huihui Desktop 与 Zira Desktop。缺声音时明确失败；不替换成其他发音后称同素材对照。输出 manifest 标记 `synthetic`，合成声结果不能替代口音、耳麦和真实环境验收。

## 2. 连续翻译降噪对照

先检查计划，不读取密钥、不联网、不写结果：

```powershell
npm run quality:continuous -- --manifest .runtime/quality-check/synthetic-source/manifest.json --out .runtime/quality-check/synthetic-results --repeat 3 --dry-run
```

确认素材后，移除 `--dry-run` 执行。实际运行复用本项目 `.env` 内已有 OpenAI 密钥和代理设置，会产生 API 用量。每次只开一个会话，无自动重试；默认 84 次。需要先查单句时加 `--case 05 --repeat 1`，必须使用新的输出目录。

- 引擎 `gpt-realtime-translate`；条件 `off`（null）与 `near_field`，严格核对服务端回读。
- 同一稿件先读入内存、计算 SHA-256，所有重复复用相同字节；条件顺序交错，避免固定每次先关后开。
- 输入按 20 ms 实时帧发送，前加 300 ms 静音、后加 4 s 静音，再请求完成并等待服务端排空。不截掉输出静音以制造速度成绩。
- 单条输入最多 60 秒、会话最多 100 秒、原始输出最多 120 秒。发送调度严重落后、协议/传输/格式错误会保存失败并停止整组。服务已正常排空但返回零音频则保留为 `NO_CONTINUOUS_AUDIO` 质量失败，继续其他组合；不重复请求或丢掉失败样本。
- 每条保存 `input-8k.wav`、`input.pcmu`、含前后静音的 `sent-input.pcmu`、模型 `provider-24k.wav`、转码后的 `phone-8k.wav` / `phone.pcmu`，以及私密事件报告。
- `summary.json` 逐条更新。`completed` 只表示正常结束；不能据此宣布声音存在、翻译准确、没有换声或延迟验收通过。

受控中断后，先查明错误，再用新目录显式续跑。不会覆盖旧结果或重新请求已尝试项：

```powershell
npm run quality:continuous -- --manifest .runtime/quality-check/synthetic-source/manifest.json --out .runtime/quality-check/synthetic-resumed --repeat 3 --resume-from .runtime/quality-check/synthetic-results --dry-run
# 预检确认保留/剩余数量后，移除 --dry-run 执行
```

续跑会检查全部计划、输入哈希、旧报告及音频，只接受连续完整的已尝试前缀，并将其原样复制到新目录。协议/连接错误不走此续跑入口，须先诊断再明确安排新的实验。新请求前写 `inflight.private.json`，只有结果与汇总落盘后才清除；若异常退出遗留标记，拒绝自动重做未知请求。整批结束但包含失败时仍返回非零退出码，不能因此重跑整批；先看 `completedMatrix`、`hasFailures` 与具体报告。

生成本机试听页：

```powershell
npm run quality:review -- --input .runtime/quality-check/synthetic-results
```

用浏览器打开结果目录的 `review.html`，按每句的重复次数、降噪开关依次比较输入、模型输出、电话转码后输出。没有运行/失败的条目也保留；需要重新生成时显式加 `--force`。页面没有外部脚本或上传功能，只读同目录音频。

### 真人录音前后有停顿时的离线时间分析

录制按钮的起止不等于实际讲话起止。先保留整份音频，再离线计算按输入持续能量对齐的辅助时间，避免将等待开口或停止录制前的空白算成模型延迟：

```powershell
npm run quality:analyze -- --input .runtime/quality-check/human-results --out .runtime/quality-check/human.analysis.private.json
```

该命令不读取密钥、不联网、不改音频或原始报告。输出须在同一仓库 `.runtime/` 内、矩阵目录之外，名称以 `.analysis.private.json` 结尾且不能已存在，以保持原矩阵的安全续跑兼容性。

主口径按 20 ms 帧、RMS 300，桥接至多 120 ms 的低能量间隔，并要求累计至少 100 ms 高于阈值。短瞬态另行保留，附 RMS 100/1000 的敏感性结果，避免把弱尾音消失误当成提前结束。逐条核对输入哈希、重算电话格式音频的理想 FIFO，与原报告匹配后才计算对齐时间；无能量、失败、未排空或证据不一致的样本不计有效等待。

报告分别给出输入开始到首个输出能量、输入结束到首个输出能量，以及输入结束到最后输出能量。第二项适合辅助查看短句“停说后多久开始出声”；长讲话可能在输入结束前已输出，负值原样保留，不能单凭负值判定成功。

这些是**能量边界与理想 FIFO 辅助指标**，不是词语对齐、真实手机播放或人耳延迟。长讲话持续跟随、实际译意、声线和尾句完整性仍须单独验收。`completedMatrix` 只说明结果记录齐全；正在运行的快照、失败和缺失项都显式列出，不能当作质量通过。

### 单独检查纯静音

```powershell
npm run quality:silence -- --out .runtime/quality-check/silence-results --dry-run
# 实际调用供应商时移除 --dry-run
```

固定 8 秒数字静音，英文/中文目标各开关降噪一次，共 4 次；同样有前后缓冲。仅服务正常排空后，检查译文是否非空、原始/电话音频是否有超过 300 RMS 的 20 ms 帧。发现任一活动记 `FAIL`，传输或排空未确认记 `INCONCLUSIVE` 并停止。没有活动只记 `SYNTHETIC_SILENCE_NO_ACTIVITY`，不代表真实房间背景声、回声或正常讲话均已验收。

## 3. ElevenLabs 固定声音原型

独立脚本只将已核对的 `expectedTranslation` 发给合成接口，**不会拿连续模型的临时字幕自动朗读，也不会纠正原翻译错误**。使用 `eleven_flash_v2_5`、`ulaw_8000`、固定 `voice_id`，英文/中文方向可以分别指定现有声音。没有创建或克隆声音接口。

在本机私密 `.env` 中补充以下变量，或由当前进程环境提供；不要在聊天、源码或 Git 中填写密钥：

```dotenv
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID_EN=
ELEVENLABS_VOICE_ID_ZH=
```

声音编号从本人账户可用声音中选择，模型/语种/输出格式权限以实际账户请求为准。缺配置会生成 `BLOCKED` 报告、零供应商请求，不能称 API 已接通。

本机没有 ElevenLabs 配置时，可使用独立的一次性保存页面；无需重启电话服务：

```powershell
node --import tsx scripts/configure-fixed-voice-local.ts
```

打开命令输出的临时本机链接，将专用密钥填入密码框，可同时填写两方向声音编号。页面只监听 `127.0.0.1`，10 分钟到期，成功保存后关闭；限制字段、来源和请求体，密钥不回显、不写请求日志。配置写入 Git 忽略的 `.env`，保留其他字段及现有私密文件权限；已有非空值不允许被不同值覆盖。链接是临时本机访问凭证，不应转发。该入口不会创建供应商密钥、购买套餐或发起合成请求。已有电话连接设置页仍只处理原有电话配置。

```powershell
# 准备 42 次请求计划；不读取凭据、不联网，会写私密计划报告
npm run quality:voice -- --dry-run
# 配置后先检查一个英文样本，再检查一个中文样本
npm run quality:voice -- --case 01 --repeat 1
npm run quality:voice -- --case 02 --repeat 1
# 两向能正常合成后，再运行完整固定稿各三遍
npm run quality:voice -- --repeat 3
```

输出位于 `.runtime/fixed-voice-lab/时间-随机标识/`，包含 WAV、μ-law、事件和 `report.json`。最多 42 次请求、12,000 字符、整批 15 分钟，每条 60 秒；错误即停止，不隐式重试。WebSocket 合成对文本全量提交后开始计时，因此这里只验证固定声音与流式音频输出，尚未实现增量文本的提交策略。

记录连接、文本提交、第一块到达、第一块超过能量阈值的音频到达和完成时间。厂商模型时间、TTS 首包和真实电话听到声音是不同指标：`phoneAddedLatency` 在本实验中始终为 `UNKNOWN`，不把首包小于 300 ms 标成电话门槛已通过。

实现依据：[ElevenLabs WebSocket 指南](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts)、[官方流式接口](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input)。

## 4. 共同验收与后续门槛

| 要验证的事情 | 本轮证据与判定方法 |
| --- | --- |
| 输入完整、正常音量清楚 | 先听同一条源声；“今天”在输入里是否已模糊不能靠稿件假定 |
| 意义准确 | 听实际模型译音，检查否定、数字、人名、日期、疑问语气和长段尾句；文本事件只辅助定位 |
| 转码影响 | 同条 24 kHz 原始译音与 8 kHz 电话译音成对听；若原始已经错，电话转码不能修正其含义 |
| 声线稳定 | 同方向同一 voice_id 的三遍和长段试听；固定参数不等于已通过人耳稳定性验收 |
| 安静不加话 | 独立纯静音控制已实现，真实静环境仍需录音对照；语句后缓冲静音不等于独立安静验收 |
| 等待 | 分首次有效译音、连续跟随和尾部等待，匹配相同输入及相同播放路径；服务事件/理想 FIFO 是辅助指标 |
| 固定声音新增等待 | 中位不超过 300 ms 是下一阶段筛选目标；本轮无匹配电话基线，不提前填写成绩 |

正式记录每个样本的“含义通过/失败/听不清”“完整性”“声线切换”“等待口径”，不要用字面完全匹配率代替翻译准确度。未听或不确定记待验收。

只有固定声音效果和实际新增等待共同通过，再准备本人专用声音样本、创建本人克隆并由本人确认英语小样；对方英语转中文先用固定声音。最后独立实现可切换的电话候选路径，保留旧版对照。录音素材不足、供应商账户未准备或质量不达标均写明阻塞，不把原型写成真人电话完成。
