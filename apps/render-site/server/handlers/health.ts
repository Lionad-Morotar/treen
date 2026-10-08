import { renderSiteHealth } from '~/utils/health'

/** `GET /api/health`：壳层确认渲染站已就绪（路径由 nuxt.config 从 RENDER_SITE_ROUTES 派生）。 */
export default defineEventHandler(() => renderSiteHealth('0.0.0'))
