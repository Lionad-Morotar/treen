# treen

macOS 本地的截图翻译工具：全局快捷键冻结屏幕，边缘检测高亮候选区域，点击后 OCR 定位加 DeepSeek 翻译，
译文与渲染后的 mermaid 图表按包围盒原位覆盖回屏幕，可快捷键拷贝合成结果。翻译引擎与翻译图表两项可在设置中开关。

仓库当前处于工程骨架阶段：已建立 pnpm workspace 四域结构与共享配置底座，功能链路随后续切片逐片落地。

## 技术栈

- 桌面外壳：Electron + TypeScript（`apps/desktop`）
- 渲染端：Nuxt 4 + Vite + TS（`apps/render-site`），承载 mermaid 渲染
- 共享配置层：`packages/shared`（环境读取、日志脱敏）
- 域间契约：`packages/ipc`

## 目录结构

```
apps/desktop        桌面外壳（Electron 主进程入口）
apps/render-site    渲染端常驻本地站（Nuxt）
packages/shared     共享配置层：.env.local 读取、日志脱敏
packages/ipc        壳与渲染端之间的 IPC 契约
```

包间以 `workspace:*` 互相引用，包体为源码直出（private、零构建），消费方直接读到 TS 源。

## 环境要求

- Node `22.22.1`（见 `.node-version`）
- pnpm 12

## 快速开始

```bash
pnpm install
```

创建 `.env.local`（已被 git 忽略），填入 DeepSeek API key：

```
DEEPSEEK_KEY=sk-...
```

参考 `.env.example`。key 经 `packages/shared` 的读取器统一读取，并在日志输出前脱敏。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm lint` | ESLint 全仓检查 |
| `pnpm typecheck` | 全仓类型检查（渲染端先 `nuxt prepare`） |
| `pnpm test` | vitest 全仓单测 |
| `pnpm build` | 构建桌面主进程与渲染端 |
| `pnpm build:desktop` / `pnpm start:desktop` | 构建 / 启动桌面外壳 |
| `pnpm dev:render-site` / `pnpm build:render-site` | 渲染端开发服务 / 生产构建 |
