# 阿里云一次性最小试听入口

基线：`108f22b70f327bb7b73cf67577741e711d1b0dc1`。本轮仅独立脚本、离线测试和专属资料；没有生产接线、安装、推送、部署、录音上传或模型调用。原OpenAI默认、Plan B默认关闭，线上及已停止portal-test不操作。旧OpenAI一美元试听已执行，授权不可复用。

## 型号、地域与选择

固定 `fun-asr-realtime` → `qwen-mt-flash` → `cosyvoice-v3-flash / loongandy_v3`。Fun-ASR普通实时型号支持中英和24k PCM、正式原文context，因此适配现有桥接与双向识别；不使用仅中文的 `fun-asr-flash-8k-realtime`。本方中文→确定英文文字及同文配音；对方英文→中文字幕，无中文配音。固定参数不代表实际男声听感已通过。

本项目仅实现北京、新加坡。此次推荐北京：同一套固定型号公价较低且支持TTS服务端取消；不保证当前云端网络延迟最小。模型地域及音色来源：[Fun-ASR](https://help.aliyun.com/en/model-studio/fun-asr-realtime)、[音色表](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)。

## 真正可运行的独立入口

使用与本项目lock匹配的已有依赖、Node≥20.10.0。没有新增npm脚本或生产配置。将用户确认的短录音放入新的资料目录，以相对路径填写清单：

```json
{
  "version": 1,
  "region": "beijing",
  "clips": [
    {
      "id": "zh-appointment",
      "role": "local",
      "wav": "zh-appointment.wav",
      "sha256": "替换为实际64位小写SHA256",
      "speechEndMs": 4000
    },
    {
      "id": "en-confirmation",
      "role": "remote",
      "wav": "en-confirmation.wav",
      "sha256": "替换为实际64位小写SHA256"
    }
  ]
}
```

这是格式示例，不是可冒充录音或批准的占位清单。仅真实存在、哈希匹配、mono/PCM16/24k、至少中英各一的清单才通过。原文和参考英文不放在清单中。最多4个clip、累计24秒含静音、路径不能逃出资料目录，不读symlink/FIFO。

```bash
# 项目根目录，默认仅离线：不读密钥、不连供应商。
node --import tsx scripts/aliyun-audition.mts --manifest /绝对路径/试听资料/input.json
```

之后明确得到新授权、配置生效且preflight成功，才创建严格批准回执（见CLI schema）并执行一次：

```bash
# 仅未来获准后；当前不得执行本行。
node --import tsx scripts/aliyun-audition.mts --manifest /绝对路径/试听资料/input.json --run --approval /绝对路径/试听资料/aliyun-approval.json --out /绝对路径/试听结果新目录
```

批准文件必须绑定本次region、清单哈希、各录音哈希、三个固定型号、voice、人民币新金额≥1、dataSendApproved/executeOnce和新用户批准引用；未知字段及旧OpenAI/USD批准拒绝。文件是已有聊天授权的执行记录，不产生授权。使用当前Git common-dir中的单次spent锁，同仓库不同工作树及复制清单到另一资料目录仍不复用，失败也不自动重试。跨机器接力需携带已消费回执并核对授权历史，不能将本地锁称为账户全局或账单硬限制。输出目录必须新建且预检可写，不覆盖旧音频或回执。key只从选择地域的运行环境读取，不操作秘密或平台设置；脚本不改变服务供应商选择。

## 限量、停止和完整等待记录

- 输入合计≤24秒，最多4个ASR任务、8次确定稿MT、4次英文TTS；TTS累计提交≤2000字符；每MT请求正式 `max_tokens=2048`。先预留计数/字符再请求，触发限量、错误、超时或取消便停止整个试听，不换区/模型/voice、不重试重连。
- PCM每20ms按实时速度发送，不一次性极速灌入。供应商在clip中给final即进入顺序翻译/配音；不等待全部录音结束。不人为把partial当final，未定稿等待和finish后的结果另记，持续长句不因此被宣称低延迟。
- 此入口为限量诊断，**仅翻译确定稿，不对partial重复MT**；真实电话的临时字幕修订可能产生更多文字请求，该差异不能用于推算生产费用或字幕实时体验。
- 记录每源原文/revision、近期原文来源ID和实际译文，人工核对CURRENT_SOURCE是否被正确独立翻译及历史是否重复。Qwen-MT仍单user自定义提示，实际遵循不能由mock证明。更正发生在已发声之后只单列证据，不悄改/重播旧声音。
- 时间分项为原句末端→收到ASR final、排队→MT请求、MT完成、TTS请求→first PCM，以及原句末端→首个可播放音频。人工speechEndMs、供应商VAD endAt和未标注的文件末样本分开，缺有效终点标未知。首个PCM不是用户实际听到；脚本不自动播放，最终下载WAV需用户试听。
- 超时/取消停止收音与发送、取消MT、终止ASR/TTS、阻断迟到事件。整体90秒只约束独立试听，未增加生产通话时限。最多接收36秒输出是本地观察和终止边界，供应商已生成但未接收/播放的内容仍可能收费，不能声称账单封顶。

## 发给阿里的数据与交付

只发送已新批准的选中音频PCM、ASR language_hint和同方近期确认原文；文字翻译发送实际ASR当前原文、有界近期双方原文及固定忠实翻译指令；配音只发送本方确定英文译文、固定模型和voice。不会发送参考答案、Twilio数据、完整号码、真实通话录音或其他未选文件。鉴权使用安全环境key，不进入报告。

完成后的新结果目录保存英文WAV、逐段真实原文/译文、终点及延迟分项、分类usage、按公开价推算费用。缺usage标未知/待核；usage估算不能等同实际入账。失败也保存已发生计数与已知用量，不自动补跑。

## 费用预留和现在的阻塞

2026-10-14官方人民币按量价格：[价格页](https://help.aliyun.com/zh/model-studio/model-pricing)。北京/新加坡分别：ASR每秒¥0.00033/0.00066；MT每百万输入tokens¥0.7/1.174、输出¥1.95/3.596；TTS每万输入字符¥1/0.9541。ASR与TTS分别按音频秒数和提交字符计，不再重复加音频token费用。

预留：24秒ASR + 200000 MT输入tokens（含多次重复上下文及指令，估计）+ 8×2048输出tokens（请求参数合计）+ 2000TTS字符。北京约 **¥0.37987**，新加坡约 **¥0.50038**；建议独立批准 **人民币¥1**，余量分别约¥0.62013/¥0.49962。200000是保守预留而非供应商硬输入限制；max_tokens发出不代表本轮真实服务已接受。若账户美元结算，先核账户美元费率，不自行换汇。此前OpenAI$1不可复用。

当前没有新样本发送/金额批准、适合完整验证的英文样本或手工语音结束标注；环境metadata没有阿里key绑定且未放行DashScope域。原21.097秒WAV格式可用但发送阿里未授权。没有付费连通探测、读取key值或网络绕过。

## 用户配置官方页面和下一步

1. 用户登录 [百炼](https://bailian.console.aliyun.com/)，本人按页面完成已有账号开通/实名认证；选择北京，查看 [模型列表](https://bailian.console.aliyun.com/cn-beijing/model/market) 中三个精确型号，只看权限，不点体验或发送示例。
2. [北京API Key](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)，优先复用该地域已有授权key。缺key时由用户本人创建，按界面缩到所需三模型，不向聊天发key，不使用云AccessKey ID/Secret。新加坡对应 [模型列表](https://bailian.console.aliyun.com/ap-southeast-1/model/market)、[API Key](https://bailian.console.aliyun.com/ap-southeast-1/model/settings/api-key)。[官方Key步骤](https://help.aliyun.com/zh/model-studio/get-api-key)
3. 用户在Codex安全环境配置 `ALIYUN_BEIJING_API_KEY`（或对应新加坡变量），目标域仅 `dashscope.aliyuncs.com`（或 `dashscope-intl.aliyuncs.com`），发布配置并让执行任务使用它；不改Railway。下一执行任务须核验current/ready和网络enforced，不以变量名存在称可用。
4. 准备 [待录稿](ALIYUN_MINIMAL_AUDITION_READING_SCRIPT_2026-10-14.md) 的合法短中文/英文样本；收到实际文件后生成哈希清单、离线预检。用户明确同意这批样本发送阿里并批准新的人民币¥1（或重新核定金额）后，才进行上述一次命令。

本轮最终SHA和离线结果由候选回执绑定；真实模型接入、男声听感、上下文/数字否定准确性、长句首音及实际账单全部待后续试听。
