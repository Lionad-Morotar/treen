export interface RenderSiteHealth {
  ok: true
  service: string
  version: string
}

/** 渲染站自身健康载荷；页面与 Nitro 路由共用同一来源，避免两处漂移。 */
export function renderSiteHealth(version: string): RenderSiteHealth {
  return { ok: true, service: 'treen-render-site', version }
}
