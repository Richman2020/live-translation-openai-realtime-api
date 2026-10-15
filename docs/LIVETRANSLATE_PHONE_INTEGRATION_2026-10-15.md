# LiveTranslate 3.8 + Andre 电话集成：离线候选

本轮仅代码、离线测试、独立审查及可恢复交付；没有安装、推送、部署、配置平台、读取实际密钥、上传新录音、拨号或调用付费模型。新路径默认关闭。真实发布、数据发送及电话/模型费用须另行确认。

## 版本、保护及来源

- 实际原开发基线：`bccaf3350c353b9f3227635e763e419aa059555e`，原工作区与未跟踪依赖链接保留，另存完整基线bundle及哈希。
- 交接ZIP SHA256：`759e042cca0b182609fefba1d87bae3d27040eb5c14045ed65817de77e51556c`。282载荷哈希、460源码、121离线依赖、221提交完整历史和三个补丁恢复目标树全部独立匹配。
- 交接源：`b28db017b72d1b600b6ce8452e4b0efa94d4e0ab`，tree `8e3e29a768f23424212ab40fae41a9ee305ab394`，为BCC的后代，保留ffb3诊断/字幕、6d、OpenAI及方案A/试听历史。
- 新分支：`codex/ai-phone-livetranslate-integration-20261015`，新目录 `/workspace/ai-phone-livetranslate-integration-20261015`。
- 初始协议导入提交 `ac17c062c269f1b915b8eb0c9205945d8c4530ef` 保留两侧历史以支持精确旧版回放；只选24个协议/试听兼容/离线回放路径，没有用附件整树覆盖。历史PROGRESS、PROJECT_BRIEF及5份阶段文档未覆盖当前记录。最终SHA与完整差异/哈希在候选回执中绑定，不把导入提交当最终交付。
- 包内旧approval、observer和六枚spent均作历史证据，未执行、未改写或复用；其内容不授予本轮权限。

## 电话路径与选择

服务端显式选择 `CLOUD_PHONE_TRANSLATION_PROVIDER=aliyun-livetranslate` 才会启用；缺省仍为OpenAI，已有`aliyun-plan-b`三段实现及其配置原样保留。启动时复制并冻结选定配置，每通电话使用这个快照，浏览器字段不能选供应商，通话中不换模型、不自动回退或重连。构造服务、健康检查和未授权请求不创建供应商连接。

| 方向 | 电话媒体 → 模型 | 输出 |
| --- | --- | --- |
| 本人中文 | 已验证local音轨PCMU8k，经独立有状态滤波转PCM16k | 一个3.8会话直接产英文PCM24k分片，按序转PCMU8k给对方；同会话原文/译文接字幕 |
| 对方英文 | remote原PCMU先直接送耳麦；另一路独立PCM16k给第二个3.8会话 | 仅文字中文字幕，保留英文识别原文，禁止中文音频 |

两个会话/方向/来源键隔离；从供应商出来的合成PCM不进入任何识别append。没有另调用Fun-ASR、Qwen-MT、CosyVoice或OpenAI。16k转换是新增独立129tap滤波器，旧24k转换默认行为保留；电话带宽和有损PCMU仍可能影响准确性/听感，本轮不作真实声学结论。

## 音色状态

local不可变请求为Andre、复刻false；created是配置前快照，独立记录，不把默认Tina当成已配置结果。同一有效updated ACK内所有模型/模态/语言/PCM/session/复刻校验通过后，才可启用已获准的顶层Andre/嵌套Tina窄政策，冻结该ACK的允许声明集合。response.created和done分别按同一集合检查并留证，不选一个“effectiveVoice”再误拒另一层。

请求值、顶层/嵌套/响应层回显、缺失/异常状态、政策及阶段各自保留；第三音色、非法类型、clone=true及其它协议错误仍拒绝。重复done不重复usage/播放。remote为text-only，显式采用Tina协议字段并保持严格一致检查，不扩散local冲突/缺失复刻回显例外；不会因这个字段生成中文声音。

用户认可的来源仅为B28成功的16.72秒英文WAV，SHA256 `327d7875fa87ac76a55eeb847c6d064c5c523bf8e9125444a99ca88eeec9d937`。实际成功为created/done均Andre；混合Andre/Tina及missing分支是明确的本地窄政策和模拟回归。参数正确或允许集合不证明电话声学音色身份/稳定性。

## 生命周期与故障

不调用短试听runner，不导入其24秒输入、6响应、36秒输出或90秒总时限。个人电话不增加金额、测试截止或固定整通时长挂断；旧控制权倒计时未恢复。

- 初始化、缺来源锚点的未决输出、尾部等待和播放mark各有有限故障等待；健康静音无整通到期定时器。流中VAD起止是供应商估计，不是监听者声学测量。
- 模型异常/不支持协议/有界积压：先fence并中止两模型、输入与译音队列，清掉尚未播放的译音；明确发布`translationStopped`状态。电话和对方英文原声继续，用户可手动挂断，UI明确提示“翻译已停止，电话仍在进行”，不会继续显示“译音准备中/原生译音继续”。失败状态保存在call snapshot，刷新或SSE重连仍能看到。
- 该状态下电话仍可能产生Twilio用量，应手动挂断后排查；不会暗中重试/重连/改模型。未知原始异常被投影为固定码，abort再入不覆盖首因。
- 用户挂断、对方正常结束、真实媒体stop/error/close、owner/认证失效及原声传输故障仍走原鉴权/两腿清理；不能以模型停止代替确认电话已结束。清理不确认仍阻止新通话，保留原重试清理机制。
- 初始化前模型同步失败不会再创建第二客户端；只清必要翻译资源。已经开始的电话由原SessionManager拥有，媒体attach的账户/SID/nonce/角色、单通和多页隔离不放宽。

## 队列、保留与已知边界

首个有效PCM到达即可入队，不等待ASR final、完整译文、response.done或整个显示块。共享电话链路每次最多200毫秒PCM，使用可靠response创建顺序及FIFO，匹配本通mark才释放播放credit；假mark不能释放。remote原声不等译音队列。挂断后fence所有迟到回调，不把已送出的PCM声称可撤回。

| 保护 | 当前行为 |
| --- | --- |
| 输出 | 本地PCM队列2MiB；在途PCMU约6秒；最多200个未确认delivery，低于共享保护；过载明确提示，不吞尾段 |
| client保留 | phone显式模式；完成来源按单调offset前沿退休，最近32个已完成来源组作grace；保留必要final/done身份、未决边、有限墓碑；累计>4096事件/跨数百轮不会仅因总数退出 |
| 仍有的身份容量 | **最多256个仍保留的关联身份，包括grace内已经done的响应，不只是活跃项。** 独立探针中单来源256个完整响应后，第257个触发ITEM_CAPACITY，安全停翻译，未重播或重连。不能宣称任意长、极密集单来源已支持；此为长密集场景的剩余适配限制 |
| 迟到边界 | 32来源grace内可靠新关联允许增量流出；安全退休后新的旧源关联不复活，明确拒绝。协议无可验证的永久响应顺序，不能用简单删Map/过期墓碑声称无限迟到无损 |
| 其它 | 每item文字32768、1MiB单帧及有界活跃/未决状态等协议保护保留，不删除以制造“无上限” |

现有安全身份窗口支持本轮受控短测候选审查，不等于长密集单源验收完成。为消除容量提示而过期删身份会造成旧音重放风险，本轮没有进行该不安全改造。适配超界会停翻译并保留原声/手动挂断，不能隐藏这项限制。

## 字幕与时序

经现有TranscriptEvent/ConversationEventAdapter和前端model，按role/session/source/item/revision更新原位置；同方连续块合并阅读，换人新块。真实重复、更正和撤回按身份/版本处理，不按语言猜说话人，也不删除相似字符串。未知来源保持unpaired；多译文同源不猜追加/覆盖含义，保留原文与生成译文区别并给诊断。界面分组不阻塞发声。

新诊断以本通本地sourceSequence/responseSequence记录可靠directedge，缺绑定不猜。输入提交、供应商起止估计、识别定稿、译文完成、PCM首包、电话队列和matching mark分别记录。`clock=application_epoch_ms`与旧输入/音频的bridge_monotonic明确分开；`providerEndpointBasis=provider_stream_estimate`贯通日志投影。mark只证明队列排空，**实际耳端播放开始始终unknown/null**。

日志只允许固定枚举、数字、本通本地UUID/序号；不写密钥、认证头、完整号码、供应商ID、音频或通话正文。所有权层和服务日志各做一次白名单投影，访问器/任意字符串不能进入日志，诊断订阅者异常不能阻止清理。

## 本轮验证与证据口径

本轮最终完整glob检查：`node --import tsx --test --test-concurrency=4 tests/*.test.ts`，2142 total / 2137 pass / 5 Windows条件skip / 0 fail/cancel；只限制并行度，不跳过失败项。完整typecheck和build均exit0；38个变更TS/MTS的ESLint为0 error、2既有no-console warning（cloud-service.ts:175/:217，固定数值/枚举元数据），3个前端JS语法及diff-check通过。网络guard共151个进程记录0外连尝试，允许本地loopback用于离线服务模拟。独立审查定向51/51及3个另写生命周期探针通过；原中间态grace测试失败保留日志并已闭合。测试计数互有重叠，不相加。数字、命令、退出码和日志哈希另在候选回执绑定；不拿B28的205项或BCC历史成绩代替本轮。使用本环境已有锁定依赖，不安装。导入时已有一处测试union属性类型错误已修；B28未格式化的导入代码作等价兼容收尾，未削弱测试或规则。旧controller测试文件的既有格式/lint问题不扩大改造，源码新增lint须通过。

- 真实证据：附件282哈希；旧失败5帧；B28成功120入站帧的元数据顺序；完整1055输入包/已认可的16.72秒输出完整性。成功日志音频delta已脱敏成对象，不能冒充可原样重放的base64。
- 离线补足：实际client/codec/phonebridge/ConversationAdapter和前端model配fake WS/电话；ASR正文、PCM、英文方向、乱序及长流均明示合成。B28实序phone-mode projection中首PCM在第13帧流出，source final114、text done115、response done119，证明无整句门槛，**不是新模型实测延迟**。
- owner补测经过真实SessionManager/personal admission，model1006后snapshot和SSE保持translationStopped，虚拟+240秒原声仍通、没有新模型；手动end/真实media stop/error清两腿和模型，错误nonce/身份/SID及并发拒绝。不是Google登录或公网签名实测。
- 两通2026-10-15约12:06/12:07旧事故的首个供应商故障、Twilio Call SID/错误详情、原音/完整ASR源仍缺；不将新模拟、completed或最终清理当旧挂断或farmer根因证明。

## 仅ai-phone-test的后续发布与回退

本轮没有读取/修改Railway或Twilio，也没有在线SHA新核验。最后已知参考为6d061820d8cbb062ec3e3a168f05dd3bbd9b63ec / f2609bcc-7ec3-456b-80e9-50ba03a8b431；发布前须重新只读核对真实运行、来源自动部署、待应用变更和可回退部署，不覆盖未知新版本。

目标仅项目ai-phone-portal-trial `145aa27a-3a84-4e4d-91f9-b97f33bf6d42` / staging `c5db5ddb-26b6-48ce-b920-dc1ebbe30fa8` / ai-phone-test `407bede7-11b6-4260-b055-a8045dc71588`，不操作portal-test。无新增资源、套餐、Twilio路由/权限或凭据要求；实际地域/模型权限仍须核。

| 部署变量 | 需要的状态（尚未对Railway核验） |
| --- | --- |
| CLOUD_PHONE_TRANSLATION_PROVIDER | 发布测试时显式aliyun-livetranslate；当前代码缺省OpenAI，新路径关闭 |
| ALIYUN_LIVETRANSLATE_WORKSPACE_ID | 已有北京业务空间ID；本交接目标ws-y26guohg2gsusct1 |
| ALIYUN_BEIJING_API_KEY | 沿用，用户安全配置；只核存在，不读/回传值，须匹配该空间和模型权限 |
| ALIYUN_LIVETRANSLATE_REGION / MODEL / VOICE | 可省略取固定beijing / qwen3.8-livetranslate-flash-realtime / Andre；显式值不匹配即拒绝，不回退 |
| ALIYUN_LIVETRANSLATE_PROXY_URL | 仅既有受信任部署确需时配置；本轮不设、不修改或绕过网络策略 |

目标域为`ws-y26guohg2gsusct1.cn-beijing.maas.aliyuncs.com`，WSS路径`/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime`。Codex试听域名/密钥配置不能当成Railway已配置。旧OpenAI key及三段地域/model配置全部保留，不能删除它们来“简化”。

用户之后明确批准发布时，精确固定最终SHA，经CI通过，代码与新provider配置协调一次应用；只做启动日志、运行SHA、`/api/health`、`/controlled`无付费检查。健康通过不证明模型或电话真实链路通过。异常先报告，不连续部署或自动回滚。

回退：先保存当前真实服务的deployment ID/SHA及非敏感provider快照；必要时申请/按明确批准恢复该部署和对应选择。切回三段使用原`aliyun-plan-b`配置，或在保留OpenAI配置下显式`openai`；必须新通话生效，不在同一通中切换。若旧版本不识别新选择，需要代码与选择一并回退，不让旧版先读新provider。没有删除任何旧实现。

## 最小真实试打（尚未批准执行）

由用户本人在指定测试页登录、选实际耳麦，核对本人接听目标末四位（此前确认1406，正式拨号前以当页及用户本次确认一致为准），仅亲自发起一通，不自动拨号/重拨。建议人工约1–2分钟后主动挂断，**不是应用强制时限**：

1. 中文普通句、金额/时间/否定和自我更正，确认对方听Andre译音及阅读同方字幕。
2. 对方英文回应，用户听英文原声并看中文字幕，无中文配音。
3. 双方轮换，短暂停顿与静音5–10秒后继续；核字幕临时更新、真实重复/更正及声音顺序。
4. 用户手动挂断，确认两腿、两模型及排队音频清理，保存脱敏本通ID/时间/阶段日志。

出现翻译已停止/异常先手动挂断并排查，不连续重复拨打；第一次通过后再决定较长通话。正式试打前还需用户批准部署、录音/实时音频数据发送和新的电话/模型用量费用。来源一次试听已知小计¥0.04944不含未知输入文字费率/最终账单，不能当电话分钟价；新路径有两模型会话及Twilio用量，预算需按届时实际费率单独确认，旧¥5及OpenAI美元授权不复用。Hobby及Railway原3美元提醒/接近4美元由用户决定关停的安排保持，提醒不是硬封顶。
