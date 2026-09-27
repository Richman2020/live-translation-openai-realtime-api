# Chatterbox Nano 本机本人声线实验

## 决定与边界

用户试听 RVC 的短句及三句连贯样本后，认为声音清楚、可理解且接近本人，但单调、顿挫和机械感仍明显；保零/插值 F0 和检索候选均没有得到可感知改善的反馈。用户批准更换生成路线进行独立实验，并允许夜间完成不需要本人参与的步骤。

本轮采用已核验的开源 Chatterbox Nano：正确英文文字 + 本人参考录音，直接生成本人声线的英语。目的是比较自然度和相似度，不是换一个音高参数，也不验证翻译准确度。保留旧 RVC 基准；不买硬件或订阅，不上传本人录音，不改电话默认，不拨号。听感由用户回来后判断。

## 固定来源

- [Chatterbox 官方代码](https://github.com/resemble-ai/chatterbox/tree/5de7a54aa4e5e2baadb0182dde554908b48b85c2)，commit `5de7a54aa4e5e2baadb0182dde554908b48b85c2`。
- [Nano 官方模型](https://huggingface.co/ResembleAI/chatterbox-nano/tree/71ccd1d0081b430592cea481f4307e764e07bc64)，revision `71ccd1d0081b430592cea481f4307e764e07bc64`。
- [Perth 官方水印](https://github.com/resemble-ai/Perth/tree/ff1c8ac55a976971245cdd53c18d6131ca00d993)，commit `ff1c8ac55a976971245cdd53c18d6131ca00d993`。保留水印，不用无水印替代。
- 只下载 Nano 实际使用的 `t3_nano_v1`、`s3gen_meanflow`、`ve` 权重和分词文件；共 1,941,930,294 字节，另含可选默认参考 `conds.pt` 169,454 字节。本人测试必须显式构建本人参考条件，不使用默认参考冒充克隆。

## 本机流程

所有环境、权重、录音、日志与输出放在忽略目录 `.runtime/chatterbox-nano-lab/`。独立 Python 3.12 环境，以 CPU 先检查可运行性；不改变已工作的 RVC 环境。下载中断可以保留分块，但只有完整文件 SHA256 与固定官方清单一致才算模型准备完成。

本人参考使用已有授权试录中第 2–12 秒，10 秒、48 kHz、单声道，未降噪或拉伸。初步数值检查 RMS -26.49 dBFS、峰值 0.517、无满幅削波；这不等于人声无噪声或最佳参考已选定。参考的源文件和截取区间保存在本机私密报告。

`scripts/probe-chatterbox-nano.py` 固定模型哈希和上游代码，设置 HF 离线模式并禁止 Python socket 联网；先显式加载本人参考，再生成三组固定内容。按生成报告检查非空、有限值、时长、削波、文件哈希和生成上限，保留原生水印 WAV 与 8 kHz μ-law 转码回解文件。全句生成、加载和参考处理耗时分别记录。上游返回前删除 EOS，不能把短于上限的返回直接叫作完整朗读通过。

1. `Hello, thank you for calling. I finish work at five, so we can talk this evening. Please tell me what time is good for you.`
2. `Could you tell me what time works best for you?`
3. `I do not need coffee. The appointment is tomorrow at three, not today.`

## 验收

先对比与旧版相同的三句英文，再听问句与否定、时间。分别判断音色相似、语气起伏、连贯性、辅音清晰及完整性。必须听清 `do not`、`tomorrow at three` 和 `not today`，不能只看输入文字就宣布输出内容正确。音频生成成功或波形变化都不能代替听感。

Nano 这条官方调用一次返回完整音频，不是已经接入的流式电话输出。整句生成耗时与音频时长比用于筛选现有电脑，不能称作实际电话首音等待。只有离线听感通过后，才讨论稳定译文驱动、分段、持续队列与真实双向电话测试。

## 执行结果

正式运行 `20260927T143946Z` 已完成三个实际样本及试听页，状态为 `completed_for_listening`，真人验收仍为 `PENDING`。旧失败运行 `20260927T143326Z` 与其音频、日志保留，未修改成成功报告。

### 环境与来源核验

- Nano 的 9 个本机文件合计 1,942,099,748 字节，逐项 SHA256 与固定官方版本匹配。Perth 的 37 个固定 Git blob、源码文件哈希和水印权重均完整核验。
- Python 3.12.14；独立 Torch 2.6.0+cpu / Torchaudio 2.6.0+cpu，两个 wheel 按官方索引 SHA256 核验；Transformers 5.2.0、NumPy 1.26.4。完整冻结清单保存在本机本次 `freeze` 日志。实际模型导入和生成通过，未修改已有 RVC venv。
- Chatterbox 采用最小英文 Nano 运行依赖，并以 `--no-deps -e` 安装固定源码；没有安装未用到的界面或其它语言可选依赖。因此不宣称上游全部功能或完整依赖检查通过。
- 本人参考确认为原始试录第 2–12 秒，48 kHz 单声道 PCM16 共 480,000 帧，逐字节与指定截取区间相符。此为数值核验，不是人耳确认最佳录音。

### 实际测量

设备仍为现有 i3-12100F / 16 GB，CPU 4 线程、interop 1；GTX 980 未参与 Nano 生成。下表为一次正式离线运行，不是多轮基准中位数。

| 内容 | 原生音频时长 | 整句生成耗时 | RTF（耗时÷音频长度） | 返回 speech token |
| --- | ---: | ---: | ---: | ---: |
| 连贯三句 | 6.92 秒 | 9.90 秒 | 1.43 | 170 |
| 问句 | 2.20 秒 | 3.88 秒 | 1.76 | 52 |
| 否定与时间 | 4.32 秒 | 6.59 秒 | 1.53 | 105 |

库导入 6.52 秒，模型加载 5.01 秒，本人参考准备 2.36 秒；整个探针 36.63 秒。以上分开记录，表中的生成时间包括 T3、解码和官方水印，不含文件转码。进程峰值工作集 4,027,793,408 字节（约 3.75 GiB），没有 OOM；不是显存使用量。第一次运行参考准备较慢，存在首次运行初始化差异，不以此承诺固定冷启动速度。

**结论：现有电脑可以完成此 Nano 本人声线试听实验；本次 CPU 全句调用慢于声音播放，尚不适合持续实时电话。** RTF 不能当作电话首音延迟，亦未实现增量音频返回。旧版 A/C 的 9.7745 秒是电脑英语原声经 RVC 转换，新版 6.92 秒是直接生成，两者设备和过程不同，不作同条件速度排名。新版较短不能直接解释为漏字或更好，需听是否快得不自然、有无遗漏。

### 修复与完整性检查

首批模型已生成声音，但 urllib3 导入时 `_has_ipv6("::1")` 的 `bind(("::1", 0))` 被离线守卫计作联网违规，导致整轮失败。独立无音频重现确认它仅探测本机 IPv6 能力，没有 connect 或 send。修复严格核对真实函数 code/globals、局部 socket 身份、AF_INET6、SOCK_STREAM 和 `::1:0`；**该 bind 仍被禁止**，仅单列为 `blocked_local_capability_probes`，不是允许联网。未知 bind、connect、DNS 等继续中止实验。

`scripts/test-nano-network-guard.py` 的 6/6 独立进程检查通过，覆盖真实 urllib3 探测、未知 bind、同名伪调用者、错误地址、connect、DNS。正式重跑记录未知/网络违规 0、已禁止的本机能力探测 1，HF 离线与 Python socket 守卫均启用；此守卫不是操作系统防火墙。

原生声音为官方水印输出的 24 kHz FLOAT32 WAV，不调音量或裁切。三组均有限、非空、数字满幅削波为 0；对应 8 kHz PCM16 电话 WAV 和原始 μ-law 同时保留。返回 token 170／52／105 未接近 1000 次循环上限，但上游移除 EOS，仍不据此判定英文完整。水印生成路径保留；未做水印检测或电话转码后的鲁棒性测试。

独立只读复核通过：本次 9 个输出 SHA/格式/时长与报告一致；用独立标准库解码三个 μ-law，与各自电话 WAV 逐样本一致。试听目录 10 份 WAV、3 份证据报告与来源逐字节一致。两次运行的全部生成波形也逐样本相同；6 个电话文件 SHA 相同，3 个原生 FLOAT WAV 仅 PEAK 块写入时间戳不同，不能把整文件哈希差异误报为声音变化。最终核验为本机 `verification-probe-20260927T143946Z-complete.private.json`，早先过严的整文件哈希断言记录保留但不作为最终结论。

私密试听页含 10 个播放器，均成功加载实际音频元数据，无外部资源和横向溢出；浏览器静音播放和自动暂停上一段的检查通过，未把浏览器播放状态当作人耳试听。浏览器临时预览仅监听 127.0.0.1，检查后关闭；正式交付为可直接打开的本机 HTML，保留同目录 audio 文件夹即可。

### 本机交付与本人待判断项

- 试听入口：`.runtime/chatterbox-nano-lab/review-20260927T143946Z/index.html`。
- 原始实际报告：`.runtime/chatterbox-nano-lab/probe-20260927T143946Z/report.private.json`。
- 独立核验：`.runtime/chatterbox-nano-lab/verification-probe-20260927T143946Z-complete.private.json`；浏览器核验：同目录 `browser-verification-20260927T143946Z.private.json`，截图保存在试听目录。
- 后台流程、安装/导入/冻结日志与状态保存在同一 lab；旧失败证据仍在原目录。音频、本人参考、环境、模型和全部私密报告均被 Git 忽略。
- 顺序：先听旧版 A 的三句，再听 Nano 相同三句；之后比较电话编码版，最后核对问句、`do not`、`tomorrow at three`、`not today`。判断机械感、语气、相似度、漏字/尾句和声线稳定性。
- 若新路线没有可感知自然度收益，就不继续盲目调参；若听感有明显收益，再评估现有硬件上的加速与分段。本人试听前不选默认、不接电话，不把文字正确等同于语音正确，也不把声线改善当作翻译准确度解决。

## 夜间接续入口

- 后台主流程：`scripts/run-nano-night-pilot.py`，运行于 Nano 专属 venv。资源齐备且哈希复核通过后才安装，随后导入检查、冻结依赖、等待模型、实际离线生成、制作私密试听页。进程持有独占锁；处于等待或运行阶段不要重复启动。
- 状态：`.runtime/chatterbox-nano-lab/night-pilot-status.json`，包含阶段、实际 worker PID、输出目录、日志路径及错误。每个安装/生成/建页阶段分别留下日志；成功只标记 `completed_for_listening`，真人听感仍是 `PENDING`。
- 下载：`download.stdout.log` / `download.stderr.log`；公开依赖资源：`perth-ranges.stdout.log`、`cpu-perth-download-result.json`；公开 wheel 预取：`wheel-prefetch.stdout.log`。只将通过最终整体 SHA 的文件视为完整下载。
- 开启线程范围的临时防休眠，后台流程退出时释放，不修改系统电源计划。另已建立当前任务夜间定时接续检查，要求无变化不通知、失败时检查并修复、全部完成后停用；电脑和 Codex 需要继续运行。
- 机器阶段已完成，后续无需重复下载、安装或生成本批样本。交接提交推送并核对远端后停用本次夜间自动跟进；真人自然度、相似度和内容完整性继续留待用户回来确认。
