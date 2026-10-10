/**
 * mermaid 检测/归一化测试的共用样本。
 *
 * `SCREENSHOT_SOURCE` 取自 zRefs/image.png（VS Code 截图）主编辑区那段未渲染的 mermaid 源码，
 * 逐行对照截图像素抄录，是「真样本」；`SCREENSHOT_OCR_ROI` 是同一段经 mac-ocr 在框选 ROI 形态下的
 * 真实识别输出（含 OCR 劣化：整角括号、<br/›、粘连），两者对照能同时钉住「正常源」与「劣化源」两条路。
 *
 * 真机样本只有这一份：桌面壳里走 mermaid.parse 真校验的那两个 spec 跨包引它，复制成桌面侧的第二份
 * 就会让两边的样本各自漂移——真样本的价值全在它是同一段真实输出。
 */

/** 真截图里那段 mermaid 源码的原文（人眼逐行核对）。 */
export const SCREENSHOT_SOURCE = `mermaid
graph LR
    WAV[track_full.wav] --> A[实测拍网格 beats<br/>beat_times_full.json]
    WAV --> B1[beat_this 神经拍追踪]
    WAV --> B2[madmom DBN 拍/小节追踪]
    A -->|作为参照系分段+对照|C[三方拍表分歧 beats_multi<br/>compare_anchors.py]
    B1 --> C
    B2 --> C`

/** 同一段经 mac-ocr 在框选 ROI 下的真实输出。 */
export const SCREENSHOT_OCR_ROI = `mermaid
graph LR
WAV[track_full.wav] --> A[B 30$#t beats<br/›beat_ times_full.json]
WAV --> BI［beat_this 神经拍追踪］
WAV --> B2［madmom DBN 拍/小节追踪］
A -->|作为参照系分段＋对照| C［三方拍表分歧 beats_multisbr/>compare_anchors.py］
B1 --> C
B2 --> C`

/** 同屏正文里提到 graph 的一句（真样本里的反例）。 */
export const PROSE_MENTIONING_GRAPH = '生成脚本是前案带过来的 data/prior-261007/analyze_deep.py，comb 模板 graph 在给定区间以 0.02 BPM 步进扫，总和最大者即最大似然拟合'
