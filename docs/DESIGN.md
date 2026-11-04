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

### 11.1 不能监听事件，只能包装方法

`userQuestions` 服务只有 `ask()` 和 `askTimed()`，没有 `answer()`。

直觉上应该注册回答者：

```js
ctx.on('user-questions/request', async (request, next) => { … })   // 不成立
```

**这条走不通**。cordis 在派发时会按插件作用域过滤监听器
（`@deepseek-ai/cordis/lib/index.js:263`），插件自己 `on` 上去的监听器会被静默滤掉——
不报错、不告警，只是永远不被调用。表现出来就是"注册了，但一次都没触发"。

实际接管方式是**包装服务方法**：

```js
const questions = scoped.get('userQuestions');
const original = questions.ask;
questions.ask = async (request, agent) => { … }
```

审批同理，包 `approval.decide` 而**不是** `approval.request`——包 `decide` 才能保住
`approval/asked` + `approval/decided` 这对审计事件，包 `request` 会把它们拆散。

注意 `ask(request, agent)` 的 agent 是**第二个参数**，不在 `request.agent` 里。

### 11.2 双端竞争，而不是"手机优先"

早期实现是"手机在线就先问手机，离线就交回电脑"。这个语义是错的：

- 用户人在电脑前，却被手机上的弹窗挡住，得走过去；
- 用户不在电脑前（这是远程的前提），手机恰好刚断线一分钟，请求就被电脑吞了，
  等他连上时已经看不到任何东西。

现在的做法是**两端同时挂起，谁先答谁算**：

```js
const first = await Promise.race([phoneReply, localReply]);
```

- 手机先答 → 用手机的答案；
- 本机先答 → 用本机的，**并撤掉手机上的卡片**（见 11.4）；
- 手机离线时给 10 分钟窗口（`PHONE_AWAY_WINDOW_MS`），不是"立刻放手"。

两端都不锁死：任何一端答完，另一端自动收场。

### 11.3 跳过 ≠ 拒绝

`Skip` 的正确语义是**返回空选择**，而不是 decline：

```js
{ answers: questions.map((q) => ({ id: q.id, selected: [] })) }
```

模型收到空选择后会跳过这题继续工作。如果实现成 decline（交回电脑），
用户的跳过就变成了"把问题推回给不在身边的电脑"，反而卡住整条对话——
这和 Skip 按钮的字面意思完全相反。

### 11.4 另一端必须自动收场

双端竞争解决了"谁先答"，但没解决"另一个端怎么办"。本机先答之后，
手机上那张卡如果还挂着，用户点下去不会有任何反应——看起来就是插件坏了。

所以：

- `pushAsk` 记下待决项 id，本机先答时调 `cancelAsk(id)`；
- `/poll` 响应里带 `alive`（此刻还挂着的 id 列表），撤销时立刻唤醒长轮询；
- 手机端拿到 `alive` 后从队列里剔掉失效条目，浮层随之收起。

一个容易漏的点：`lib/client.js` 的 `poll()` 原来只挑
`updates` / `cursor` / `asks` 三个字段，`alive` 会被静默丢掉。
新增字段时必须同步改这里，否则"电脑端日志显示已撤销，手机毫无反应"。

对应实现：`lib/server.js` 的 `pushAsk()` / `cancelAsk()` / `takeUndeliveredAsks()`，
`lib/runtime.js` 的双端竞争包装，`lib/client-ui.js` 的浮层轮询。
退路逻辑由 `test/ask.test.mjs` 覆盖。
