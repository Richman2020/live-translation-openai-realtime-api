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

截至本轮夜间任务启动，CPU Torch 2.6.0 / Torchaudio 2.6.0 的两个公开 wheel 已按官方索引 SHA256 完整核验；另从本机 pip 缓存恢复 48 个 wheel，未修改原 RVC 环境。Nano 权重与 Perth 仍在下载准备，尚无真实 Nano 生成或听感结果。公开下载站 DNS/传输波动已通过私密断点记录保留进度；安装等待不计入模型推理速度。

三个新增脚本语法检查通过。离线探针的音频保存/转码回解、拒绝覆盖、网络阻断和 token 计数已做小范围检查；试听构建器用真实旧版 A/C 和模拟 Nano 报告验证复制、哈希、格式与篡改拒绝。模拟 Nano 材料只验证工具，不能作为本次真人模型结果。独立代码审查后补了下载失败即时报告和超时进程树清理。

## 夜间接续入口

- 后台主流程：`scripts/run-nano-night-pilot.py`，运行于 Nano 专属 venv。资源齐备且哈希复核通过后才安装，随后导入检查、冻结依赖、等待模型、实际离线生成、制作私密试听页。进程持有独占锁；处于等待或运行阶段不要重复启动。
- 状态：`.runtime/chatterbox-nano-lab/night-pilot-status.json`，包含阶段、实际 worker PID、输出目录、日志路径及错误。每个安装/生成/建页阶段分别留下日志；成功只标记 `completed_for_listening`，真人听感仍是 `PENDING`。
- 下载：`download.stdout.log` / `download.stderr.log`；公开依赖资源：`perth-ranges.stdout.log`、`cpu-perth-download-result.json`；公开 wheel 预取：`wheel-prefetch.stdout.log`。只将通过最终整体 SHA 的文件视为完整下载。
- 开启线程范围的临时防休眠，后台流程退出时释放，不修改系统电源计划。另已建立当前任务夜间定时接续检查，要求无变化不通知、失败时检查并修复、全部完成后停用；电脑和 Codex 需要继续运行。
- 实际样本完成后更新本报告和 PROGRESS，核对原生/电话编码文件、生成耗时、内存和截断迹象，再提供真实试听页路径。现阶段不把已启动后台任务说成模型已跑通。
