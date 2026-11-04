# 设计说明：为什么是「代理」而不是「镜像」

这份文档记录几个**如果不写在纸上、以后一定会被改错**的决定，以及它们的源码依据。

---

## 1. 会话日志不能伪造

`dsh-session-format-v3-to-v4` 的读取侧对格式错误**只重抛、不恢复**；
`consumeEventLine()` 只有 JSON 解析失败才走恢复路径。
结论：**一行坏数据 ⇒ 整条会话加载失败 ⇒ 从列表里消失**（连 `/export` 都会 500）。

所以任何"在本地造一份会话日志"的做法，无论多小心，都是在赌自己永远不写错一字节。
本项目因此**完全不写会话日志**。

## 2. 手机端为什么能"不持有数据"却仍然显示会话

前端不直接读文件，它经过这条链：

```
WebView 前端
  → @deepseek-ai/dsh-api-gateway（RPC）
  → sessionController / sessionQuery（服务）
  → 活会话或 sessionPersistence（磁盘）
```

`dsh-session-query/lib/index.js:350` 的 `read()` 只有两个数据来源：
`ctx.sessions.get()`（活会话）或 `sessionPersistence`（文件）。

我们的做法是在**服务这一层**把远程 id 转发给电脑，所以前端拿到的仍是正常形状的数据，
而本地磁盘上什么都没多出来。

## 3. 关键：包装实例属性是安全的，包装原型是危险的

`dsh-api-gateway/lib/index.js`：

```js
// 1213 行：真正调用时用属性访问，因此实例属性会生效
const implementation = descriptor.implementation ?? descriptor.method;
const method = Reflect.get(callReceiver, implementation);

// 1715-1727 行：签名解析从【原型】取方法，并解析其参数名
const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
const source = Function.prototype.toString.call(implementation);
```

由此得到两条**必须遵守**的规则：

| 做法 | 结果 |
|---|---|
| `service.list = wrapped`（实例属性） | ✅ 调用被接管，签名解析不受影响 |
| `Service.prototype.list = wrapped`（改原型） | ❌ 参数名变成包装函数的参数名，参数匹配失败 |

**别为了"更彻底"去改原型。**

## 4. 不能抢 `sessions` 这个 slot hook

`dsh-client-ui-renderer` 的 `rebuildRootBinding()` 用 `copyUnique` 校验 hook 名，
且注释写明 "Hook names must be globally unique"。而 `sessions` 已被官方
`dsh-client-ui-session/lib/client.js:1104` 占用，再去 `provideRoot` 同名 hook 会直接抛错。

正确路径是换**服务实现**，不是抢 hook。

## 5. 传输层不能假设 SSE

Cloudflare 官方 Quick Tunnels → Limitations 明写：

- **不支持 SSE**
- 单隧道最多 200 个 in-flight 请求
- 没有可用性保证
- 域名每次创建都变

所以：单通道长轮询（in-flight 恒为 1）、隧道崩溃退避重启、地址经 rendezvous 消除。

## 6. 两端都不许缓存"真相"

手机端只有内存快照（`snapshots`），进程一关就没了。
这不是偷懒——如果把快照落盘并当成可信数据，就退回到"维护第二真相源"，前功尽弃。

需要持久化的只有两样，且都不参与引擎校验：

- `device.json`：本机在中转上的身份
- `token.txt` / `pairing.json`：访问令牌与配对码

---

## 7. 会话列表的真正数据源是 `workspace/follow`（实测抓包）

这是**只包装 `sessionController.list` 不够**的原因。

前端加载时开的流是：

```
{"type":"open","endpoint":"workspace/follow","payload":{"args":{}}}
→ {"type":"item","value":{"type":"baseline","value":{
     "items":[{"workspaceId":"…","path":"/root/xxx","title":"xxx",
               "sessionIds":["session-…"], …}],
     "archivedSessionIds":[], "pinnedSessionIds":[]}}}
```

**每个工作区的 `sessionIds` 决定该组下显示哪些会话。**
所以远程会话要出现在侧边栏，必须进这道流。

`dsh-api-workspace-controller/lib/index.js:963` 的 `follow()` 是 async generator，
内部用 `access.allows({kind:'session', id})` 过滤会话 id（969-972 行）。
注入必须发生在**过滤之后**——所以包装 `follow` 并在 yield baseline 前追加，
远程 id 就不会被权限判断丢掉。

服务键是 **`workspaceController`**（namespace 才是 `workspace`）：
`super(ctx, "workspaceController", { namespace: "workspace" })`（857 行）。
写成 `inject: {workspace: …}` 会让插件停在 `pending (waiting for service: workspace)`。

## 8. 三个只有真环境才暴露的契约差异

单测全绿也不代表能跑。以下都是靠真实例跑出来的：

| 差异 | 症状 | 真相 |
|---|---|---|
| `sessionController.list()` 返回 `{items:[…]}` 而非裸数组 | 整个会话列表消失 | 按数组 `.map()` 抛异常 |
| `list()` 的入参是 options 对象而非裸 `AbortSignal` | 远程列表永远拉不到 | `options.signal?.addEventListener is not a function` |
| 列表数据源是 `workspace/follow` 而非 `list()` | 数据拿到了但不显示 | 侧边栏读的是工作区的 `sessionIds` |

对应的防御代码在 `lib/mobile.js` 的 `toItems()` / `withItems()` / `pickSignal()` / `wrapWorkspace()`。

## 9. 事件必须带完整信封，否则历史加载失败

前端校验事件形状（`dsh-api-session-controller/lib/client.js:349`），缺一项就报
`Failed to load history: session wire event has an invalid envelope`：

| 字段 | 要求 |
|---|---|
| `type` | string |
| `seq` | 安全整数，`>= 0`，且不能是 `-0` |
| `time` | 安全整数（必须存在） |
| `data` | 必须存在且不为 `undefined` |
| `ignorable` | 若存在则必须为 `true` |

**推论**：不要自己拼事件。电脑端 `sessionQuery.read()` 返回的就是合法信封，
手机端原样透传即可——一旦"顺手规整一下"数据，历史就加载不出来。
（踩过：手工造测试数据时只给 `seq` 和 `type`，正是这个报错。）
