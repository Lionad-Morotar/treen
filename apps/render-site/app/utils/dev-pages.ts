/**
 * dev 页面在生产产物里的摘除判定（纯逻辑，供 `nuxt.config.ts` 的 `pages:extend` 调用）。
 *
 * 摘的是**路由**而不是运行时重定向：`/dev/pipeline` 这页会把本机的 OCR 结果与译文原样摊开，
 * 重定向只挡住访问、页面代码与它依赖的那批 dev 端点调用照样进产物。摘掉路由后打包器也一并
 * 摇掉这页独有的代码，产物里不再有它。
 *
 * 判定与摘除分开成两个导出：前者给「这条路径归不归 dev」一个可断言的答案，后者才是钩子用的
 * 过滤器——两者合一就得为了测后者而构造整套页面对象。
 */

/** Nuxt 页面对象里本判定用到的那部分形状；`children` 让嵌套路由整棵跟着走。 */
export interface DevPageLike {
  path?: string
  children?: DevPageLike[]
}

/** `/dev` 自身及其子路径算 dev 页面；`path` 缺省（未命名路由）一律不摘，宁可留着也不误删。 */
export function isDevPagePath(path: string | undefined): boolean {
  if (typeof path !== 'string') {
    return false
  }
  return path === '/dev' || path.startsWith('/dev/')
}

/**
 * 非 dev 时摘掉 dev 页面；dev 时原样返回同一份数组本身。
 *
 * 返回新数组而不就地删：钩子拿到的数组是 Nuxt 自己的，`pages:extend` 之后还有别的消费者读它，
 * 就地 splice 会把摘除的副作用扩散到注册顺序之外的钩子上。调用方拿到结果后自行替换内容。
 */
export function withoutDevPages<T extends DevPageLike>(pages: readonly T[], isDev: boolean): T[] {
  if (isDev) {
    return [...pages]
  }
  return pages
    .filter((page) => !isDevPagePath(page.path))
    .map((page) =>
      page.children === undefined ? page : { ...page, children: withoutDevPages(page.children, false) },
    )
}
