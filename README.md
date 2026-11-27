# NyxID Assistant SDK

让网页或原生客户端调用用户已授权的 NyxID 服务，并向服务中的 Agent 开放当前页面或窗口的操作。NyxID 管理身份、凭据、服务连接及访问范围。宿主决定可读的上下文、可执行的工具和每次执行的实际权限。服务适配器负责消息格式、会话和恢复。

首个适配器使用 Metaverse 已接通的 `llm-nyx` 服务与 `nyxagent/chat` 模型。Nyx 聊天和 CMA 都是 NyxID 服务，各自使用独立授权与会话。首版联调 Nyx 聊天。[项目目标与验收条件](https://github.com/ChronoAIProject/nyx-assistant-sdk/issues/1)

SDK 官网的「免登录试用」可直接读取或切换演示工单的筛选条件。自由对话需要在「Nyx 助手」中授权 NyxID。连接成功后，首页和助手中会显示已授权的服务及对应 Key 的权限管理入口。两者使用同一组宿主工具，开启只读模式后会拒绝写入。[中文官网](https://chronoaiproject.github.io/nyx-assistant-sdk/zh/) · [English](https://chronoaiproject.github.io/nyx-assistant-sdk/en/)

## 给静态网页添加聊天挂件

在 HTML 加入一行脚本，页面会出现「Nyx 助手」按钮。脚本也随 npm 包提供，可复制 `browser/nyx-widget.js` 到自己的静态站点。

```html
<script defer src="https://cdn.jsdelivr.net/gh/ChronoAIProject/nyx-assistant-sdk@v0.2.2/browser/nyx-widget.js" data-proxy="/"></script>
```

`data-proxy="/"` 使用本站已有授权的 NyxID 服务代理，网页示例包含一个只监听本机的实现。完全静态的站点可将该属性替换为 `data-nyxid="https://你的-NyxID-地址"`，用户点「连接 NyxID」后，在 NyxID 核对授权码并批准已有 Key。登录页与 API 分属不同站点时，设置 `data-verification-origin` 为登录页的源。独立转发服务部署于 chrono-cd，使用 `data-nyxid` 指向服务地址，并设置 `data-verification-origin="https://nyxid.ai"`。任意来源的页面均可接入转发服务。网页挂件和 `BrowserAuthorization` 默认记住本次登录。同一浏览器再次打开页面或刷新时，挂件会自动核验并恢复。显式设置 `data-storage="memory"`（自建 UI 传 `credentialStorage: null`）可仅在当前页面使用授权。默认模式在缺少 Web Locks、Web Crypto 或无法访问本地存储时使用内存。同源标签页按站点配置依次连接并复用已保存的授权。挂件通过 Web Crypto 的 AES-GCM 加密子凭据，密文保存在站点 localStorage，不可导出的密钥存于该源的 IndexedDB。浏览器恢复时先迁移 alpha.4 的明文记录，再向 NyxID 核验。能在同源运行的脚本仍然可以使用已授权的凭据。断开授权会撤销当前子凭据并通知同源标签页。

`data-services` 用逗号分隔此应用的基础服务，默认是 `llm-nyx,chrono-llm-public`。设置为 `@key` 时，挂件使用用户在 NyxID 授权页选择的 Agent Key 原有服务授权，适合同时接入 Bot Voice 等具体连接。`data-key-source="new"` 在 NyxID 授权页预填创建专用 Key，默认申请应用专用 Key，指定 `data-key-source="existing"` 可预选已有 Key。批准后的实际权限由挂件按此服务列表核验。未完成的申请保存在当前标签页，刷新后点连接可以继续原申请。自有 UI 可从 `@chronoai/nyx-assistant-sdk/agent-key` 导入 `BrowserAuthorization`，传入 NyxID 的 `base`、登录页 `verificationOrigin`、`services` 和 `clientLabel`；`connect(signal, showLink)` 提供授权链接，`restore(signal)` 恢复并核验已存凭据。返回的 `connection` 可直接创建聊天适配器，`access.services` 和 `access.managementUrl` 分别是已核验的服务列表和当前 Key 的管理地址。

### 挂件语音通话

连接后，空输入框右侧是「语音通话」。点一下并允许麦克风即可开始与临时语音助手通话。SDK 通过用户授权的 OpenAI API 连接建立 WebRTC 会话，支持双向音频、字幕、静音和挂断。每次拨号建立新的语音会话，文字聊天继续使用自己的 `llm-nyx` 会话。连接多把 OpenAI Key 时可在通话设置里选择连接。

语音默认开启。首次授权请求文字所需的 `llm-nyx,chrono-llm-public`，并为临时通话加入 `llm-openai`。开发者可以设置 `data-voice="false"` 或 `element.voiceEnabled = false` 关闭语音。纯临时语音可以设置 `data-services="llm-openai"`。显式指定 `data-services="nyxbot-voice"` 或通过 `@key` 授权具体的 Bot Voice 连接时，挂件沿用该持久 Bot 的通话设置。

使用默认配置时，旧 Key 如果还包含一项通用的 `nyxbot-voice` 目录连接，也可以直接使用已授权的 OpenAI 连接通话。启用了逐次操作审批的账号，拨号时还需在 NyxID 确认本次 OpenAI 通话请求。

省略 `data-nyxid` 时使用官方 SDK 转发服务，并在 `https://nyxid.ai` 授权。自建部署用 `data-nyxid` 指定 SDK 转发服务，用 `data-verification-origin` 指定 NyxID 登录站点。浏览器通话需要支持 Voice HTTP 和 WebSocket 的 SDK 转发服务，部署方通过 `NYXID_ORIGIN` 固定上游。使用 `data-proxy` 的宿主可通过 `element.bind(NyxIDConnection.fromAgentKey(relayUrl, childCredential))` 绑定语音连接。

### 在页面上配置提示词和工具

`data-instructions` 是共用提示词。文字请求会追加 `data-text-instructions`，临时语音拨号时会追加 `data-voice-instructions`。`data-voice-name` 指定语音助手的显示和自称名称。`data-voice-tour="true"` 让导览通话在接通时主动开场，并在静默时继续。设置 `data-voice-screenshot="true"` 可在支持 Capture Handle 的桌面浏览器中共享本页。通话中点击「共享本页画面」并选择当前标签页后，模型能按需调用 `_page_screenshot` 查看压缩 JPEG。挂断或停止共享会释放捕获。临时 OpenAI 通话可通过 `data-voice-model="gpt-realtime-2.1"` 指定接入模型，默认值为 `gpt-realtime`。这些属性可以写在自动挂载的脚本或 `<nyx-assistant>` 上。JavaScript 属性分别为 `instructions`、`textInstructions`、`voiceInstructions`。更新后在下一条文字请求或下次临时通话生效。

```html
<nyx-assistant data-instructions="你是这个工单页面的助手。"
  data-text-instructions="回答时列出筛选条件和行数。"
  data-voice-instructions="用一句话回答。"></nyx-assistant>
```

在 `nyx-ready` 中通过 `host.registerTool` 注册页面工具，文字和临时语音都可以调用。语音工具可以从 `element.context()` 读取当前页面上下文。拥有 `llm-nyx` 授权的临时语音会话还可以把服务请求交给 Nyx，调用范围由当前子凭据决定。持久 Bot 使用 NyxID 中配置的指令与工具。

正式版默认使用官方 production 转发服务，并在 `https://nyxid.ai` 授权。自建转发服务请使用同一版本的 `server/`，在 `SDK_ORIGINS` 中配置页面来源。

## 用 Agent Key 连接 Bot Voice

Bot 所有者在 NyxID 的 Agent 详情中发布 Device voice，再把该连接授予设备 Key。使用带有 `read proxy` 权限的普通 Agent Key 或设备登录子凭据。以下示例在支持自定义 WebSocket 请求头的宿主中运行。

```ts
import { NyxIDConnection } from "@chronoai/nyx-assistant-sdk";
import { VoiceClient, selectVoiceService } from "@chronoai/nyx-assistant-sdk/voice";

const connection = NyxIDConnection.fromAgentKey(nyxidBaseUrl, credential);
const services = await connection.getServiceConnections();
const service = selectVoiceService({ services }, selectedServiceId);
const voice = new VoiceClient(connection, service, {
  socket: (url, key) => createWebSocket(url, {
    headers: { Authorization: `Bearer ${key}` },
  }),
  onSnapshot: updateCallState,
  onError: showCallError,
  // xAI 回放队列接收 PCM 和该帧的播放终点（毫秒）。
  onAudio: (pcm, endMs) => player.enqueue(pcm, endMs),
  onAudioFlush: () => player.flush(),
});
const agent = await voice.getAgent();
const { options } = await voice.getOptions(agent.conversation_id);
```

`service.id` 选定本次呼叫的 Bot。传给 `voice.start()` 的 `preferences.service_id` 取自所选提供商选项。SDK 会把两种 ID 放在各自的位置。

**OpenAI Live（WebRTC）**。宿主把麦克风轨道加到 `RTCPeerConnection`，通过 `ontrack` 把远端音轨接入扬声器。设置本地描述并等 ICE 候选收集完毕，再发送完整的 SDP。

```ts
const option = options.find(o => o.available && o.voice?.protocol === "openai_live");
if (!option) throw new Error("No available OpenAI Live option");
peer.createDataChannel("oai-events");
await peer.setLocalDescription(await peer.createOffer());
await waitForIceGatheringComplete(peer); // 宿主等待 iceGatheringState 为 complete
const call = await voice.start({
  agentId: agent.agent_id,
  preferences: {
    service_id: option.service_id, connection_id: option.connection_id,
    key_source: option.key_source, model: option.model, input_mode: "automatic",
  },
  sdpOffer: peer.localDescription!.sdp,
});
await peer.setRemoteDescription({ type: "answer", sdp: call.sdp_answer });
```

**xAI Realtime（WebSocket PCM）**。选择 `voice.protocol === "xai_realtime"` 的可用选项，调用同一个 `start()`，传入 `sdpOffer: ""` 和 `input_mode: "push_to_talk"`。收到 `active` 快照后，按下说话键时调用 `voice.beginInput()`，返回 `true` 即可发送采集到的音频。逐帧调用 `voice.sendPcm(arrayBuffer)`，松开时调用 `voice.commitInput()`。输入和回放均为 24 kHz、单声道、小端 PCM16。建议每帧 20 毫秒（960 字节），上限为 40 毫秒。

两种通话都由宿主每秒调用一次 `voice.heartbeat(playedMs, audible)`。传入实际已播放到的毫秒位置和扬声器是否正在出声。挂断时先调用 `await voice.control("end")`，再释放心跳定时器、音轨、播放器和 peer。静音与恢复使用 `control("mute")` 和 `control("unmute")`。支持播报的选项还可以使用 `announce({ text })` 或 `announce({ greeting: true })`。

应用已有聊天面板时，从 `@chronoai/nyx-assistant-sdk/widget` 导入 `NyxAssistantElement`，使用 `customElements.define("nyx-assistant", NyxAssistantElement)` 注册一次。创建元素后先设置 `layout="embedded"`、连接参数、`context` 回调及可选的 `instructions`，再挂载。模块导入不会在页面上添加悬浮入口。宿主用 `nyx-ready` 注册页面工具；`nyx-state` 可读取元素的 `busy` 和 `host`，`nyx-answer` 提供本轮已确认的答复。宿主按钮调用元素的 `connect()` 即可打开连接流程。监听 `nyx-state` 并读取 `element.access` 可同步服务列表和管理链接，断开后该属性为 `undefined`。通过 `sendMessage(text)` 可以提交用户明确选择的操作。

有网站登录的宿主可通过 `data-owner-id` 核验当前个人账号，`data-catalog-services` 指定须与 NyxID 目录身份匹配的服务。按账号或工作区切换时重新创建元素。设置 `data-session` 为当前工作区编号后，已验证的同一浏览器子凭据可在当前标签页恢复最近 30 条聊天记录。发生刷新时，已取得响应编号的请求从原响应读取；旧窗口未确认的页面操作提示用户核对。宿主可监听 `nyx-recovery` 打开已有聊天面板。

在主视图中放置 `<nyx-assistant>` 元素，可指定挂件位置。将连接配置写在该元素上，用页面 CSS 设置其定位。挂件依次匹配元素的 `lang`、页面 `<html lang>` 和浏览器首选语言。支持 `zh-CN`、`en-GB` 等地区标签，找不到匹配时使用简体中文。自动挂载时也可在 `<script>` 上指定 `lang`。运行时修改元素或页面的 `lang` 会更新控件、无障碍标签和当前状态，并保留会话与输入草稿。

控制台页面可选 `appearance="console"`，通过 `--nyx-mark: url(...)` 引用自己的标识，通过 `--nyx-panel-surface` 指定面板背景。若宿主提供 `<button type="button" slot="prompt">读取当前视图</button>`，已连接且对话为空时可点击填入输入框，再编辑和发送。

在布局容器中使用 `layout="anchored"`，入口按文字计算宽度，面板从按钮上方展开。宿主可用 `--nyx-panel-max-width` 和 `--nyx-panel-max-height` 指定可用空间。空会话仅占标题栏和输入行，消息逐条增加至高度上限后滚动。

助手的最终回复支持 GitHub Flavored Markdown，包括嵌套列表、任务项、引用、删除线、代码块、链接和表格。长回复从开头阅读，宽表和长代码行可在块内横向滚动。用户输入和原始 HTML 按文字显示。外部图片显示为带替代文字的链接，点击后在新标签页打开。中文标点旁的加粗使用与 NyxID 同一项目的 CJK 扩展解析。自建浏览器界面可从 `@chronoai/nyx-assistant-sdk/markdown` 导入 `renderAssistantMarkdown(text)`，将返回的 `DocumentFragment` 放入消息容器。SDK 核心的 `send()` 和 `resume()` 返回原文。

宿主可通过 CSS `::part()` 单独设置 `launcher`、`launcher-icon`、`panel`、`header`、`close`、`secondary-action`、`primary-action` 和 `input` 的样式。挂件继承页面字体。可在页面样式中设置颜色、圆角和层级，脚本的 `data-position="left"` 将入口移到左下。Enter 发送，Shift+Enter 换行，Escape 收起。收起再打开可继续原会话。

```css
nyx-assistant {
  --nyx-accent: #315747;
  --nyx-accent-text: white;
  --nyx-control-font: system-ui;
  --nyx-control-surface: #f2f5ef;
  --nyx-control-text: #234235;
  --nyx-action-surface: #315747;
  --nyx-border: #728178;
  --nyx-muted: #43584d;
  --nyx-radius: 12px;
  --nyx-panel-max-height: min(30rem, 70dvh);
  --nyx-surface: #fffdf6;
  --nyx-text: #1b2922;
}
```

需要让助手操作页面时，在挂件脚本执行前监听 `nyx-ready`。每次绑定登录身份会提供新的 host。返回的函数用于撤销这一项工具。页面标题和语言默认进入上下文，业务数据由宿主工具按需提供。

```html
<script>
  document.addEventListener("nyx-ready", ({ detail: { host, z } }) => {
    host.registerTool({
      name: "read_filter",
      description: "读取当前筛选值",
      parameters: z.object({}),
      execute: () => ({ ok: true, value: document.querySelector("#filter").value })
    });
  });
</script>
```

## 接入当前页面

开发环境使用 Node.js 22.18 或更高版本。仓库根目录运行以下命令生成 ESM 和类型声明。

```sh
npm ci
npm test
npm pack
```

接入方也可以安装已经发布的固定版本。

```sh
npm install https://github.com/ChronoAIProject/nyx-assistant-sdk/releases/download/v0.2.2/chronoai-nyx-assistant-sdk-0.2.2.tgz
```

运行端需要 Fetch、Web Streams、Web Crypto 和 AbortSignal.any。应用可以使用自己的聊天界面。

```ts
import { AssistantHost, NyxIDConnection, z } from "@chronoai/nyx-assistant-sdk";
import { createNyxChatService } from "@chronoai/nyx-assistant-sdk/nyx-chat";

// 已有的登录或同源后端提供 authenticatedFetch，按当前身份附加凭据。
const connection = new NyxIDConnection(nyxidBaseUrl, authenticatedFetch);
const host = new AssistantHost(createNyxChatService(connection), () => ({
  view: "tickets",
}));

const remove = host.registerTool({
  name: "read_filter",
  description: "读取工单表当前的筛选条件与显示行数。",
  parameters: z.object({}),
  execute: () => ({
    ok: true,
    value: { filter: table.currentFilter(), rows: table.visibleRowCount() },
  }),
});

const answer = await host.send("当前有多少条工单？");
showMessage(answer);
remove();       // 该工具随宿主功能卸载。
host.dispose(); // 关闭窗口、注销或切换身份时销毁该实例。
```

自建界面可以设置 `host.language`（如 `"zh-CN"`）来选择 SDK 宿主生成的诊断和工具错误文案。`BrowserAuthorization` 接受 `language` 选项。SDK 导出的 `LocalizedError` 可通过 `error.localize(language)` 按当前界面语言显示，同时保留 HTTP 状态码等参数。

每个窗口和登录身份创建一个独立实例。处理函数应在执行时读取当前业务状态，检查权限，异步写入前检查传入的 AbortSignal。已拒绝的业务操作返回 `{ok:false, code, message}`，只有确认成功后才返回 `{ok:true, value}`。上下文会进入模型输入，应只包含当前请求需要的数据。

## 服务与工具契约

- `NyxIDConnection.request(service, path, init)` 调用该 NyxID 实例的服务代理。服务与路径使用独立的标识和片段。凭据由宿主提供，重定向交给调用方处理。
- `AssistantHost`向适配器提交 `TurnRequest`。它包含请求 ID、实例 ID、已知会话 ID、上下文快照、工具的名称、用途与 JSON Schema，以及用户消息或带调用 ID 的执行结果。所有工具参数和结果都可用 JSON 表示。
- `NyxIDService.turn` 接收请求、取消信号及流式文本回调。它返回同一会话的最终回答，或一项包含调用 ID、工具名称和完整参数的调用。工具执行完后 SDK 将实际结果送回原会话。后续服务可以各自实现这一接口。
- `llm-nyx` 的 Responses 接口支持文本。当前适配器在已完成的助手回复中读取带本次请求 ID 的 `nyx-host-call` JSON 块，用真实响应 ID 关联结果，并在下一次请求中把结果作为应用数据传回。格式由适配器统一，宿主只注册业务函数。该映射属于 SDK 约定。[NyxAgent Responses 契约](https://github.com/ChronoAIProject/NxyAgent/blob/46d6d252d836139e1b8d145e12e91b5151e52b37/docs/api.md#L113)
- `subscribe` 提供流式文本和已执行的工具结果。`stopWaiting()` 停止本次观察。`pendingRequestId` 表示还有请求需要核对，`resume()` 优先读取已知原响应，尚无响应 ID 时使用同一个幂等键及原请求。当前宿主和适配器在内存中保留恢复状态，进程退出后的业务结果应由宿主自己的持久记录核对。

## 运行示例

把已有测试授权注入环境变量 `NYXID_BASE_URL` 与 `NYXID_AGENT_KEY`。测试 Key 需要能调用 `llm-nyx` 及选定模型的上游服务。网页开发服务器只绑定回环地址，将凭据保留在本机进程内。普通网页和原生示例都从仓库根目录运行。

| 宿主 | 命令 | 可观察行为 |
|---|---|---|
| 独立网页 | `npm run example:web` | 打开终端显示的网址，要求助手读取筛选再切换为待处理，检查实际行数。勾选只读模式可验证宿主拒绝。 |
| macOS AppKit | `npm run example:macos` | 两个窗口各运行一个 SDK 实例。选择列表项，要求助手读取并标记，检查原生复选框和另一个窗口的状态。需要 Swift 和 Node.js。 |

网页示例可通过页面上的语言链接或直接访问 `/zh/`、`/en/` 来选择语言。原生示例启动时读取 macOS 首选语言，并将选中的语言传给窗口的 Node 子进程。

扩展语言时，在使用该语言的入口补齐对应目录。SDK 与挂件使用 [messages.ts](src/messages.ts)，官网与网页示例共用 [locales.mjs](site/locales.mjs)，原生窗口与桥接器共用 [locales.json](examples/macos/locales.json)。静态页面路径和语言导航根据网站目录自动生成。

原生示例由 AppKit 执行读写，Node 子进程通过每个窗口独立的标准输入输出管道运行相同的 SDK 与 Nyx 聊天适配器。窗口关闭后子进程结束。[网页示例](examples/web/app.js) · [原生窗口](examples/macos/Window.swift)

### 原生窗口的消息契约

每行是一条 UTF-8 JSON 消息。以读取当前选区为例，窗口向子进程写入第一行，子进程从标准输出发出第二行，窗口执行后写回第三行。桥接器将结果关联到原服务调用，并把同一会话的最终回答交给窗口。下例的调用编号由子进程生成。

```jsonl
{"type":"send","text":"读一下当前选区。"}
{"type":"call","id":"c1","name":"read_selection","args":{}}
{"type":"result","id":"c1","result":{"ok":true,"value":{"id":"Beta","marked":false}}}
{"type":"answer","text":"当前选中 Beta，尚未标记。"}
```

宿主拒绝时用同一编号返回 `{"ok":false,"code":"read_only","message":"此窗口为只读模式。"}`。断线后，桥接器用 `{"type":"error","text":"…","pending":true}` 表示原请求待核对，窗口用 `{"type":"resume"}` 继续。关闭窗口或切换登录身份时关闭原管道并释放实例，新的窗口和身份建立自己的管道。工具名称、参数 JSON Schema 与对应的原生处理函数由接入方声明。

仓库协作工具的安装与配置见[项目说明](.chrono-harness/USAGE.md)。
