// 截图翻译链路的桌面侧公开面：纯逻辑与注入式编排已下沉到 @treen/shared，这里只把它们与
// 依赖冻结/选区域的装配（link）一起透出，避免调用方分别记住两套入口。
export * from '@treen/shared/translation'
export * from './link'
