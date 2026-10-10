// 渲染站客户端域的公开面：壳层调常驻渲染站的 HTTP 出口。
export * from './client'

// 渲染站的常驻拉起：壳层启动时确保站点有人应答（外部站点优先，缺产物则告警退化）。
export * from './resident'
