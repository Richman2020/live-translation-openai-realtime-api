# 阿里最小试听：待录稿与人工验收参考

本轮没有录音、上传或模型调用。用户可自行录制非真实通话、无私密信息的测试音频。推荐四个独立 WAV，至少中英各一，合计含静音尾部不超过24秒。每段短停顿正常保留；不要为了凑秒数加速到不自然。实际超长则重新选取较短的完整测试句，不在数字/否定/更正中间切掉尾文。

| 文件建议 | 待录原文 | 人工参考译文（不发送模型） |
| --- | --- | --- |
| zh-appointment.wav | 六月十五日下午两点，费用二百五十元。 | June fifteenth at two in the afternoon. The fee is two hundred and fifty yuan. |
| zh-correction.wav | 更正，是六月十六日，不是十五日，费用不变。 | Correction: it is June sixteenth, not the fifteenth. The fee is unchanged. |
| en-confirmation.wav | Please use the corrected date. Do not charge twice. | 请使用更正后的日期。不要重复收费。 |
| en-long.wav | I will arrive at two, but if I am late, please wait and do not cancel. | 我会两点到；但如果我迟到了，请等一下，不要取消。 |

以上只是可选稿及人工预期，不代表已有录音实际说法；不会编入ASR或翻译提示。识别原文和实际译文必须使用模型真实返回。发音不清、数字或否定错识别要分别判断ASR和文字翻译，不能用参考答案替换。

音频：RIFF WAV、线性 PCM signed16 little-endian、单声道、24000Hz。入口拒绝16k、8k、双声道、压缩或float格式，不自动转码、合成或启动麦克风。每文件SHA256和role绑定，local为本人中文，remote为对方英文；同一文件不能冒充两人。

若要报告真正一句话结束后的等待，请在每段末尾人工标注最后发声结束的 `speechEndMs`（相对于该文件开头）。它与尾部静音时长不同；不确定可以省略，报告将其标为未知。供应商的句尾/VAD时间另行记录，不能冒充人工声学标注。

已有用户 `audition_24k_mono_pcm16.wav` 是21.097333秒、mono/24k/PCM16，技术格式可用；旧OpenAI发送批准已经消耗，不等于同意发送阿里。其原文/末尾声学边界本轮未重新识别或试听。若选整份旧录音，24秒限额仅剩约2.903秒，难以覆盖完整英文、上下文和长句；建议新录上述短稿，或经用户确认选取旧录音中的完整短句后另配英文。当前没有适合本次双语验收的英文样本。

只在取得新的阿里数据发送同意、明确金额批准以及安全环境配置后使用样本；本轮不携带或上传真实WAV。
