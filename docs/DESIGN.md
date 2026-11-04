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
