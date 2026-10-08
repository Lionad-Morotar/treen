<script setup lang="ts">
import { renderSiteHealth } from '../utils/health'

const health = renderSiteHealth('0.0.0')
</script>

<template>
  <!-- 渲染站首页：占位骨架，S7 将替换为 mermaid 渲染画布 -->
  <main data-testid="render-site-home">
    <h1>Treen Render Site</h1>
    <p data-testid="render-site-health">{{ health.service }} · v{{ health.version }}</p>
  </main>
</template>
