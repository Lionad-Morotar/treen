<script setup lang="ts">
import { MERMAID_RENDER_CONFIG, stripMermaidInitDirectives } from '#shared/mermaid-theme'
import { renderSiteHealth } from '../utils/health'

const health = renderSiteHealth('0.0.0')

const source = ref('graph LR\n  A[截图] --> B[OCR 定位] --> C[DeepSeek 翻译] --> D[原位覆盖]')
const svg = ref('')
const error = ref('')
const busy = ref(false)
const size = ref('')

let sequence = 0

async function renderDiagram() {
  busy.value = true
  error.value = ''
  try {
    // mermaid 完整渲染依赖真实 DOM/CSS，只可能在浏览器跑：动态 import 并压在交互回调里，
    // 既不拖累 SSR，也避免这个重依赖进入服务端包。
    const mermaid = (await import('mermaid')).default
    mermaid.initialize(MERMAID_RENDER_CONFIG as unknown as Parameters<typeof mermaid.initialize>[0])
    sequence += 1
    // 与服务端同构地先剥 init 指令：源码是不可信输入，不允许它改掉锁定的配色。
    const { svg: output } = await mermaid.render(
      `treen-playground-${sequence}`,
      stripMermaidInitDirectives(source.value),
    )
    svg.value = output
    const viewBox = /viewBox="([^"]+)"/.exec(output)?.[1] ?? '—'
    size.value = `viewBox: ${viewBox}`
  } catch (cause) {
    svg.value = ''
    size.value = ''
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

onMounted(renderDiagram)
</script>

<template>
  <!-- mermaid 渲染画布：浏览器侧真实渲染，与服务端 /api/render 共用同一份样式锁定 -->
  <main class="playground" data-testid="mermaid-playground">
    <header class="bar">
      <h1>Treen Render Site</h1>
      <p data-testid="render-site-health">{{ health.service }} · v{{ health.version }}</p>
    </header>

    <label class="field">
      <span>mermaid 源码</span>
      <textarea
        v-model="source"
        class="source"
        data-testid="mermaid-source"
        spellcheck="false"
        rows="6"
      />
    </label>

    <div class="actions">
      <button class="render" data-testid="mermaid-render" :disabled="busy" @click="renderDiagram">
        {{ busy ? '渲染中…' : '渲染' }}
      </button>
      <span class="size" data-testid="mermaid-size">{{ size }}</span>
    </div>

    <p v-if="error" class="error" data-testid="mermaid-error">{{ error }}</p>

    <!-- mermaid 产物即画布内容；securityLevel: 'strict' 已在渲染期做消毒，故可直接注入 -->
    <div class="canvas" data-testid="mermaid-canvas" v-html="svg" />
  </main>
</template>

<style scoped>
.playground {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-height: 100vh;
  margin: 0;
  padding: 1.25rem;
  background: #0a0e14;
  color: #c8d6e5;
  font-family: ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace;
}

.bar {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
}

.bar h1 {
  margin: 0;
  font-size: 1.1rem;
  color: #22b8e6;
}

.bar p {
  margin: 0;
  font-size: 0.8rem;
  opacity: 0.65;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.8rem;
  opacity: 0.9;
}

.source {
  box-sizing: border-box;
  width: 100%;
  padding: 0.6rem;
  border: 1px solid #1c2b3a;
  border-radius: 6px;
  background: #0f1b26;
  color: #c8d6e5;
  font: inherit;
  resize: vertical;
}

.actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.render {
  padding: 0.45rem 1.1rem;
  border: 1px solid #22b8e6;
  border-radius: 6px;
  background: transparent;
  color: #3fb6e8;
  font: inherit;
  cursor: pointer;
}

.render:disabled {
  opacity: 0.5;
  cursor: progress;
}

.size {
  font-size: 0.75rem;
  opacity: 0.6;
}

.error {
  margin: 0;
  color: #ff6b6b;
  font-size: 0.8rem;
  white-space: pre-wrap;
}

.canvas {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  border: 1px solid #1c2b3a;
  border-radius: 6px;
  background: #070a10;
  overflow: auto;
}
</style>
