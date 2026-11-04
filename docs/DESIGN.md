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

## 10. 怎么在真实环境里验一遍

单元测试过了不代表能跑。下面这套是被真 bug 打出来之后总结的验法：

```bash
# 1) 起中转
node server/rendezvous.js --port 18907 --data /tmp/wire-rz

# 2) 起"电脑"（插进 profile 用 insert，--patch 只能改既有条目）
cat > /tmp/desktop.yml <<'YML'
- insert:
    - id: dsh-wire
      name: /绝对路径/lib/index.js
      config: { role: desktop, port: 18121, rendezvous: http://127.0.0.1:18907 }
YML
DSH_HOME=/tmp/h1 dsh --profile web --patch /tmp/desktop.yml --port 3097 --no-open

# 3) 起"手机"（只给中转地址和配对码，地址应由中转解析出来）
DSH_HOME=/tmp/h2 dsh --profile web --patch /tmp/mobile.yml --port 3098 --no-open

# 4) 看插件自己的日志（比 DSH 的日志有用得多）
tail -f /tmp/h1/dsh-wire/wire.log /tmp/h2/dsh-wire/wire.log
```

**注意**：ESM 不支持目录导入，`name` 必须指到 `lib/index.js`，
写成裸目录会报 `ERR_UNSUPPORTED_DIR_IMPORT`。

看日志里这几行就知道通了：

```
[desktop] 本机就绪 http://127.0.0.1:18121
[tunnel]  就绪 https://xxx.trycloudflare.com
[desktop] 配对码 ABC123（5 分钟内有效）
[mobile]  代理已安装（list/read/observeSession/listSessions/prompt/workspace.follow）
[mobile]  已连上电脑 https://xxx.trycloudflare.com，协议 1
```

### 隧道在受限网络里可能不可达

本机验证时遇到过 cloudflared 能建隧道、能打印地址，但访问返回 `404`
（响应带 `cf-ray` 却没有任何源站头）。同环境下 `curl 127.0.0.1:<port>` 是正常的。
原因是运行环境的 cloudflared 凭据/出口策略，不是插件逻辑——
`tunnel.js` 只负责拉起进程、抓地址、上报中转，这三步都验证过。

**因此** `rendezvous` 与手机端自动解析这条路可以独立验证：手工调一次
`/register` 把 url 指向本地端口，手机端配上 `pairCode` 照样能走通全流程。
这也是排查"连不上"时该先分清的一步：是**找不到地址**（中转）还是**地址连不上**（隧道）。

## 11. 提问（ask / 审批）怎么接

**先纠正一个容易踩的假设**：`userQuestions` 服务只有 `ask()` 和 `askTimed()`，
**没有 `answer()`**。`ask()` 自己不存答案，它把请求交给 cordis 的 waterfall 事件
`user-questions/request`，本机前端就是其中一个回答者：

```js
ctx.waterfall('user-questions/request', request, noAnswerer)
```

所以接管方式是**注册回答者**，不是包装方法：

```js
ctx.on('user-questions/request', async (request, next) => { … })
```

答案的形状是（`AskUserQuestionAnswer`）：

```ts
{ answers: [{ id: string, selected: string[], custom?: string }] }
```

### 三条宁可"不接管"的规矩

远程功能最容易犯的错是"接管了却没人答"，把两边一起卡死。所以：

1. 手机不在线（一分钟内没轮询）→ 立刻 `next()`，电脑照常弹窗；
2. 手机在线但没答（超时 / 人走开）→ 也 `next()`；
3. 手机接了却弹不出卡片 → 主动 `decline`，**立刻**交回电脑，而不是干等 60 秒超时。

第 3 条是手机端独有的失败模式：手机端引擎要再触发一次本机的
`user-questions/request` 才能让手机前端弹卡片，没有前端在听时会抛
`NO_PROVIDER`——这时必须马上放手。

对应实现在 `lib/server.js` 的 `pushAsk()` / `takeUndeliveredAsks()` 与
`lib/runtime.js` 的事件注册；退路逻辑由 `test/ask.test.mjs` 覆盖。
