<script setup lang="ts">
import { formatDuration } from '~/utils/dev-pipeline-format'

export type PanelStatus = 'idle' | 'running' | 'done' | 'failed'

const props = withDefaults(
  defineProps<{
    title: string
    /** data-testid 前缀；面板内的可断言节点由此派生 */
    testId: string
    status?: PanelStatus
    /** null 表示这一步还没跑过，不占位置 */
    elapsedMs?: number | null
    defaultOpen?: boolean
    /** 折叠时也要留在标题行上的摘要（如「12 块」），避免收起后完全看不出结果 */
    summary?: string
  }>(),
  { status: 'idle', elapsedMs: null, defaultOpen: true, summary: '' },
)

// 折叠状态是纯展示态，不外提：面板之间互不影响，也没有父级需要据此改布局。
const open = ref(props.defaultOpen)

const STATUS_TEXT: Record<PanelStatus, string> = {
  idle: '待运行',
  running: '运行中',
  done: '完成',
  failed: '失败',
}
</script>

<template>
  <!-- 步骤面板：长列表（识别块、译文）默认可收起，免得把整页撑爆 -->
  <section class="panel" :data-testid="testId">
    <header class="head">
      <button
        class="toggle"
        type="button"
        :data-testid="`${testId}-toggle`"
        :aria-expanded="open"
        @click="open = !open"
      >
        <span class="caret">{{ open ? '▾' : '▸' }}</span>
        <span class="title">{{ title }}</span>
      </button>

      <span class="status" :data-status="status" :data-testid="`${testId}-status`">
        {{ STATUS_TEXT[status] }}
      </span>
      <span v-if="summary !== ''" class="summary" :data-testid="`${testId}-summary`">
        {{ summary }}
      </span>
      <span v-if="elapsedMs !== null" class="elapsed" :data-testid="`${testId}-elapsed`">
        {{ formatDuration(elapsedMs) }}
      </span>

      <span class="actions">
        <slot name="actions" />
      </span>
    </header>

    <div v-show="open" class="body" :data-testid="`${testId}-body`">
      <slot />
    </div>
  </section>
</template>

<style scoped>
/* 色值一律走页面根注入的 --treen-*：本仓配色唯一真源是 #shared/mermaid-theme。 */
.panel {
  border: 1px solid var(--treen-secondary-border-color);
  border-radius: 6px;
  background: var(--treen-primary-color);
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.7rem;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--treen-title-color);
  font: inherit;
  cursor: pointer;
}

.caret {
  width: 0.8rem;
  color: var(--treen-node-border);
}

.title {
  font-size: 0.9rem;
}

.status {
  padding: 0.05rem 0.4rem;
  border: 1px solid var(--treen-tertiary-border-color);
  border-radius: 999px;
  color: var(--treen-tertiary-text-color);
  font-size: 0.7rem;
}

.status[data-status='running'] {
  border-color: var(--treen-node-border);
  color: var(--treen-line-color);
}

.status[data-status='done'] {
  border-color: var(--treen-primary-border-color);
  color: var(--treen-primary-text-color);
}

/* 失败态不给新色值（主题里没有红色，页面也不许自带字面色）：用最高对比的标题色 +
   深底 + 虚线，配合下方整段原始错误响应体，足以把它与「完成」区分开。 */
.status[data-status='failed'] {
  border-style: dashed;
  border-color: var(--treen-title-color);
  background: var(--treen-tertiary-color);
  color: var(--treen-title-color);
}

.summary,
.elapsed {
  color: var(--treen-tertiary-text-color);
  font-size: 0.72rem;
}

.actions {
  display: inline-flex;
  gap: 0.4rem;
  margin-left: auto;
}

.body {
  padding: 0 0.7rem 0.7rem;
}
</style>
