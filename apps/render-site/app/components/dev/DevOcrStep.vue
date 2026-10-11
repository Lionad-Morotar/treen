<script setup lang="ts">
import type { DevFailure } from '~/utils/dev-pipeline-client'
import type { EditableBlock } from '~/utils/dev-pipeline-format'

const props = defineProps<{
  blocks: EditableBlock[]
  failure: DevFailure | null
  /** 还没有图，或图已被换掉 */
  disabled: boolean
}>()

const emit = defineEmits<{ update: [blocks: EditableBlock[]] }>()

/**
 * 改一条文本即整份换新。
 *
 * 列表是下一步（翻译）的输入源，直接改对象会让「改之前识别到的是什么」无从对照；
 * 换新数组也让父级的改动可追踪，不必靠深层次变更去触发更新。
 */
function onText(index: number, value: string) {
  emit(
    'update',
    props.blocks.map((block, at) => (at === index ? { ...block, text: value } : block)),
  )
}

function valueOf(event: Event): string {
  const target = event.target
  return target instanceof HTMLInputElement ? target.value : ''
}
</script>

<template>
  <!-- 步骤一：OCR。列表可编辑，改完的文本直接作为翻译的输入 -->
  <div class="step">
    <p v-if="disabled" class="empty" data-testid="dev-pipeline-ocr-empty">
      先载入一张图（文件、拖拽、粘贴或样本库）。
    </p>

    <template v-else>
      <ol v-if="blocks.length > 0" class="blocks" data-testid="dev-pipeline-ocr-blocks">
        <li v-for="(block, index) in blocks" :key="index" class="block">
          <span class="index">{{ index }}</span>
          <input
            class="text"
            :value="block.text"
            :data-testid="`dev-pipeline-ocr-text-${index}`"
            @input="onText(index, valueOf($event))"
          />
          <span class="conf" :title="`置信度 ${block.confidence}`">
            {{ block.confidence.toFixed(2) }}
          </span>
          <span class="box">
            {{ Math.round(block.box.x) }},{{ Math.round(block.box.y) }}
            · {{ Math.round(block.box.width) }}×{{ Math.round(block.box.height) }}
          </span>
        </li>
      </ol>
      <p v-else class="empty" data-testid="dev-pipeline-ocr-empty">
        {{ failure === null ? '还没跑过 OCR。' : '这次没有拿到识别结果。' }}
      </p>
    </template>

    <!-- 原始错误响应体整段摆在面板上：415/400 里的那句话是唯一的排障依据 -->
    <DevRawError v-if="failure !== null" :failure="failure" />
  </div>
</template>

<style scoped>
.step {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.blocks {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0;
  max-height: 24rem;
  overflow: auto;
  padding: 0;
  list-style: none;
}

.block {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.index {
  min-width: 2rem;
  color: var(--treen-tertiary-text-color);
  font-size: 0.7rem;
  text-align: right;
}

.text {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  padding: 0.25rem 0.45rem;
  border: 1px solid var(--treen-secondary-border-color);
  border-radius: 4px;
  background: var(--treen-tertiary-color);
  color: var(--treen-primary-text-color);
  font: inherit;
  font-size: 0.78rem;
}

.conf {
  min-width: 3rem;
  color: var(--treen-tertiary-text-color);
  font-size: 0.7rem;
  text-align: right;
}

.box {
  min-width: 9rem;
  color: var(--treen-tertiary-text-color);
  font-size: 0.7rem;
  text-align: right;
}

.empty {
  margin: 0;
  color: var(--treen-tertiary-text-color);
  font-size: 0.75rem;
}
</style>
