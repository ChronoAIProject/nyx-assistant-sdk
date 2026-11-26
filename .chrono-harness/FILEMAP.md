# NyxID 客户端 SDK

#1 的使用方是接入 NyxID 服务的宿主开发者。SDK 维护者负责下表中的包、契约和验收入口。示例操作只在运行的宿主内产生结果。成本列为本机观察值或未知。

| 文件 | 输入与直接依赖 | 使用方及操作 | 成本 |
|---|---|---|---|
| `package.json` | 包导出、脚本、固定依赖 | npm 构建、测试和安装 SDK | 未知 |
| `package-lock.json` | npm 包及其完整性 | npm ci 重建依赖 | 未知 |
| `tsconfig.json` | TypeScript 源码 | npm run build 生成模块和类型 | 未知 |
| `.gitignore` | npm 的本地输出路径 | Git 排除可重建安装和产物 | 未知 |
| `src/connection.ts` | 宿主提供的 NyxID URL 与授权 fetch | 服务适配器通过 NyxID 代理调用服务 | 每次调用一个 HTTP 请求 |
| `src/index.ts` | 服务接口、上下文、Zod 工具定义及处理函数 | 各宿主创建实例，订阅、发送、执行和恢复 | 取决于宿主处理函数 |
| `src/nyx-chat.ts` | 连接、核心契约、Responses SSE 和已保存响应 | Nyx 聊天适配器执行或续接一轮 | 每步一次请求，实际推理成本未知 |
| `test/host.test.ts` | 核心与模拟服务 | Node 验证实例、权限、调用与恢复 | 未知 |
| `test/nyx-chat.test.ts` | 核心、连接、适配器与模拟 HTTP | Node 验证线上的请求形状及结果关联 | 未知 |
| `examples/web/index.html` | 筛选与聊天表单 | 网页用户查看行数、发送请求 | 未知 |
| `examples/web/app.js` | HTML、SDK 与宿主表格状态 | 网页用户读取和修改筛选 | 未知 |
| `examples/web/serve.mjs` | HTML、页面工具、已打包挂件及测试服务配置 | 本机开发者运行网页示例 | 静态文件读取，推理成本未知 |
| `examples/macos/Window.swift` | AppKit、当前窗口选择、独立进程的结果 | macOS 用户执行和核对原生列表修改 | 每个窗口一个 Node 进程 |
| `examples/macos/bridge.mjs` | 标准输入输出、SDK、已授权服务 | 原生窗口调用 NyxID 并处理结果 | 未知 |
| `README.md` | 公共导出和上述入口 | 接入方安装、注册工具和复现示例 | 未知 |
| `src/widget.ts` | 公共 SDK、Nyx 聊天适配器、浏览器授权接口、挂件样式 | 静态页用户打开挂件、授权、发送、恢复和切换身份 | 单次加载浏览器包 |
| `src/widget-style.ts` | Shadow DOM、宿主 CSS 自定义属性 | 网页维护者调整挂件外观，用户在窄屏和键盘下操作 | 随浏览器包加载 |
| `src/widget-auth.ts` | NyxID Agent Key 的设备授权和子凭据、Web Locks、授权存储 | 宿主和挂件按站点配置协调共享授权、恢复当前标签页申请、核验交付范围并撤销子凭据 | 持久模式同配置一次进行一项授权操作 |
| `browser/nyx-widget.js` | esbuild 打包挂件、样式和直接依赖 | 无构建静态网页按固定版本从 CDN 或自身站点加载 | 一个压缩脚本 |
| `scripts/build-widget.mjs` | 浏览器入口、esbuild、依赖许可证 | 生成实际分发给静态网站的单文件脚本 | 一次本地打包 |
| `test/authorization.test.ts` | 设备授权、有效服务、宿主身份、模拟 HTTP 和 Web Locks | Node 验证拒绝错误交付、复用原申请、并发连接共享可恢复和可撤销的子凭据 | 未知 |

| `src/credential-storage.ts` | Web Crypto、idb-keyval、站点授权绑定 | BrowserAuthorization 加密恢复可撤销子凭据 | 一条源级密钥和每份授权一条密文 |
| `server/server.mjs` | HTTP、固定 NyxID 上游、站点来源 | 静态挂件授权、流式 Responses 和恢复 | 聊天前一次 self 核验 |
| `server/Dockerfile` | Node 和 server.mjs | chrono-cd 独立非 root 容器 | 镜像构建成本未知 |
| `test/server.test.mjs` | server.mjs、受控的上游 | Node 检查子凭据契约和转发行为 | 未知 |
| `.github/workflows/server-image.yml` | Dockerfile、转发与部署测试、GitHub 环境密钥、本次构建摘要 | GitHub Actions 构建 linux/amd64 镜像并部署对应 chrono-cd 应用 | 未知 |
| `test/credential-storage.test.ts` | Web Crypto、模拟 IndexedDB、credential-storage.ts | 检验并发密钥创建、不可导出及授权隔离 | 未知 |
| `server/README.md` | server 入口和 chrono-cd 配置 | 运维者配置固定上游和接入站点 | 未知 |
| `infra/chrono-cd/app.json` | 初始 GHCR 摘要、来源和资源规格 | 运维者创建或重建生产转发服务 | 一份运行副本 |
| `infra/chrono-cd/app.staging.json` | 初始 GHCR 摘要、Metaverse 测试站来源和资源规格 | 运维者创建或重建测试转发服务 | 一份运行副本 |
| `infra/chrono-cd/deploy.mjs` | 工作流分支、环境、提交、GHCR 摘要、限定范围的 NyxID Key 和线上应用规格 | 工作流按摘要更新服务，核对修订、Pod 和公网探针 | 一次 PUT、至多三次 CD 读取及一次公网探针 |
| `infra/chrono-cd/deploy.test.mjs` | 部署入口、模拟 fetch 和计时 | Node 验证环境隔离、条件写入与实际镜像核对 | 未知 |
| `infra/chrono-cd/key-scope.mjs` | 部署目标、线上规格、已登记的 NyxID 操作 | 运维者为自动部署生成限定应用和请求体的操作范围 | 一次本地 JSON 转换 |
