<script setup lang="ts">
import { ref, watch } from 'vue'
import { MERMAID_RENDER_CONFIG, stripMermaidInitDirectives } from '#shared/mermaid-theme'
import type { DevFailure } from '~/utils/dev-pipeline-client'
import { svgIntrinsicOf, type ChartSource, type OverlayChartItem } from '~/utils/dev-pipeline-overlay'

const props = defineProps<{
  charts: OverlayChartItem[]
  /** 与 charts 同序的 mermaid 源码，浏览器侧重渲的输入 */
  sources: ChartSource[]
  diagnostics: string[]
  failure: DevFailure | null
  /** 还没有图可装配 */
  disabled: boolean
}>()

/** 图表从哪条路径来：服务端渲染与浏览器直渲，两条同屏并列以便对比。 */
type ChartPath = 'server' | 'browser'

const path = ref<ChartPath>('server')
const browserSvgs = ref<string[]>([])
const browserError = ref('')
const browserRunning = ref(false)
const browserAttempted = ref(false)

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * 浏览器内直渲一遍同一批源码。
 *
 * 与服务端结果并列是这一步的关键：服务端那条走 jsdom 垫片，浏览器这条走真实布局，两者不一致
 * 才暴露得出「OCR 干净了但服务端渲不出图」这类差异——只看浏览器结果会把问题盖住。
 *
 * mermaid 只能在浏览器跑（依赖真实 DOM/CSS），故动态 import 并压在这个回调里，不进首屏包。
 */
async function renderInBrowser() {
  if (props.sources.length === 0 || browserRunning.value) {
    return
  }
  browserRunning.value = true
  browserError.value = ''
  // 上一次的产物先清掉：留着会与新的错误信息同屏，看着像「渲出来了但报了错」。
  browserSvgs.value = []
  try {
    const mermaid = (await import('mermaid')).default
    mermaid.initialize(MERMAID_RENDER_CONFIG as unknown as Parameters<typeof mermaid.initialize>[0])
    const rendered: string[] = []
    for (const [index, entry] of props.sources.entries()) {
      // 与服务端同构地先剥 init 指令：源码来自截图 OCR，是十足的不可信输入。
      const { svg } = await mermaid.render(
        `dev-pipeline-chart-${index}`,
        stripMermaidInitDirectives(entry.source),
      )
      rendered.push(svg)
    }
    browserSvgs.value = rendered
  } catch (cause) {
    browserSvgs.value = []
    browserError.value = messageOf(cause)
  } finally {
    browserRunning.value = false
    browserAttempted.value = true
  }
}

function onPath(next: ChartPath) {
  path.value = next
  // 切到浏览器侧就渲一次：这是免费的本地渲染，但仍是显式动作，不随装配结果自动跑。
  //
  // 已尝试过（无论成败）也要重跑：OCR 出的源码不合法恰是这条链路要诊断的常态，一次失败就把
  // 重试入口关掉，等于逼人重跑整条含计费翻译的装配链路才能再看一眼。
  if (next === 'browser') {
    void renderInBrowser()
  }
}

/** 固有尺寸只能从 SVG 里读：服务端只交回版位，不交 intrinsic。读不出就照实说。 */
function intrinsicLabel(chart: OverlayChartItem): string {
  const size = svgIntrinsicOf(chart.svg)
  return size === null ? '读不出' : `${Math.round(size.width)}×${Math.round(size.height)}`
}

// 换一次装配结果，上一次的浏览器产物就不再对应这批版位；不跟着清会摆出张冠李戴的对比。
watch(
  () => props.charts,
  () => {
    browserSvgs.value = []
    browserError.value = ''
    browserAttempted.value = false
  },
)
</script>

<template>
  <!-- 步骤三：图表。同一批源码的两条渲染路径并列，服务端渲不出的原因由 diagnostics 说明 -->
  <div class="step">
    <p v-if="disabled" class="empty" data-testid="dev-pipeline-chart-empty">
      先载入一张图；这一步跑整条链路，含一次真实的翻译调用。
    </p>

    <template v-else>
      <div class="switch">
        <button
          class="path"
          type="button"
          data-testid="dev-pipeline-chart-path-server"
          :data-active="path === 'server'"
          @click="onPath('server')"
        >
          服务端 /api/render
        </button>
        <button
          class="path"
          type="button"
          data-testid="dev-pipeline-chart-path-browser"
          :data-active="path === 'browser'"
          @click="onPath('browser')"
        >
          {{ browserAttempted ? '浏览器 mermaid · 重新渲染' : '浏览器 mermaid' }}
        </button>
        <span class="note">
          浏览器渲得出而服务端渲不出，才是这条链路真正要修的那类问题
        </span>
      </div>

      <p v-if="browserError !== ''" class="error" data-testid="dev-pipeline-chart-browser-error">
        浏览器侧渲染失败：{{ browserError }}
      </p>
      <p v-else-if="browserRunning" class="note" data-testid="dev-pipeline-chart-browser-running">
        浏览器侧渲染中…
      </p>

      <ol v-if="charts.length > 0" class="charts" data-testid="dev-pipeline-chart-list">
        <li
          v-for="(chart, index) in charts"
          :key="index"
          class="chart"
          :data-testid="`dev-pipeline-chart-${index}`"
        >
          <p class="meta">
            #{{ index }} · 版位 {{ Math.round(chart.x) }},{{ Math.round(chart.y) }} ·
            {{ Math.round(chart.width) }}×{{ Math.round(chart.height) }} · 固有
            {{ intrinsicLabel(chart) }}
          </p>

          <div class="pair">
            <figure class="cell" :data-active="path === 'server'">
              <figcaption>服务端</figcaption>
              <!-- 服务端产物已过 securityLevel: 'strict' 消毒，可直接注入 -->
              <div class="canvas" v-html="chart.svg" />
            </figure>

            <figure class="cell" :data-active="path === 'browser'">
              <figcaption>浏览器</figcaption>
              <div
                v-if="browserSvgs[index] !== undefined"
                class="canvas"
                :data-testid="`dev-pipeline-chart-browser-${index}`"
                v-html="browserSvgs[index]"
              />
              <p v-else class="missing" :data-testid="`dev-pipeline-chart-browser-missing-${index}`">
                {{ browserRunning ? '渲染中…' : '未渲染' }}
              </p>
            </figure>
          </div>

          <details class="source">
            <summary>
              {{ sources[index]?.exact === true ? '源码（服务端渲染成功的那份）' : '源码（按 OCR 块还原）' }}
            </summary>
            <pre class="code" :data-testid="`dev-pipeline-chart-source-${index}`">{{
              sources[index]?.source ?? ''
            }}</pre>
            <p
              v-if="sources[index]?.exact === false"
              class="note"
              :data-testid="`dev-pipeline-chart-source-restored-${index}`"
            >
              输入为还原源码，可能与服务端候选不同
            </p>
          </details>
        </li>
      </ol>

      <p v-else class="empty" data-testid="dev-pipeline-chart-empty">
        {{ failure === null ? '这次没有装配出图。' : '这次没有拿到装配结果。' }}
      </p>

      <section class="diagnostics">
        <h3 class="label">诊断</h3>
        <ul v-if="diagnostics.length > 0" class="lines" data-testid="dev-pipeline-chart-diagnostics">
          <li v-for="(line, index) in diagnostics" :key="index" class="line">{{ line }}</li>
        </ul>
        <p v-else class="note" data-testid="dev-pipeline-chart-diagnostics">
          链路没有留下 warn 级日志。
        </p>
      </section>
    </template>

    <DevRawError v-if="failure !== null" :failure="failure" />
  </div>
</template>

<style scoped>
.step {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.switch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.path {
  padding: 0.2rem 0.6rem;
  border: 1px solid var(--treen-secondary-border-color);
  border-radius: 999px;
  background: transparent;
  color: var(--treen-secondary-text-color);
  font: inherit;
  font-size: 0.72rem;
  cursor: pointer;
}

/* 选中态只换描边与文字色：边框始终在，切换不引起位移 */
.path[data-active='true'] {
  border-color: var(--treen-primary-border-color);
  color: var(--treen-primary-text-color);
}

.note,
.error,
.missing,
.meta {
  margin: 0;
  color: var(--treen-tertiary-text-color);
  font-size: 0.72rem;
}

.error {
  color: var(--treen-title-color);
}

.charts {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
}

.cell {
  margin: 0;
  padding: 0.4rem;
  border: 1px solid var(--treen-secondary-border-color);
  border-radius: 6px;
  background: var(--treen-tertiary-color);
  opacity: 0.45;
}

.cell[data-active='true'] {
  border-color: var(--treen-primary-border-color);
  opacity: 1;
}

.cell figcaption {
  margin-bottom: 0.3rem;
  color: var(--treen-tertiary-text-color);
  font-size: 0.7rem;
}

.canvas {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 6rem;
  overflow: auto;
}

/* 注入的 SVG 自带像素宽高，按容器铺满才能与版位对齐 */
.canvas :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

.source {
  margin-top: 0.35rem;
}

.source summary {
  color: var(--treen-tertiary-text-color);
  font-size: 0.72rem;
  cursor: pointer;
}

.code {
  margin: 0.3rem 0 0;
  max-height: 12rem;
  overflow: auto;
  padding: 0.4rem;
  border-radius: 4px;
  background: var(--treen-background);
  color: var(--treen-primary-text-color);
  font-family: var(--treen-font-family);
  font-size: 0.7rem;
  white-space: pre-wrap;
}

.diagnostics {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.label {
  margin: 0;
  color: var(--treen-secondary-text-color);
  font-size: 0.75rem;
  font-weight: inherit;
}

.lines {
  margin: 0;
  padding-left: 1.1rem;
}

.line {
  color: var(--treen-secondary-text-color);
  font-size: 0.72rem;
}

.empty {
  margin: 0;
  color: var(--treen-tertiary-text-color);
  font-size: 0.75rem;
}
</style>
