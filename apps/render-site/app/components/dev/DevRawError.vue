<script setup lang="ts">
import type { DevFailure } from '~/utils/dev-pipeline-client'
import { devEndpointHint } from '~/utils/dev-pipeline-client'

const props = defineProps<{ failure: DevFailure }>()

const hint = computed(() => devEndpointHint(props.failure.status))
</script>

<template>
  <!-- 失败面板：服务端吐出的响应体逐字节呈现，它是排障时唯一说明了原因的东西 -->
  <div class="failure" data-testid="dev-pipeline-raw-error">
    <p class="line">
      <span class="status">
        {{ failure.status === 0 ? '未拿到响应' : `HTTP ${failure.status}` }}
      </span>
      <span v-if="hint !== null" class="hint">{{ hint }}</span>
    </p>
    <pre v-if="failure.raw !== ''" class="raw" data-testid="dev-pipeline-raw-error-body">{{
      failure.raw
    }}</pre>
    <p v-else class="raw empty">
      响应体为空：端点可能未注册、未启动，或请求被拦在抵达服务端之前。
    </p>
  </div>
</template>

<style scoped>
.failure {
  margin-top: 0.5rem;
  padding: 0.5rem 0.6rem;
  border: 1px dashed var(--treen-title-color);
  border-radius: 6px;
  background: var(--treen-tertiary-color);
}

.line {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0 0 0.35rem;
  font-size: 0.75rem;
}

.status {
  color: var(--treen-title-color);
}

.hint {
  color: var(--treen-tertiary-text-color);
}

.raw {
  margin: 0;
  max-height: 18rem;
  overflow: auto;
  color: var(--treen-primary-text-color);
  font-family: var(--treen-font-family);
  font-size: 0.72rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.empty {
  color: var(--treen-tertiary-text-color);
}
</style>
