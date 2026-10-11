<script setup lang="ts">
import { formatBytes } from '~/utils/dev-pipeline-format'

defineProps<{
  samples: Array<{ name: string; size: number }>
  /** 样本库的空态或取不到的说明；空串表示正常 */
  samplesHint: string
  imageName: string | null
  imageBytes: number | null
  /** 已载入图的 data URL；用于回显，确认「这张」确实是刚载入的那张 */
  imageDataUrl: string | null
  /** 超大图提示；null 表示没有 */
  warning: string | null
  /** 收图环节的本地提示（格式不符、样本读不到等） */
  notice: string
  sampleLoading: boolean
}>()

const emit = defineEmits<{
  pick: [file: File]
  sample: [name: string]
  clear: []
}>()

const selected = ref('')

function onFileChange(event: Event) {
  const input = event.target
  if (!(input instanceof HTMLInputElement)) {
    return
  }
  const file = input.files?.item(0) ?? null
  if (file !== null) {
    emit('pick', file)
  }
  // 清空 value：连续选同一个文件也要能再触发一次 change，否则换图无效。
  input.value = ''
}
</script>

<template>
  <!-- 取图入口：文件选择、样本库下拉在此；拖拽与粘贴挂在页面根节点上（见 dev/pipeline.vue） -->
  <div class="source">
    <div class="row">
      <label class="field">
        <span class="label">文件选择</span>
        <input
          type="file"
          accept="image/png,image/jpeg"
          data-testid="dev-pipeline-file"
          @change="onFileChange"
        />
      </label>

      <label class="field">
        <span class="label">样本库（zRefs）</span>
        <span class="inline">
          <select v-model="selected" data-testid="dev-pipeline-sample-select">
            <option value="">— 选择样本 —</option>
            <option v-for="sample in samples" :key="sample.name" :value="sample.name">
              {{ sample.name }} · {{ formatBytes(sample.size) }}
            </option>
          </select>
          <button
            type="button"
            data-testid="dev-pipeline-sample-load"
            :disabled="selected === '' || sampleLoading"
            @click="emit('sample', selected)"
          >
            {{ sampleLoading ? '载入中…' : '载入' }}
          </button>
        </span>
      </label>
    </div>

    <p v-if="samplesHint !== ''" class="hint" data-testid="dev-pipeline-samples-hint">
      {{ samplesHint }}
    </p>

    <p class="hint">
      也可以直接把图拖到页面上，或在页面里粘贴剪贴板里的图片。
    </p>

    <p v-if="notice !== ''" class="notice" data-testid="dev-pipeline-notice">{{ notice }}</p>
    <p v-if="warning !== null" class="warning" data-testid="dev-pipeline-warning">{{ warning }}</p>

    <p v-if="imageName !== null" class="meta" data-testid="dev-pipeline-image-info">
      <span class="name">{{ imageName }}</span>
      <span v-if="imageBytes !== null">{{ formatBytes(imageBytes) }}</span>
      <button type="button" data-testid="dev-pipeline-image-clear" @click="emit('clear')">
        清除
      </button>
    </p>
    <p v-else class="meta idle" data-testid="dev-pipeline-image-empty">还没有图</p>

    <img
      v-if="imageDataUrl !== null"
      class="preview"
      :src="imageDataUrl"
      alt="已载入的图"
      data-testid="dev-pipeline-image-preview"
    />
  </div>
</template>

<style scoped>
.source {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.label {
  color: var(--treen-tertiary-text-color);
  font-size: 0.72rem;
}

.inline {
  display: inline-flex;
  gap: 0.4rem;
}

select,
button,
input[type='file'] {
  box-sizing: border-box;
  max-width: 22rem;
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--treen-secondary-border-color);
  border-radius: 6px;
  background: var(--treen-tertiary-color);
  color: var(--treen-primary-text-color);
  font: inherit;
  font-size: 0.78rem;
}

button {
  cursor: pointer;
}

button:disabled {
  opacity: 0.5;
  cursor: progress;
}

.hint {
  margin: 0;
  color: var(--treen-tertiary-text-color);
  font-size: 0.72rem;
}

.notice {
  margin: 0;
  color: var(--treen-title-color);
  font-size: 0.75rem;
}

.warning {
  margin: 0;
  padding: 0.35rem 0.5rem;
  border: 1px dashed var(--treen-title-color);
  border-radius: 6px;
  color: var(--treen-title-color);
  font-size: 0.75rem;
}

.meta {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin: 0;
  color: var(--treen-primary-text-color);
  font-size: 0.75rem;
}

.preview {
  align-self: flex-start;
  max-width: 100%;
  max-height: 14rem;
  border: 1px solid var(--treen-secondary-border-color);
  border-radius: 6px;
  background: var(--treen-cluster-bkg);
}

.meta.idle {
  color: var(--treen-tertiary-text-color);
}

.name {
  overflow: hidden;
  max-width: 24rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
