<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { MERMAID_THEME_VARIABLES } from '#shared/mermaid-theme'
import { RENDER_SITE_ROUTES } from '@treen/ipc/routes'
import {
  callOcr,
  callPipeline,
  callSample,
  callSamples,
  callTranslate,
  dataUrlOf,
  type DevFailure,
  type OcrBlockPayload,
  type PipelinePlan,
  type SamplesResponse,
} from '~/utils/dev-pipeline-client'
import {
  bytesOfDataUrl,
  imagePayloadWarning,
  isImageFile,
  pairTranslations,
  themeCssVariables,
  toEditableBlocks,
  type EditableBlock,
  type TranslationPair,
} from '~/utils/dev-pipeline-format'
import { chartSourcesOf } from '~/utils/dev-pipeline-overlay'
import { devPageEnabled } from '~/utils/dev-pages'
import type { RenderSiteHealth } from '~/utils/health'

/**
 * `/dev/pipeline`：把「拿图 → OCR → 翻译 → 图表 → 覆盖层」这条链摊开成可逐步重跑的调试台。
 *
 * 每一步的中间态都摆在页面上（识别块可编辑、译文逐条并列、图表两条渲染路径同屏、覆盖层压回
 * 原图、失败时整段保留服务端响应体），因为这条链的价值就在于定位「哪一步、为什么不对」——
 * 只给最终结果等于没有调试信息。
 *
 * 页面只在浏览器跑（`ssr: false`），故可直接使用 window / FileReader。
 */

/**
 * 配色桥：把 mermaid 主题变量翻成 CSS 变量注入根节点一次，子树样式一律用 `var(--treen-*)`。
 *
 * 选注入而非在 scoped 里生成样式表，是因为主题是 TS 常量、织不进 CSS 文本；桥一次即可让
 * 页面与渲染产物共用同一份配色真源，页面里因此不再出现任何字面色值。
 */
const themeVars = themeCssVariables(MERMAID_THEME_VARIABLES)

/** 运行期兜底：构建期摘路由若因环境判定失准而漏摘，页面在这里自行空掉。 */
const devEnabled = devPageEnabled(import.meta.dev)

const health = ref<RenderSiteHealth | null>(null)
const healthNote = ref('')

const image = ref<{ name: string; dataUrl: string; bytes: number } | null>(null)
const imageWarning = ref<string | null>(null)
const notice = ref('')

const samples = ref<SamplesResponse['samples']>([])
const samplesHint = ref('')
const sampleLoading = ref(false)

const ocrBlocks = ref<EditableBlock[]>([])
const ocrElapsed = ref<number | null>(null)
const ocrFailure = ref<DevFailure | null>(null)
const ocrRunning = ref(false)

const pairs = ref<TranslationPair[]>([])
const translateElapsed = ref<number | null>(null)
const translateFailure = ref<DevFailure | null>(null)
const translateRunning = ref(false)

const plan = ref<PipelinePlan | null>(null)
/** 装配那一次自己识别到的块：图表版位由它们求出，故源码还原也只认这一批 */
const planBlocks = ref<OcrBlockPayload[]>([])
const diagnostics = ref<string[]>([])
const chartElapsed = ref<number | null>(null)
const chartFailure = ref<DevFailure | null>(null)
const chartRunning = ref(false)

const dragging = ref(false)

const chartSources = computed(() => chartSourcesOf(planBlocks.value, plan.value?.charts ?? []))

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function loadHealth() {
  try {
    const response = await fetch(RENDER_SITE_ROUTES.health)
    health.value = (await response.json()) as RenderSiteHealth
  } catch (cause) {
    healthNote.value = `渲染站健康接口取不到：${messageOf(cause)}`
  }
}

async function loadSamples() {
  const result = await callSamples()
  if (!result.ok) {
    samples.value = []
    // 404 是运行时门禁按环境挡的，端点本身一直在路由表上：照实说，否则排障会去查路由表。
    samplesHint.value =
      result.status === 404
        ? '样本库端点在当前实例上不可用：dev 端点已注册，非 dev 环境一律 404'
        : `样本清单取不到（HTTP ${result.status}）`
    return
  }
  samples.value = result.data.samples
  samplesHint.value =
    result.data.root === null
      ? '样本目录不存在：本页读的是仓库根的 zRefs，它不在版本库里'
      : result.data.samples.length === 0
        ? '样本目录里还没有 PNG/JPEG'
        : ''
}

/**
 * 作废全部下游结果。
 *
 * 识别块、译文与覆盖计划都是针对某一张具体图而言的，图一变它们就同时失去所指；留着不只是
 * 误导，还会让「跑翻译」拿一张已不存在的图的文本去打计费端点。
 */
function invalidateDownstream() {
  ocrBlocks.value = []
  ocrElapsed.value = null
  ocrFailure.value = null
  pairs.value = []
  translateElapsed.value = null
  translateFailure.value = null
  invalidatePlan()
}

/** 作废图表与覆盖层：版位是针对某一批识别块算出来的，块一改它们就整体失准。 */
function invalidatePlan() {
  plan.value = null
  planBlocks.value = []
  diagnostics.value = []
  chartElapsed.value = null
  chartFailure.value = null
}

function setImage(name: string, dataUrl: string) {
  notice.value = ''
  image.value = { name, dataUrl, bytes: bytesOfDataUrl(dataUrl) }
  imageWarning.value = imagePayloadWarning(image.value.bytes)
  invalidateDownstream()
}

function clearImage() {
  image.value = null
  imageWarning.value = null
  notice.value = ''
  invalidateDownstream()
}

async function onPick(file: File) {
  notice.value = ''
  if (!isImageFile(file)) {
    notice.value = `只收 PNG 或 JPEG：${file.name}`
    return
  }
  try {
    setImage(file.name, await readAsDataUrl(file))
  } catch (cause) {
    notice.value = `读不出这个文件：${messageOf(cause)}`
  }
}

/**
 * 转 data URL 时不做任何缩放：OCR 的坐标语义是原图像素，重采样会让落点与后续覆盖层
 * 对不上。大图的代价只提示、不静默处理。
 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('FileReader 失败'))
    reader.readAsDataURL(file)
  })
}

async function onSample(name: string) {
  notice.value = ''
  sampleLoading.value = true
  try {
    const result = await callSample(name)
    sampleLoading.value = false
    if (!result.ok) {
      notice.value = `样本读不到（HTTP ${result.status}）`
      return
    }
    setImage(result.data.name, dataUrlOf(result.data))
  } catch (cause) {
    sampleLoading.value = false
    notice.value = `样本读不到：${messageOf(cause)}`
  }
}

async function runOcr() {
  const current = image.value
  if (current === null) {
    return
  }
  ocrRunning.value = true
  ocrFailure.value = null
  try {
    const result = await callOcr(current.dataUrl)
    ocrRunning.value = false
    // 失败也要记耗时：这一步到底慢在哪，是失败时同样要回答的问题。
    ocrElapsed.value = result.elapsedMs
    if (!result.ok) {
      ocrFailure.value = result
      return
    }
    ocrBlocks.value = toEditableBlocks(result.data.blocks)
    ocrElapsed.value = result.data.elapsedMs
    // 输入变了，上一次的译文与版位都不再对应当前文本块。
    pairs.value = []
    translateElapsed.value = null
    translateFailure.value = null
    invalidatePlan()
  } catch (cause) {
    ocrRunning.value = false
    ocrFailure.value = { ok: false, status: 0, raw: messageOf(cause), elapsedMs: 0 }
  }
}

/**
 * 翻译只由按钮触发。
 *
 * 这条端点真会调计费的外部 API，页面里任何自动重试、轮询或「顺手再译一次」都会把费用
 * 变成不可控的量；失败就停在失败上，由人决定要不要再来一次。
 */
async function runTranslate() {
  if (ocrBlocks.value.length === 0) {
    return
  }
  translateRunning.value = true
  translateFailure.value = null
  const texts = ocrBlocks.value.map((block) => block.text)
  try {
    const result = await callTranslate(texts)
    translateRunning.value = false
    translateElapsed.value = result.elapsedMs
    if (!result.ok) {
      translateFailure.value = result
      return
    }
    pairs.value = pairTranslations(texts, result.data.translations, result.data.gated)
  } catch (cause) {
    translateRunning.value = false
    translateFailure.value = { ok: false, status: 0, raw: messageOf(cause), elapsedMs: 0 }
  }
}

/**
 * 跑整条装配链路，拿到图表与覆盖计划。
 *
 * 与翻译同理，只由按钮发起：这一条端点内部就含一次计费的翻译调用与一次渲染往返，页面里
 * 任何自动触发（含失败重试）都会把外部调用的量变成不可控。
 */
async function runCharts() {
  const current = image.value
  if (current === null) {
    return
  }
  chartRunning.value = true
  chartFailure.value = null
  try {
    const result = await callPipeline(current.dataUrl)
    chartRunning.value = false
    chartElapsed.value = result.elapsedMs
    if (!result.ok) {
      chartFailure.value = result
      return
    }
    plan.value = result.data.plan
    planBlocks.value = result.data.blocks
    diagnostics.value = result.data.diagnostics
  } catch (cause) {
    chartRunning.value = false
    chartFailure.value = { ok: false, status: 0, raw: messageOf(cause), elapsedMs: 0 }
  }
}

function onDragOver(event: DragEvent) {
  event.preventDefault()
  dragging.value = true
}

function onDragLeave(event: DragEvent) {
  event.preventDefault()
  dragging.value = false
}

function onDrop(event: DragEvent) {
  event.preventDefault()
  dragging.value = false
  const file = event.dataTransfer?.files.item(0) ?? null
  if (file !== null) {
    void onPick(file)
  }
}

/** 焦点落在这类元素上时，Cmd+V 是编辑文本而不是换图。 */
function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  )
}

/**
 * 粘贴取图：截图后不落盘直接粘贴是最快的回归路径。
 *
 * 只在焦点不在可编辑元素时接管：识别块就是一排输入框，在框里粘贴却被换成另一张图，
 * 会静默丢掉刚编辑完的文本。接管时掐掉默认行为，免得浏览器把图片再往可编辑区插一次。
 */
function onPaste(event: ClipboardEvent) {
  if (isEditingTarget(event.target)) {
    return
  }
  const file = event.clipboardData?.files.item(0) ?? null
  if (file === null) {
    return
  }
  event.preventDefault()
  void onPick(file)
}

onMounted(() => {
  // 空态下不该再去探 dev 端点：页面都不可用，探测只会换来一堆门禁 404。
  if (!devEnabled) {
    return
  }
  void loadHealth()
  void loadSamples()
  window.addEventListener('paste', onPaste)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
})

onUnmounted(() => {
  window.removeEventListener('paste', onPaste)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
})
</script>

<template>
  <!-- 运行期兜底：debug 内容只在 dev 环境露出，构建期摘路由漏判时这一道兜住 -->
  <p v-if="!devEnabled" class="page-off" data-testid="dev-pipeline-page-disabled">
    调试台只在 dev 环境渲染。
  </p>

  <!-- 调试台根节点：主题变量在这里注入一次，拖拽与粘贴的监听也挂在页面级 -->
  <main
    v-else
    class="page"
    :class="{ dragging }"
    :style="themeVars"
    data-testid="dev-pipeline-page"
  >
    <header class="bar">
      <h1>Treen Pipeline 调试台</h1>
      <p data-testid="dev-pipeline-health">
        <template v-if="health !== null">
          {{ health.service }} · v{{ health.version }} · {{ health.ok ? '就绪' : '未就绪' }}
        </template>
        <template v-else-if="healthNote !== ''">{{ healthNote }}</template>
        <template v-else>正在探测渲染站…</template>
      </p>
    </header>

    <p class="intro">
      这条页面跑的是渲染站自己的 dev 端点：图不出本机，但翻译会真的调用计费的外部 API，
      每一次翻译都需要你按下按钮；图表那一步跑的是整条链路，同样含一次真实翻译。
    </p>

    <!-- 取图：文件选择、拖拽、粘贴、样本库四个入口 -->
    <DevPanel title="取图" test-id="dev-pipeline-source">
      <DevImageSource
        :samples="samples"
        :samples-hint="samplesHint"
        :image-name="image?.name ?? null"
        :image-bytes="image?.bytes ?? null"
        :image-data-url="image?.dataUrl ?? null"
        :warning="imageWarning"
        :notice="notice"
        :sample-loading="sampleLoading"
        @pick="onPick"
        @sample="onSample"
        @clear="clearImage"
      />
    </DevPanel>

    <!-- 步骤一：OCR。识别块可编辑，改完即翻译的输入 -->
    <DevPanel
      title="步骤一 · OCR"
      test-id="dev-pipeline-ocr"
      :status="ocrRunning ? 'running' : ocrFailure !== null ? 'failed' : ocrElapsed !== null ? 'done' : 'idle'"
      :elapsed-ms="ocrElapsed"
      :summary="ocrBlocks.length > 0 ? `${ocrBlocks.length} 块` : ''"
    >
      <template #actions>
        <button
          class="run"
          type="button"
          data-testid="dev-pipeline-ocr-run"
          :disabled="ocrRunning || image === null"
          @click="runOcr"
        >
          {{ ocrRunning ? '识别中…' : ocrElapsed === null ? '跑 OCR' : '重跑 OCR' }}
        </button>
      </template>

      <DevOcrStep
        :blocks="ocrBlocks"
        :failure="ocrFailure"
        :disabled="image === null"
        @update="ocrBlocks = $event"
      />
    </DevPanel>

    <!-- 步骤二：翻译。原文与译文逐条并列，门控跳过的条目单独标出 -->
    <DevPanel
      title="步骤二 · 翻译"
      test-id="dev-pipeline-translate"
      :status="translateRunning ? 'running' : translateFailure !== null ? 'failed' : translateElapsed !== null ? 'done' : 'idle'"
      :elapsed-ms="translateElapsed"
      :summary="pairs.length > 0 ? `${pairs.length} 条` : ''"
    >
      <template #actions>
        <button
          class="run"
          type="button"
          data-testid="dev-pipeline-translate-run"
          :disabled="translateRunning || ocrBlocks.length === 0"
          @click="runTranslate"
        >
          {{ translateRunning ? '翻译中…' : translateElapsed === null ? '跑翻译' : '重跑翻译' }}
        </button>
      </template>

      <DevTranslateStep
        :pairs="pairs"
        :failure="translateFailure"
        :disabled="ocrBlocks.length === 0"
      />
    </DevPanel>

    <!-- 步骤三：图表。服务端与浏览器两条渲染路径同屏并列，渲不出的原因由 diagnostics 说明 -->
    <DevPanel
      title="步骤三 · 图表"
      test-id="dev-pipeline-chart"
      :status="chartRunning ? 'running' : chartFailure !== null ? 'failed' : chartElapsed !== null ? 'done' : 'idle'"
      :elapsed-ms="chartElapsed"
      :summary="plan !== null ? `${plan.charts.length} 张` : ''"
    >
      <template #actions>
        <button
          class="run"
          type="button"
          data-testid="dev-pipeline-chart-run"
          :disabled="chartRunning || image === null"
          @click="runCharts"
        >
          {{ chartRunning ? '装配中…' : chartElapsed === null ? '跑图表' : '重跑图表' }}
        </button>
      </template>

      <DevChartStep
        :charts="plan?.charts ?? []"
        :sources="chartSources"
        :diagnostics="diagnostics"
        :failure="chartFailure"
        :disabled="image === null"
      />
    </DevPanel>

    <!-- 步骤四：覆盖层。原图作底，译文与图表按像素版位压回原位 -->
    <DevPanel
      title="步骤四 · 覆盖层预览"
      test-id="dev-pipeline-overlay"
      :status="plan === null ? 'idle' : 'done'"
      :summary="plan === null ? '' : `${plan.texts.length} 段译文 · ${plan.charts.length} 张图`"
    >
      <DevOverlayPreview
        :image-data-url="image?.dataUrl ?? null"
        :texts="plan?.texts ?? []"
        :charts="plan?.charts ?? []"
        :font-family="plan?.fontFamily ?? ''"
      />
    </DevPanel>
  </main>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  min-height: 100vh;
  margin: 0;
  padding: 1.25rem;
  background: var(--treen-background);
  color: var(--treen-primary-text-color);
  font-family: var(--treen-font-family);
  font-size: var(--treen-font-size);
}

/* 拖拽中不改盒模型尺寸，只换描边颜色，避免落点位移 */
.page.dragging {
  outline: 1px dashed var(--treen-node-border);
  outline-offset: -4px;
}

.bar {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
}

.bar h1 {
  margin: 0;
  font-size: 1.1rem;
  color: var(--treen-line-color);
}

.bar p {
  margin: 0;
  color: var(--treen-tertiary-text-color);
  font-size: 0.8rem;
}

.intro,
.hint {
  margin: 0;
  color: var(--treen-tertiary-text-color);
  font-size: 0.75rem;
}

.page-off {
  margin: 0;
  padding: 1.25rem;
  color: var(--treen-tertiary-text-color);
  font-family: var(--treen-font-family);
  font-size: 0.85rem;
}

.run {
  padding: 0.3rem 0.9rem;
  border: 1px solid var(--treen-node-border);
  border-radius: 6px;
  background: transparent;
  color: var(--treen-line-color);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.run:disabled {
  opacity: 0.5;
  cursor: progress;
}
</style>
