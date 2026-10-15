# 阿里 Plan B 电话集成：本地候选，未发布

日期：2026-10-15（北京时间）。用户本轮授权仅选择性代码集成、已有依赖下离线测试及发布准备。未调用模型、上传新录音、拨号、安装、推送、部署、修改凭据/网络或操作portal-test。

## 来源、基线与保护

来源包固定 `AI_PHONE_ALIYUN_CURRENT_ONLY_INTEGRATION_da3bfbf.zip`，SHA256 `707868f36894c54476d7e5886f4ee0f06d8157b0483cc1250e0a8917450bfb3d`；来源运行候选 `da3bfbf09a5580de268ad8a2c0e12e572c24f267`，tree `8aecbd2eaa031643405470b17971594d19c78613`。包内文档仅作证据，不继承旧付费/发布授权。

独立复算FILES及SHA256SUMS各67/67、完整源码与Git树各443/443、摘录43/43一致，两路补丁均恢复来源tree。bundle不是完整历史，只有在新的附件检查clone恢复声明的d7浅边界后fsck通过，没有修改当前仓库shallow。PATCH_PREIMAGES针对b072，不能拿来盲目覆盖eb10。原文档交付提交2109b12不替代固定运行候选。

本轮开始时实际开发HEAD为 `eb10bf98a2606eb476af5314fde02c243f741fbd`，是来源da3b的祖先；当前线上参考是d7，不作为开发基线。另建分支 `codex/ai-phone-aliyun-integration-20261015`、工作目录 `/workspace/ai-phone-aliyun-integration-20261015`，从eb10选择移植必要修复，产生新的集成SHA，最终由RECEIPT绑定。未整树覆盖、未合并来源的试听CLI/whole runner/旧文档或已消费审批。

原七个工作树HEAD/未提交tracked全文/依赖链接前后保护，生产未提交PROGRESS独立保留。原OpenAI原生、上下文字幕、A原型、试听执行器、package/lock与回退备份保留；本次未修改认证/Google/Origin/CSRF/供应商签名/SID/nonce/controller/单通准入。共享OpenAI音频transport全文不改，新增optional observer对原路径无行为变化。

## 选择性集成内容

1. 从来源Fun-ASR修复选择移植partial起点前移及已见别名回退、final绑定和scalar-only诊断，原文修订不因普通begin变化误作新句。明确矛盾final、非法身份/超出实际已送样本边界仍拒绝；未带入试听24秒/90秒/8次门槛。
2. 新生产 `aliyun-planb-current-translation.ts`：北京固定qwen-mt-flash，单user仅为当前原文，原有SSE/usage/代理/TLS parser不变。历史仅官方 `translation_options.tm_list`，由本通同角色已校验原文/实际译文配对产生，最多6完整对/1600字符；不伪造source-only上下文、JSON提示或多轮参数。两方向各持语言匹配TM，不把反向译文塞入错误语种。
3. 新guard绑定本通/role/job/request/sourceIDs/精确raw哈希与完整原始返回，冻结receipt一次消费，TTS再次检查精确正文。只有通过校验的正文进确定字幕及TTS；JSON、结构包装、说明前缀等整次拒绝，不提取字段、去掉包装或补跑。
4. 完整已知历史句前缀＋新正文／多条完整历史重放嫌疑会报错停止；单条相同译文不能证明泄漏，允许原文同义重复。真实新source重复、同ASR source多个自然子段、原文包含旧原话及后续更正保留。这个保守启发式可能误拒，失败必须明示且不静默漏句；任意自然语言的语义重复/错误无法本地证明。
5. Production pipeline只对确定自然小节发声；原文partial字幕增量更新，稳定译文和音频取同一校验快照。外层同方speaker块只是显示分组，不等待整块说完；每小节FIFO流式PCM及时进入原电话播放队列。英文PCMU原音直达耳麦，旁路ASR→中文字幕，不生成中文TTS。
6. 单通冻结provider/region/models/voice，固定fun-asr-realtime/qwen-mt-flash/cosyvoice-v3-flash/loongandy_v3。北京以外在构造client前拒绝，不先产生ASR费用后再报错；默认仍OpenAI，Plan B关闭，无fallback或中途换供应商。

保留真实断线/异常/手动和对端挂断的两腿清理、队列背压及matching marks；没有新增个人金额、固定整通时长、测试截止或控制倒计时。连接、缺失终态及播放故障超时不是整通时长限制。

## 独立审查修复

- 同一ASR源拆成多个自然小节后空final撤回，旧实现只撤第一段，后续段仍可能生成。现按sourceIds撤全部关联未暴露子段、取消任务/清队列/字幕与TM；已暴露音频保留快照，单独更正，不重播。
- 已暴露源撤回后，旧TTS稍后完成的remember可能复活TM。现以sourceWithdrawn围栏阻止所有完成/同步重入回调重新加入记忆，旧音频只正常安全排空。

两项均有独立修前红/修后绿探针与回归；详细触发、位置、影响及最终源哈希在交付独立报告。没有用“审查未见问题”代表真实通话通过。

## 完整时序观测及可观测边界

每个utterance/role/revision/epoch在同一options.now时间轴记录：

| 阶段 | 含义 |
| --- | --- |
| provider_endpoint_estimate | ASR task anchor＋供应商end_time，是流估计终点，非声学真值 |
| asr_final | 应用收到确定原文 |
| section_ready | 自然小节已具备处理条件 |
| translation_start / complete | MT排队后请求至校验完成；可与小节等待拆开 |
| synthesis_start / audio_first_sample | TTS请求至首个可播放PCM到应用 |
| playback_queued | 原共享电话桥实际创建delivery并计入队列 |
| playback_drained | producer已封口且所有exact matching marks返回，队列排空证据 |
| playback_start_unavailable | 实际接收端播放开始无可信观测，actualPlaybackStartAt=null |

Twilio media socket send/回调不是接收端开始；mark是排空，不是开始或人耳证据。本轮没有新增可伪造的公网播放器回执入口，也没有声称测到实际播放开始；现接口的这一缺口必须保留在发布/实测回执。

SessionManager `translation-timing` SSE走原owner/call授权；selected Plan B服务额外输出经 `diagnosticLogRecord` 过滤的JSON日志。只有固定枚举、有限时间/版本、局部生成UUID及受限句段ID；不记录正文、号码、供应商SID、key/header/raw error。日志wall-time与observedAtEpochMs分开，共享transport_monotonic不能混减。

附件真实短中文证据：估计终点→首PCM 4114/3867ms；ASR1058/1270ms、分段/排队3/3ms、MT1299/750ms、TTS1754/1844ms。只是既有试听的生成接收结果，非本轮结果或耳听延迟；本轮不降准确性、丢句或强读partial制造提速。

若真实长ASR source一直只有partial，译音仍会等final，草稿原文可见。未宣称真实连续讲话延迟达标。官方TM是翻译记忆，不是完整多轮语义推理保证；英文真实识别/翻译、双向连续电话、听音与实际清理均待用户试打。

## 离线验证与未执行

复用现有锁定依赖、Node24.19.0/npm11.9.0。prepare:desktop仅本地复制已锁定Twilio SDK，无安装。统一结果、命令/退出码、失败与条件skip详见validation-results.json及日志，最终SHA与验证输入哈希绑定。

新SessionManager→真实Plan B ASR/MT/TTS客户端→共享电话transport的端到端仅供应商网络与电话peer为内存假对象；覆盖双向、当前正文/TM、JSON/说明/历史前缀、数字否定/更正、重复新旧source、乱序/尾段、挂断后不再生成及模拟超过三分钟。另选来源44条真实ASR scalar元数据顺序/修订回放，文字明确合成；不是原始供应商帧或真实识别质量验收。运行日志4例验证无凭据/正文及sink异常不影响清理。

未执行付费模型、英文新试听、上传、真实电话、录音、推送/PR/CI、Docker部署、平台或凭据网络变更。旧OpenAI和阿里试听批准均已消费，不借用为本轮电话授权。

发布及回退只针对指定ai-phone-test，见 [方案](ALIYUN_PHONE_STAGING_PLAN_2026-10-15.md)。
