import type { BrowserWindowConstructorOptions } from 'electron'
import type { DisplayLike } from './geometry'

/** 默认触发热键；S9 接入设置项后由用户配置覆盖，此处是单一默认来源。 */
export const DEFAULT_FREEZE_ACCELERATOR = 'CommandOrControl+Shift+X'

/**
 * 冻结态退出键。冻结是模态语义，占用全局 Escape 不会与常态下的其它应用冲突。
 * 走全局注册而非渲染层 keydown，是为了不依赖窗口聚焦——窗口失焦时 Escape 仍能退出，
 * 避免一个置顶透明层卡住整块屏幕。
 */
export const FREEZE_EXIT_ACCELERATOR = 'Escape'

/**
 * 冻结覆盖窗的构造选项，一屏一窗。
 *
 * 关键选项的取舍：
 * - `transparent` + `backgroundColor` 全透明：窗口本身不绘制底色，冻结画面完全由渲染层
 *   的截图铺满，多出的区域透出桌面而非一块白底。
 * - `acceptFirstMouse`：macOS 上未聚焦窗口的首次点击默认只用于聚焦、不派发给内容，
 *   会让用户的第一次框选点击被吞掉；置 true 让首击同时聚焦并命中。
 * - `enableLargerThanScreen`：macOS 允许窗口覆盖整屏（含菜单栏/Dock）而不被系统裁剪。
 * - `movable/resizable/fullscreenable` 全关：冻结期窗口几何必须锁定在显示器 bounds 上，
 *   任何用户拖动/缩放都会让截图与窗口错位。
 * - `show:false`：等截图就绪、渲染层画好再显示，避免先闪一块空白再被覆盖。
 */
export function freezeWindowOptions(display: DisplayLike): BrowserWindowConstructorOptions {
  return {
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    movable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    acceptFirstMouse: true,
    enableLargerThanScreen: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }
}
