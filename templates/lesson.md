---
title: {一句话规则}
date: {YYYY-MM-DD}
category: {skill-design | workflow | integrations | conventions}
module: {受影响的模块/机制；没有就写 none}
problem_type: {bug | flakiness | design-trap | integration | performance | other}
severity: {high | medium | low}
tags: [{逗号分隔，检索用}]
status: observed
source: features/{slug}
---

# {一句话规则}

## Problem

{真实的失败或取舍 —— 带 file:line 或可复现的现象。写不出具体证据的这一节，整条就不要写}

## 参考做法

{以后 {什么情况} 就 {做什么}}

## 结论

{这条规则帮你避开的具体错误做法；以及什么条件下这条可能不再成立}

<!-- 模板说明（写完删掉）：
  - status 生命周期：observed（初始，没有例外）→ validated（独立后续任务真的用上并验证成功）
    → retired（仓库事实反证或找到 canonical owner，只标原因不删文件）。
  - ⛔ 不许出生即 validated。想写 validated，先回答：是哪个独立的后续任务用上了它？证据在哪？
  - date 用于过期机制：攒到一定量后，先按 date 从旧到新审查哪条已不成立。
-->
