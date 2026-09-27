# 本人声线本机试训与英文试听（2026-09-27）

用户已授权自行处理常规技术选择，在现有电脑上推进专用本人录音、预处理、受限训练和英文声音小样。沿用无新增硬件、无订阅的边界。个人原声、模型、完整报告和试听页仅保存在 Git 忽略的 `.runtime/own-voice/20260927-070927/`。

本轮是 RVC 声线转换试验：固定英文合成声音作为内容输入，用本人数据训练的模型转换音色。它不生成译文，不能证明或修复电话翻译准确度。原电话服务、默认翻译引擎、供应商设置和号码回调未改。

## 数据与预处理

- 实际核对 11 个 WAV：十段正式素材 564.43 秒，试录 30 秒；48 kHz、单声道 PCM16。原始文件及清单已归档，逐文件哈希保持不变。
- 试录及最后一段正式素材作为留出参考，共 75.86 秒，不进入训练。其余九段原始素材 518.57 秒。
- 复用固定官方上游 `81eed5e8f68b6bed1789f682fe78cdd324495afc` 的静音切分器及参数：阈值 -42 dB、最短 1.5 秒、间隔 400 ms、步长 15 ms、保留静音 500 ms；48 Hz 五阶因果高通及官方幅度归一化公式。
- 本机未使用上游 FFmpeg 解码路径，而是直接读取实际 PCM，以 librosa/soxr_hq 从 48 kHz 转 32 kHz，再生成 16 kHz 特征输入。重采样差异明确记录，不称与上游逐字节相同。
- 长段均衡分成最多 3.7 秒、重叠 0.3 秒的片段，保留每个静音切分结果的尾部；不照搬上游可能达到 4 秒的尾块或最后才写一次尾部的行为。
- 生成 193 段，0.705–3.675 秒；32 kHz 与 16 kHz 均为 float32 WAV。切片总长 479.76 秒包含重叠；按切分器保留的独立时间约 469.26 秒，不能当作经过语音活动检测确认的有效人声时长。
- 数值均有限，归一化后峰值约 0.886，未出现数字满幅。静音/能量规则与音高检测不证明无噪声、无其他说话者、发音清晰或克隆相似度；听感验收仍待完成。

实现：`scripts/prepare-own-voice-rvc.py`；私密报告：`prepared/preprocess-report.json`。

## 真实特征及官方数据加载

- 使用已核验哈希的本机官方 HuBERT/ContentVec 和 RMVPE，离线运行，不下载或上传录音。
- 193/193 片段成功提取真实 v2 768 维特征与 F0；无全零音高片段被排除。训练用无声位置 F0 按固定上游规则插值，报告保留插值前有声比例，不把插值后的非零值当真人发声。
- GTX 980 上显式使用当前进程 CUDA FP32 兼容选择，未修改上游代码或系统设置。RMVPE 约 8.14 秒、HuBERT 约 9.33 秒；两阶段共约 17.48 秒。PyTorch 分配/保留峰值约 416/516 MiB，不等于 WDDM 专用显存驻留测量。
- 官方 `TextAudioLoaderMultiNSFsid` 和 collate 实际读取全部 193 段，逐项检查有限值、采样格式和帧数对齐，编码器长度不超过此前容量范围。官方 loader 直接使用归一化 float32 波形，不能用未归一化 PCM16 代替。
- 首次预检暴露 Windows 中文路径被上游默认 GBK 读取误解码。已仅在构造 loader 时明确以 UTF-8 解析本工具生成的文件清单，随后恢复函数；上游文件不变，实际完整重检通过。
- 每段缓存谱与实际 WAV 重算结果比较，且加载后的帧数必须等于预期，拒绝错误缓存及正确缓存的截短前缀。最终加强的两行帧数防护另以完整真实数据 CPU 重检通过；已经启动的训练进程仍使用其报告绑定的启动时源码，不伪造源码哈希。

实现：`scripts/extract-own-voice-features.py`、`scripts/train-own-voice-rvc.py`；私密报告：`features/feature-report.json`、`loader-check-final/training-report.json`。

## 受限真实训练

- 复用官方完整 v2 32 kHz 生成器、九分支判别器、GAN/特征匹配/mel/KL 损失及 AdamW；batch=1、FP32，解码训练切片 0.4 秒。使用已经核验的官方 `f0G32k.pth` 和 `f0D32k.pth`，不是此前随机特征或合成波形计算探针。
- 首轮 40 步真实更新成功，循环约 59.08 秒，首步 3.10 秒、后续均值约 1.41 秒。只看过 40/193 段，不能称完整训练或收敛。
- G/D 完整模型、优化器、调度器、CPU/CUDA 随机数和数据顺序均已保存；模型与状态通过 CPU 安全加载和精确回读。另导出标准 RVC 推理权重，并通过严格官方架构加载。
- 恢复前核对全部输入字节、文件清单、配置及检查点哈希；恢复后从第 41 步继续，保留数据位置，不重新从基础模型开始。追加 539 步全部完成，累计 **579 步、193 个片段各参与三轮**；真实恢复训练验证通过，无 OOM 或最终非有限参数。
- 续训循环约 1,145.86 秒，平均每步约 2.09 秒、最慢约 3.31 秒；两次训练循环合计约 20 分 05 秒，含数值检查和报告相关开销。续训 PyTorch 分配/保留峰值约 2,909/3,112 MiB；进程结束后释放资源，不称为 WDDM 专用显存或多小时训练稳定性验收。
- 最终完整 G/D 状态安全回读一致，推理导出严格加载通过。这证明本机已经完成一次受限本人数据训练和真实续训；三轮试训不代表模型充分收敛或音色质量已通过。

原始训练证据保存在 `pilot-0040/` 与后续独立运行目录；历史失败的中文路径预检也保留。运行时间包含逐步有限值、梯度、参数更新和报告检查，不作为纯训练吞吐或完整训练时间承诺。

## 英文声音小样与试听

- 英文内容由已安装的 Microsoft Zira Desktop 在本机离线合成，32 kHz 单声道，三句覆盖请求重复数字、工作时间、否定与预约时间。来源文字和音频哈希绑定，不把基础模型控制声音冒充本人克隆。
- 真实整句声音经 HuBERT、RMVPE、本人训练模型生成 32 kHz 声音，再生成 8 kHz G.711 μ-law 编解码回放。保留合成输入、模型输出、电话编码后声音，只有严格成功且等长的文件才进入试听页。
- 对照录音及固定英文合成源的音高范围，试听候选使用明确记录的固定 -6 半音校准；个人音高测量只保存在私密报告。这不是对任意电话说话者都适用的声线稳定算法。默认代码仍为 0 半音；推理默认保留无声基频位置，与训练插值规则分别记录。
- 初始 40 步模型已经产生 3.0895 秒第一句小样。哈希、PCM 参数、μ-law 逐样本往返一致，无满幅或近满幅削波；没有用原声替代模型输出，也没有补静音掩盖生成不足。
- 初始小样 2.2–2.4 秒尾部能量偏弱，电话带宽进一步削弱；不能仅凭等长认为尾词完整。末尾安静区只有极低电平残留，没有检测到明显新增高能尾声。这是信号检查，不是已听清英语或确认像本人。
- 最终试听页内嵌所有音频、保留本人原声参考，可离线打开；不自动播放、不请求麦克风、不连接外部地址、不保存或擅自填写质量评分。

最终 579 步模型生成三组试听文件，全部实际完成，电话 PCM 数字削波计数为 0，防削波衰减系数均为 1（未放大低音量输出）。原声、32 kHz 及电话 8 kHz 三层文件时长一致。下面是**已收齐整句后的离线计算**，不包含等用户说话/译文生成的时间，也不是电话新增等待：

| 固定英文 | 输入／输出时长 | HuBERT + F0 + 生成整句计算 |
|---|---:|---:|
| Could you repeat that number, please? | 3.0895 秒 | 1.411 秒 |
| I finish work at five. | 2.1595 秒 | 0.712 秒 |
| I do not need coffee. The appointment is tomorrow at three. | 4.8195 秒 | 0.803 秒 |

试听页在本机 `own-voice-listening-0579.html`，约 5.78 MB，包含本人 30 秒原声参考及三组九个对照音频，固定英语附中文意思。生成时逐文件校验报告哈希及格式，通过后才嵌入；页面和音频未上传 GitHub。音色相似度、英语完整性与自然度仍为 `NOT_ASSESSED`，不将上述数值当作真人听感结论。

独立 CPU 核验确认最终三组共 12 个文件哈希与报告相符，统一使用 579 步检查点；原始 μ-law 解码与电话 WAV 逐样本一致、重编码无差异。第一句尾部的电话频段能量较 40 步版有所增加，但同区段 32 kHz 能量下降，不能宣称尾词全面改善。该句末尾安静区的 32 kHz 底噪由约 -76 升至 -60 dBFS；是否可闻及是否影响自然度需在试听中确认，不凭信号检查补写听感结论。

实现：`scripts/convert-own-voice-sample.py`、`scripts/build-own-voice-review.py`。整句计算耗时、模型成功输出和电话编码通过，都不能代替真实电话新增等待、音色相似度与译意完整性验收。

## 验证与后续

### 第一轮真人试听反馈及单变量对照

用户已实际试听第一句 32 kHz 579 步候选：声音清楚、接近本人音色，方向可接受，但机械感较重。这是第一句的主观反馈，未覆盖其他句子、电话编码或实际线路。原生成报告中的 `NOT_ASSESSED` 是生成时状态；后续反馈另存并绑定样本哈希，不回写历史报告。

固定上游 `infer/vc/pipeline.py` 的 `get_f0` 会对零基频插值，训练特征提取也采用插值，而本机小样默认保留无声位置。已以同一源、同一检查点、同一 -6 半音生成 `sample-0579-en-number-f0-interpolate/`，唯一设置变化为 `f0_mode`。这只是候选对照，插值可能影响机械感或产生停顿嗡声，不先认定为修复。两组共 8 个输出文件哈希与报告一致；长度均为 3.0895 秒，无数字满幅削波；末尾安静区 32 kHz RMS 均约 -59.6 dBFS。尚待听感比较，无新增训练、上传、付费或电话操作。

当前无检索索引；官方 protect 参数主要作用于索引混合特征，不能把无索引时单调 protect 包装成有效优化。Windows Zira 原始输入的节奏与仅三轮试训也都是待区分因素，尚未证明机械感的具体来源。

### 既有检查与后续门槛

- 预处理 6 项检查、训练 10 项 CPU 检查通过，涵盖分段/尾部保留、容量、归一化、源保护、中文路径、格式/非有限值、缓存不一致及截短、恢复数据变更、禁止覆盖和安全状态回读。
- 声音/编码/试听页 17 项检查通过；μ-law 编解码与本机标准库逐值比较覆盖全部 65,536 个 PCM16 输入和 256 个编码值，另检查音高、来源哈希、禁止基础模型冒充及 HTML 转义。
- 最终现场以同耳机、同音量对照本人原声、英文候选与电话编码版，关注相似度、尾词、否定/数字、金属音和忽男忽女。未获真人听感前，维持候选状态，不接入电话默认。
- 如果小样不够像或发音变糊，先定位音高、切分、模型训练或电话带宽问题，再决定训练量和实时适配。RVC 音色转换不能自动补救连续翻译模型的错译。
- 本轮结束时官方上游已跟踪文件仍无修改，本机电话健康端点返回 200；没有通过真人电话验证本轮声音。代码经开发分支交接，完整提交及远端核验以 Git 历史为准，不称合入 main。

这批 Python 检查需要已有隔离 RVC 环境；不包含在仓库仅匹配 TypeScript 的 `npm test` 中。可分别运行 `tests/own-voice-preprocess.test.py`、`tests/test-own-voice-rvc.py`、`tests/own-voice-sample.test.py`。编码对照使用 Python 3.12 自带的 audioop，不建议直接换成已移除该模块的 Python 版本后把跳过当通过。

复现命令中所有输出目录都必须是新目录；本人原声和模型继续仅留本机：

```powershell
$voicePython = '.runtime/rvc-hardware-lab/venv/Scripts/python.exe'
& $voicePython -B scripts/prepare-own-voice-rvc.py --manifest '<private raw manifest>' --source-dir '<private raw directory>' --output-dir '<new private prepared directory>' --upstream .runtime/rvc-hardware-lab/upstream
& $voicePython -B scripts/extract-own-voice-features.py --upstream .runtime/rvc-hardware-lab/upstream --prepared '<prepared directory>' --output '<new private feature directory>' --force-legacy-cuda
& $voicePython -B scripts/train-own-voice-rvc.py --upstream .runtime/rvc-hardware-lab/upstream --filelist '<feature directory>/train-filelist.txt' --output-dir '<new private check directory>' --validate-only
& $voicePython -B scripts/train-own-voice-rvc.py --upstream .runtime/rvc-hardware-lab/upstream --filelist '<feature directory>/train-filelist.txt' --output-dir '<new private pilot directory>' --steps 40 --max-seconds 300 --force-legacy-cuda
# 后续 --resume-dir '<previous successful pilot>'，--steps 为本次新增步数。
& $voicePython -B scripts/convert-own-voice-sample.py --upstream .runtime/rvc-hardware-lab/upstream --checkpoint '<successful pilot>/own_voice_pilot.pth' --input '<declared synthetic source.wav>' --source-manifest '<synthetic source.json>' --out-dir '<new private sample>' --device cuda --force-legacy-cuda --semitones -6
& $voicePython -B scripts/build-own-voice-review.py --runs '<completed sample directory>' --output '<new private review.html>' --reference '<raw own-voice trial.wav>'
```
