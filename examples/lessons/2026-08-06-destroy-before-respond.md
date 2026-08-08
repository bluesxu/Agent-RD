---
status: validated
keywords: [http, socket, destroy, ECONNRESET, 413, payload, error-response, guard]
source: features/shortlink
---

# 要给客户端回错误响应，就不能先 destroy 请求流

**动作**：在"边收边中止"的请求体读取里，**不要在 reject/抛错之前调 `req.destroy()`**。
只摘掉自己的监听器即可 —— 没有监听器时流会自行丢弃后续字节，内存依然有界。

**为什么**：body 未读完时 `IncomingMessage._destroy` 会置 `aborted = true` 并**连带销毁 socket**。
等上层的错误处理在下一个 microtask 跑起来时 socket 已经死了，
客户端收到的是 `ECONNRESET`（socket hang up）而**不是**你精心设计的 `413`。

更隐蔽的是**失败被静默吞掉**：常见护栏写的是
```js
if (res.headersSent || res.writableEnded) return;   // 拦不住
```
这两个标志此时**都还是 false**，于是代码心安理得地往一个已销毁的 socket 里写，然后什么都不报。

**护栏必须补上 `res.socket?.destroyed`。**

**实测边界**（重要，避免过度设计）：
移除 `req.destroy()` 这一处就已经修好了。响应发完之后的连接拆除是 Node 自己做的
（带 `Connection: close` 时在 `res` finish 后走 `socket.destroySoon()`，会先把已排队的字节冲出去再关）。

对照实验：把「等 `res 'finish'` 且 `req 'end'/'close'` 都到齐才 destroy」那套 22 行机制**整块删掉**，
70KB / 512KB / 1MB / 2MB / 4MB / 8MB / 16MB / 32MB / 64MB 尺寸扫描结果**逐项相同**，全部 413。

**⚠️ 证据边界**：以上对照实验只在 Windows 环回上做过。
环回不丢包不乱序，"内核接收缓冲区尚有未读字节时 destroy 触发 RST"这一危险
在真实有损广域网上**可能确实存在**，未被证伪。
所以这条 lesson 的确定部分是「不要在响应前 destroy」，
不确定部分是「响应后是否需要显式等待 drain 再 destroy」。
