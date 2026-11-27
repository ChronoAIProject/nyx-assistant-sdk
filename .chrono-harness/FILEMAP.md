# NyxID 客户端 SDK

#1 的使用方是接入 NyxID 服务的宿主开发者。SDK 维护者负责下表中的包、契约和验收入口。示例操作只在运行的宿主内产生结果。成本列为本机观察值或未知。

| 文件 | 输入与直接依赖 | 使用方及操作 | 成本 |
|---|---|---|---|
| `package.json` | 包导出、脚本、固定依赖 | npm 构建、测试和安装 SDK | 未知 |
| `package-lock.json` | npm 包及其完整性 | npm ci 重建依赖 | 未知 |
| `tsconfig.json` | TypeScript 源码 | npm run build 生成模块和类型 | 未知 |
| `.gitignore` | npm 的本地输出路径 | Git 排除可重建安装和产物 | 未知 |
| `src/connection.ts` | 宿主提供的 NyxID URL、授权 fetch 与 i18n.ts | 服务适配器通过 NyxID 代理调用服务 | 每次调用一个 HTTP 请求 |
| `src/index.ts` | 服务接口、上下文、i18n.ts、Zod 工具定义及处理函数 | 各宿主创建实例，订阅、发送、执行和恢复 | 取决于宿主处理函数 |
| `src/nyx-chat.ts` | 连接、核心契约、i18n.ts、Responses SSE 和已保存响应 | Nyx 聊天适配器执行或续接一轮 | 每步一次请求，实际推理成本未知 |
| `test/host.test.ts` | 核心与模拟服务 | Node 验证实例、权限、调用、恢复与宿主诊断语言 | 未知 |
| `src/agent-identity.ts` | Agent Key self 响应 | `NyxIDConnection` 和授权流程解析当前 Key、精确服务连接和授权范围 | 每次身份读取一次响应解析 |
| `src/voice.ts` | Agent Key 身份、精确 Voice UserService、WebRTC SDP、控制 WebSocket 和 xAI PCM16 音频 | nyx-panel 等设备宿主发现固定 Bot、创建 Voice 会话、收发语音、发送心跳和控制 | 每次发现、选项、启动或控制一次服务请求，通话媒体成本未知 |
| `test/nyx-chat.test.ts` | 核心、连接、适配器与模拟 HTTP | Node 验证线上的请求形状及结果关联 | 未知 |
| `test/voice.test.ts` | Voice 身份选择、精确服务路由、模拟 HTTP 和控制 socket | Node 验证 Agent Key Voice 的服务绑定、启动、PCM 收发和控制契约 | 未知 |
| `examples/web/index.html` | 筛选与聊天表单 | 网页用户查看行数、发送请求 | 未知 |
| `examples/web/app.js` | HTML、站点语言目录、SDK 与宿主表格状态 | 网页用户读取和修改筛选 | 未知 |
| `examples/web/tickets.js` | 工单样例数据、本地化文案、筛选和只读控件、SDK 注册工具接口 | 本机示例和 SDK 官网共同显示筛选结果并执行权限检查 | 每次变更重画可见行 |
| `examples/web/serve.mjs` | HTML、site/render.mjs、站点语言目录、页面工具、工单数据、已打包挂件及测试服务配置 | 本机开发者运行网页示例 | 静态文件读取，推理成本未知 |
| `site/index.html` | 固定 SDK 发行版、文档、工单控件、语言模板和挂件 | SDK 接入者查看中文或英文官网、运行演练、连接 NyxID 并管理所授权的 Key | 每个语言生成一份 HTML |
| `site/locales.mjs` | 中英文文案、生产转发服务地址与共用工单数据接口 | SDK 维护者维护静态页面、动态演练及复制反馈的双语文字 | 随站点构建及演练包加载 |
| `site/render.mjs` | 站点语言目录和 HTML 模板 | 官网构建与网页示例服务器渲染本地化 HTML、语言导航和默认入口 | 每种语言渲染一次 |
| `site/style.css` | 官网结构、系统字体、视口、挂件主题属性 | 官网用户在桌面和手机浏览、操作演练和对话 | 一份静态样式 |
| `site/playground.ts` | SDK 公共入口、共享工单工具、当前语言、固定演练指令、挂件授权事件 | 官网演练和 NyxID 助手读写同一张工单表，连接后显示授权服务和管理链接 | 一份演练浏览器包，真实对话按调用使用模型 |
| `scripts/build-site.mjs` | 官网模板、site/render.mjs、站点语言目录、已构建挂件、SDK 核心与 esbuild | 本机和 Actions 通过 `npm run build:site` 生成站点、语言路径和旧首页入口 | 一次浏览器打包，生成双语页面和入口 |
| `.github/workflows/pages.yml` | 官网构建输入、`dev` 推送、GitHub Pages 环境 | Pages 读取 `site/dist` 部署官网，相关 PR 构建同一产物 | Actions 和 Pages 部署耗时未知 |
| `examples/macos/locales.json` | 中英文窗口文案、桥接提示、工具描述与默认语言 | AppKit 和 Node 子进程展示同一种语言 | 每个进程启动读取一次 |
| `examples/macos/Window.swift` | AppKit、locales.json、系统语言偏好、当前窗口选择、独立进程的结果 | macOS 用户执行和核对原生列表修改 | 每个窗口一个 Node 进程 |
| `examples/macos/bridge.mjs` | 标准输入输出、窗口语言、locales.json、SDK、已授权服务 | 原生窗口调用 NyxID 并处理结果 | 未知 |
| `README.md` | 公共导出和上述入口 | 接入方安装、注册工具和复现示例 | 未知 |
| `src/widget.ts` | 公共 SDK、Nyx 聊天适配器、浏览器授权接口、Markdown 渲染、挂件样式和本地化文字 | 静态页用户打开挂件、授权、发送、恢复和切换身份 | 单次加载浏览器包 |
| `src/messages.ts` | 中英文界面、无障碍标签、宿主工具和错误文案 | SDK 与挂件显示配置语言的控件、状态和错误 | 随挂件加载 |
| `src/markdown.ts` | 已完成的回复、图片备用标签、i18n.ts、Marked GFM、DOMPurify 和浏览器 DOM | 挂件与自建网页创建可阅读的消息片段 | 每条最终回复渲染一次 |
| `test/markdown.test.ts` | 渲染模块、jsdom 与代表性 Markdown | npm test 检查结构、内容、链接和本地化图片标签 | 未知 |
| `src/widget-style.ts` | Shadow DOM、宿主 CSS 自定义属性 | 网页维护者调整挂件外观，用户在窄屏和键盘下操作 | 随浏览器包加载 |
| `src/widget-auth.ts` | NyxID Agent Key 的设备授权和子凭据、Web Locks、授权存储和本地化错误 | 宿主和挂件按站点配置协调共享授权、失败时报告本地化错误、恢复当前标签页申请、核验交付范围、给出对应 Key 的管理链接并撤销子凭据 | 持久模式同配置一次进行一项授权操作 |
| `browser/nyx-widget.js` | esbuild 打包挂件、样式和直接依赖 | 无构建静态网页按固定版本从 CDN 或自身站点加载 | 一个压缩脚本 |
| `scripts/build-widget.mjs` | 浏览器入口、esbuild、依赖许可证 | 生成实际分发给静态网站的单文件脚本 | 一次本地打包 |
| `test/authorization.test.ts` | 设备授权、有效服务、宿主身份、模拟 HTTP 和 Web Locks | Node 验证核验后的服务列表和权限管理链接、拒绝错误交付、复用原申请、并发连接共享可恢复和可撤销的子凭据 | 未知 |

| `src/credential-storage.ts` | Web Crypto、idb-keyval、站点授权绑定 | BrowserAuthorization 加密恢复可撤销子凭据 | 一条源级密钥和每份授权一条密文 |
| `server/server.mjs` | HTTP、固定 NyxID 上游、server/voice.mjs | 任意来源的静态挂件授权、流式 Responses 和恢复 | 聊天前一次 self 核验 |
| `server/voice.mjs` | ws、固定 NyxID 上游、Bot Voice 路径和子凭据 | 网页及原生客户端调用语音控制和 WebSocket 会话 | WebSocket 每次连接一次 self 核验 |
| `server/Dockerfile` | Node、server/server.mjs、server/voice.mjs 和 relay 依赖 | chrono-cd 独立非 root 容器 | 镜像构建成本未知 |
| `test/server.test.mjs` | server/server.mjs、server/voice.mjs、受控的上游 | Node 检查跨域访问、子凭据契约和转发行为 | 未知 |
| `.github/workflows/server-image.yml` | Dockerfile、转发与部署测试、GitHub 环境密钥、本次构建摘要 | GitHub Actions 构建 linux/amd64 镜像并部署对应 chrono-cd 应用 | 未知 |
| `test/credential-storage.test.ts` | Web Crypto、模拟 IndexedDB、credential-storage.ts | 检验并发密钥创建、不可导出及授权隔离 | 未知 |
| `server/README.md` | server 入口和 chrono-cd 配置 | 运维者配置固定上游，接入方核对跨域访问方式 | 未知 |
| `infra/chrono-cd/app.json` | 初始 GHCR 摘要、来源和资源规格 | 运维者创建或重建生产转发服务 | 一份运行副本 |
| `infra/chrono-cd/app.staging.json` | 初始 GHCR 摘要、Metaverse 测试站来源和资源规格 | 运维者创建或重建测试转发服务 | 一份运行副本 |
| `infra/chrono-cd/deploy.mjs` | 工作流分支、环境、提交、GHCR 摘要、限定范围的 NyxID Key 和线上应用规格 | 工作流按摘要更新服务，核对修订、Pod 和公网探针 | 一次 PUT、至多三次 CD 读取及一次公网探针 |
| `infra/chrono-cd/deploy.test.mjs` | 部署入口、模拟 fetch 和计时 | Node 验证环境隔离、条件写入与实际镜像核对 | 未知 |
| `infra/chrono-cd/key-scope.mjs` | 部署目标、线上规格、已登记的 NyxID 操作 | 运维者为自动部署生成限定应用和请求体的操作范围 | 一次本地 JSON 转换 |

| `src/widget-session.ts` | 空间编号、已核验子凭据编号与请求进度 | 嵌入挂件按标签恢复已确认结果 | 最多 30 条消息 |
| `src/widget-script.ts` | 挂件类与静态脚本参数 | 单文件脚本注册并自动挂载；模块使用方自行注册 | 一次页面挂载 |

| `src/i18n.ts` | messages.ts、语言偏好与带参数的消息编号 | SDK 宿主、连接、挂件、Markdown、授权和聊天适配器按当前语言读取控件与诊断 | 随挂件打包 |
| `test/widget-language.test.ts` | jsdom、挂件、模拟授权响应 | 验证页面与浏览器语言选择、回退、保留会话和草稿并更新含 HTTP 状态的错误 | 未知 |
| `src/widget-voice.ts` | 当前授权、Bot Voice 选项和字幕 | 挂件选择 Bot 和模型，开始或挂断通话 | 仅展开语音时查询 |
| `src/relay.ts` | SDK 包版本 | 挂件和示例页选择官方转发服务 | 构建时读取 |
| `src/realtime-tools.ts` | 当前页面、已授权连接和实时模型的函数调用 | 临时语音读取页面上下文、执行注册工具及请求 Nyx 服务 | 按通话调用 |
| `test/realtime-tools.test.ts` | 页面工具、模拟实时事件、导览摘要和时钟 | Node 验证工具执行、自然续讲、暂停与摘要生命周期 | 未知 |
| `src/realtime-tour.ts` | 实时音频播放、用户语音、工具响应事件与宿主页的可选摘要 | 导览会话在自然衔接时读取当轮摘要，暂停时释放收集器 | 每通导览一个可取消定时器 |
| `src/tab-screenshot.ts` | 当前标签页授权、Capture Handle、WebRTC 消息大小 | 临时通话按需提供当前页 JPEG | 最长边 1024 像素，每次调用一帧 |
| `src/temporary-call.ts` | 已授权 OpenAI 连接、宿主页的 data-voice-model、麦克风、WebRTC | 挂件临时语音通话与字幕 | 通话时传输音频和核验授权 |
| `src/widget-call.ts` | 麦克风、VoiceClient、WebRTC、Web Audio | 挂件双向音频和播放进度 | 通话时启用设备和心跳 |
| `server/voice.mjs` | 站点来源、子凭据和固定上游 | 网页语音 HTTP 和 WebSocket 转发 | 通话期间两条 WebSocket |
| `server/package.json` | ws 的固定版本 | 转发服务安装和镜像构建 | 一个运行时依赖 |
| `server/package-lock.json` | 包版本和完整性 | 重建转发服务依赖 | 一份锁文件 |
