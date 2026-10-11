<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  OVERLAY_VIEWS,
  overlayScaleOf,
  overlayStyleOf,
  overlayTextStyleOf,
  type OverlayChartItem,
  type OverlayTextItem,
  type OverlayView,
} from '~/utils/dev-pipeline-overlay'

const props = defineProps<{
  imageDataUrl: string | null
  /** 覆盖计划的译文版位；坐标是图像像素 */
  texts: OverlayTextItem[]
  /** 覆盖计划的图表版位；坐标同样是图像像素 */
  charts: OverlayChartItem[]
  fontFamily: string
}>()

/**
 * 覆盖层预览：把覆盖计划按原图坐标压回原图。
 *
 * 这一步是整页存在的理由——要验的是「真机上看到的那块覆盖」，只看 SVG 验不出坐标错位。
 * 三种视图（原图 / 覆盖层 / 叠加）让人能分别在「原文长什么样」与「覆盖盖得准不准」之间切换。
 */

const view = ref<OverlayView>('both')
const frame = ref<HTMLElement | null>(null)
const image = ref<HTMLImageElement | null>(null)
const scale = ref(1)
let observer: ResizeObserver | null = null

/**
 * 换算显示比例。
 *
 * 覆盖计划的坐标是图像像素，而原图在页面里按容器宽度缩放显示，直接用像素定位会在缩放后整体
 * 偏移。比例随宽度变化，故除首次度量外还要盯着容器尺寸。
 */
function measure() {
  const element = image.value
  if (element === null) {
    return
  }
  scale.value = overlayScaleOf(element.clientWidth, element.naturalWidth)
}

onMounted(() => {
  measure()
  observer = new ResizeObserver(() => measure())
  if (frame.value !== null) {
    observer.observe(frame.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
})
</script>

<template>
  <!-- 步骤四：覆盖层预览。原图作底，译文与图表按盒定位压回原位 -->
  <div class="step">
    <div class="switch">
      <button
        v-for="mode in OVERLAY_VIEWS"
        :key="mode.value"
        class="mode"
        type="button"
        :data-testid="`dev-pipeline-overlay-view-${mode.value}`"
        :data-active="view === mode.value"
        @click="view = mode.value"
      >
        {{ mode.label }}
      </button>
      <span class="note">比例 {{ scale.toFixed(3) }}（显示尺寸 / 原图像素）</span>
    </div>

    <p v-if="imageDataUrl === null" class="empty" data-testid="dev-pipeline-overlay-empty">
      先载入一张图，再跑一次装配。
    </p>

    <div
      v-else
      ref="frame"
      class="frame"
      :data-view="view"
      data-testid="dev-pipeline-overlay-frame"
    >
      <img
        ref="image"
        class="base"
        :src="imageDataUrl"
        alt="原图"
        data-testid="dev-pipeline-overlay-image"
        @load="measure"
      />

      <div
        class="layer"
        :style="{ fontFamily: props.fontFamily }"
        data-testid="dev-pipeline-overlay-layer"
      >
        <div
          v-for="(chart, index) in charts"
          :key="`chart-${index}`"
          class="chart"
          :style="overlayStyleOf(chart, scale)"
          :data-testid="`dev-pipeline-overlay-chart-${index}`"
          v-html="chart.svg"
        />
        <div
          v-for="(text, index) in texts"
          :key="`text-${index}`"
          class="text"
          :style="overlayTextStyleOf(text, scale)"
          :data-testid="`dev-pipeline-overlay-text-${index}`"
        >
          <span v-for="(line, lineIndex) in text.lines" :key="lineIndex" class="line">{{ line }}</span>
        </div>
      </div>
    </div>

    <p
      v-if="imageDataUrl !== null && texts.length === 0 && charts.length === 0"
      class="empty"
      data-testid="dev-pipeline-overlay-empty-plan"
    >
      这个覆盖计划里既没有译文也没有图：译文与原文相同的块不产版位，图只在这次装配成功时才出现。
    </p>
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

.mode {
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
.mode[data-active='true'] {
  border-color: var(--treen-primary-border-color);
  color: var(--treen-primary-text-color);
}

.note,
.empty {
  margin: 0;
  color: var(--treen-tertiary-text-color);
  font-size: 0.72rem;
}

.frame {
  position: relative;
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--treen-secondary-border-color);
  border-radius: 6px;
}

/* 只看覆盖层时用底色铺住原图：图以 visibility 隐藏而非 display:none，
   免得版位失去参照高度后覆盖层塌成一条。 */
.frame[data-view='overlay'] {
  background: var(--treen-background);
}

.frame[data-view='overlay'] .base {
  visibility: hidden;
}

.frame[data-view='source'] .layer {
  display: none;
}

.base {
  display: block;
  width: 100%;
  height: auto;
}

.layer {
  position: absolute;
  inset: 0;
}

.chart {
  position: absolute;
}

.chart :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

.text {
  position: absolute;
  /* 到最小字号仍放不下的盒按裁剪呈现，不越界压到相邻行上 */
  overflow: hidden;
  color: var(--treen-primary-text-color);
}

.line {
  display: block;
}
</style>
