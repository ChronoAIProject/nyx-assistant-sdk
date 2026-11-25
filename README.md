# NyxID Assistant SDK

让网页或原生客户端调用用户已授权的 NyxID 服务，并向服务中的 Agent 开放当前页面或窗口的操作。NyxID 管理身份、凭据、服务连接及访问范围。宿主决定可读的上下文、可执行的工具和每次执行的实际权限。服务适配器负责消息格式、会话和恢复。

首个适配器使用 Metaverse 已接通的 `llm-nyx` 服务与 `nyxagent/chat` 模型。Nyx 聊天和 CMA 都是 NyxID 服务，各自使用独立授权与会话。首版联调 Nyx 聊天。[项目目标与验收条件](https://github.com/ChronoAIProject/nyx-assistant-sdk/issues/1)

## 给静态网页添加聊天挂件

在 HTML 加入一行脚本，页面会出现「Nyx 助手」按钮。脚本也随 npm 包提供，可复制 `browser/nyx-widget.js` 到自己的静态站点。

```html
<script defer src="https://cdn.jsdelivr.net/gh/ChronoAIProject/nyx-assistant-sdk@v0.1.0-alpha.4/browser/nyx-widget.js" data-proxy="/"></script>
```

`data-proxy="/"` 使用本站已有授权的 NyxID 服务代理，网页示例包含一个只监听本机的实现。完全静态的站点可将该属性替换为 `data-nyxid="https://你的-NyxID-地址"`，用户点「连接 NyxID」后，在 NyxID 核对授权码并批准已有 Key。登录页与 API 分属不同站点时，设置 `data-verification-origin` 为登录页的源。直连需要 NyxID 的浏览器跨域策略允许该站点、服务请求的 Authorization 与 Idempotency-Key 请求头。托管 NyxID 的跨域策略由服务运营者配置。挂件默认在内存中保管浏览器子凭据。设置 `data-storage="local"` 后，凭据保存在该网站源的 localStorage，刷新后挂件向 NyxID 的 `/auth/agent-key/self` 核验当前身份和服务权限。其他同源标签页可以使用同一授权，各自拥有独立的页面工具和聊天实例。点「断开授权」会撤销子凭据并清理本地保存。该源上执行的脚本能读取 localStorage，应只在信任其脚本的网站启用。

`data-services` 用逗号分隔此应用需要的服务，默认是 `llm-nyx,chrono-llm-public`。`data-key-source="new"` 在 NyxID 授权页预填创建专用 Key，默认预选已有 Key。批准后的实际权限由挂件按此服务列表核验。未完成的申请保存在当前标签页，刷新后点连接可以继续原申请。自有 UI 可从 `@chronoai/nyx-assistant-sdk/agent-key` 导入 `BrowserAuthorization`，传入 NyxID 的 `base`、登录页 `verificationOrigin`、`services` 和 `clientLabel`；`connect(signal, showLink)` 提供授权链接，`restore(signal)` 恢复并核验已存凭据。返回的 `connection` 可直接创建聊天适配器。

挂件继承页面字体。可在页面样式中设置颜色、圆角和层级，脚本的 `data-position="left"` 将入口移到左下。Enter 发送，Shift+Enter 换行，Escape 收起。收起再打开可继续原会话。

```css
nyx-assistant {
  --nyx-accent: #315747;
  --nyx-accent-text: white;
  --nyx-radius: 12px;
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
npm install https://github.com/ChronoAIProject/nyx-assistant-sdk/releases/download/v0.1.0-alpha.4/chronoai-nyx-assistant-sdk-0.1.0-alpha.4.tgz
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
