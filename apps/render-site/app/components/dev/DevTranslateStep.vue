<script setup lang="ts">
import type { DevFailure } from '~/utils/dev-pipeline-client'
import type { TranslationPair } from '~/utils/dev-pipeline-format'

defineProps<{
  pairs: TranslationPair[]
  failure: DevFailure | null
  /** 还没有识别结果可供翻译 */
  disabled: boolean
}>()
</script>

<template>
  <!-- 步骤二：翻译。原文与译文逐条并列，门控跳过的条目单独标出 -->
  <div class="step">
    <p v-if="disabled" class="empty" data-testid="dev-pipeline-translate-empty">
      先跑出识别结果（步骤一的文本块即翻译输入，可先编辑）。
    </p>

    <ol v-else-if="pairs.length > 0" class="pairs" data-testid="dev-pipeline-translate-pairs">
      <li v-for="(pair, index) in pairs" :key="index" class="pair">
        <span class="index">{{ index }}</span>
        <span class="source" :data-testid="`dev-pipeline-translate-source-${index}`">
          {{ pair.source }}
        </span>
        <span class="arrow">→</span>
        <span class="translation" :data-testid="`dev-pipeline-translate-target-${index}`">
          {{ pair.translation }}
        </span>
        <!-- 门控跳过意味着这条一次外部调用都没花，与「译回来刚好一样」不是一回事 -->
        <span
          v-if="pair.gated"
          class="gated"
          :data-testid="`dev-pipeline-translate-gated-${index}`"
        >
          未送译（中文门控）
        </span>
      </li>
    </ol>

    <p v-else class="empty" data-testid="dev-pipeline-translate-empty">
      {{ failure === null ? '还没跑过翻译。' : '这次没有拿到译文。' }}
    </p>

    <DevRawError v-if="failure !== null" :failure="failure" />
  </div>
</template>

<style scoped>
.step {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.pairs {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0;
  max-height: 24rem;
  overflow: auto;
  padding: 0;
  list-style: none;
}

.pair {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 0.78rem;
}

.index {
  min-width: 2rem;
  color: var(--treen-tertiary-text-color);
  font-size: 0.7rem;
  text-align: right;
}

.source {
  flex: 1;
  min-width: 0;
  color: var(--treen-tertiary-text-color);
  overflow-wrap: anywhere;
}

.arrow {
  color: var(--treen-line-color);
}

.translation {
  flex: 1;
  min-width: 0;
  color: var(--treen-primary-text-color);
  overflow-wrap: anywhere;
}

.gated {
  padding: 0.05rem 0.35rem;
  border: 1px solid var(--treen-tertiary-border-color);
  border-radius: 999px;
  color: var(--treen-tertiary-text-color);
  font-size: 0.68rem;
  white-space: nowrap;
}

.empty {
  margin: 0;
  color: var(--treen-tertiary-text-color);
  font-size: 0.75rem;
}
</style>
