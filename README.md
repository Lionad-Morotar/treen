# treen

macOS 本地的截图翻译工具：全局快捷键冻结屏幕，边缘检测高亮候选区域，点击后 OCR 定位加 DeepSeek 翻译，
译文与渲染后的 mermaid 图表按包围盒原位覆盖回屏幕，可快捷键拷贝合成结果。翻译引擎与翻译图表两项可在设置中开关。

仓库当前处于工程骨架阶段：已建立 pnpm workspace 四域结构与共享配置底座，并打通冻结遮罩与全局快捷键，
其余功能链路随后续切片逐片落地。

## 技术栈

- 桌面外壳：Electron + TypeScript（`apps/desktop`）
- 渲染端：Nuxt 4 + Vite + TS（`apps/render-site`），承载 mermaid 渲染
- 共享配置层：`packages/shared`（环境读取、日志脱敏）
- 域间契约：`packages/ipc`

## 目录结构

```
apps/desktop                   桌面外壳（Electron 主进程）
apps/desktop/overlay.html      冻结遮罩的渲染层（透明全屏铺满截图）
apps/render-site               渲染端常驻本地站（Nuxt）
packages/shared                共享配置层：.env.local 读取、日志脱敏
packages/ipc                   壳与渲染端之间的 IPC 契约
```

包间以 `workspace:*` 互相引用，包体为源码直出（private、零构建），消费方直接读到 TS 源。
桌面主进程打包为 CJS 产物（`apps/desktop/out/main.cjs`）：依赖图里有 CJS 包，打成 ESM 时
rolldown 会以 `require` 兜底内建模块，而 ESM 宿主没有 `require`，应用会在加载期崩掉。

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

## 冻结遮罩

启动桌面外壳后，按 `CommandOrControl+Shift+X` 进入冻结态：每块显示器铺满一张静态截图，
覆盖窗置顶且透明，`Escape` 退出。截图以显示器物理像素抓取，负坐标副屏与混合缩放都能正确定位。
退出时覆盖窗与快捷键一并拆掉，不会留下吞点击的置顶透明层。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm lint` | ESLint 全仓检查 |
| `pnpm typecheck` | 全仓类型检查（渲染端先 `nuxt prepare`） |
| `pnpm test` | vitest 全仓单测 |
| `pnpm build` | 构建桌面主进程与渲染端 |
| `pnpm build:desktop` / `pnpm start:desktop` | 构建 / 启动桌面外壳 |
| `pnpm --filter @treen/desktop smoke:app` | 真起一次应用，断言启动与热键注册（需 GUI 会话） |
| `pnpm --filter @treen/desktop smoke:freeze` | 真实 Electron 下验证快捷键、冻结窗几何与渲染层加载 |
| `pnpm dev:render-site` / `pnpm build:render-site` | 渲染端开发服务 / 生产构建 |
