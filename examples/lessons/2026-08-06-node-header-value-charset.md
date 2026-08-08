---
status: validated
keywords: [http, header, location, url, encoding, redirect, ERR_INVALID_CHAR]
source: features/shortlink
---

# 要把用户提交的字符串原样写进响应头，必须在入口就拒绝码点 > U+00FF

**动作**：任何"存原始串、后续原样回显进响应头"的设计，校验环节必须独立拒绝码点 `> 0xFF`
（以及 C0 控制字符和 DEL），**不能只依赖 `new URL()` 是否抛异常**。

**为什么**：Node 校验响应头值用的是 `/[^\t\x20-\x7e\x80-\xff]/`。

- `new URL()` 对 `https://example.com/日本` **不抛错**（它只在 `.href` 里做百分号编码）
- 但 `res.setHeader('Location', raw)` 遇到码点 > U+00FF 会抛 `ERR_INVALID_CHAR`

两个决策各自都正确（用 `new URL()` 校验 ✓、存原始串以保证逐字符相等 ✓），
**组合起来才出 bug**：校验放行 → 201 拿到短码 → 访问必 500，短码还被永久占用。

同类的还有 CR/LF：`new URL()` 会**静默剥掉** Tab/CR/LF 再解析，
所以 `"https://exa\r\nmple.com"` 也能通过校验而在写头时炸掉。

**边界必须精确**（实测三个点）：
- `é` U+00E9、`ÿ` U+00FF、C1 区 U+0080~U+009F → Node **放行**，按"拒绝所有非 ASCII"写会误杀
- U+0100、U+65E5(日)、emoji 代理对 → Node **拒绝**，按"只拒绝 > 0x7F"写会漏

正确的判据是 `code <= 0x20 || code === 0x7f || code > 0xff`。

**排除的错误路径**：不要改成在 `sendRedirect` 里对 Location 做百分号编码 ——
那会挂掉"Location 与用户提交串逐字符相等"这条验收标准。
