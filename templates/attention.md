# attention

> 每次开工必读。**保持在 30 行以内** —— 超了就说明该往 `lessons/` 里搬。
> 只放"不知道就会立刻踩坑"的当前事实。每次 `wf-keep` 顺手清掉过期行。

## 正在进行的迁移

- （示例，用完删掉）`src/legacy/` 下的模块正在迁往 `src/modules/`，
  新代码一律写在 `src/modules/`，不要往 legacy 里加东西。

## 临时绕过

- （示例）CI 上的 e2e 暂时跳过 Safari，本地不用管这个失败。

## 已知坏掉的

- （示例）`npm run build:docs` 当前是坏的，与本项目无关，别去修。

## 本周别碰

- （示例）`src/billing/` 有人在做大重构，避开。
