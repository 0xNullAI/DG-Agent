<!--
PR 标题请用 conventional-commit 风格：type(scope): subject

  type   ::= feat | fix | docs | refactor | perf | test | chore | ci | style
  scope  ::= 包名 / 子目录 / 'release' 等
  subject::= 祈使句、简体中文或英文均可、不带句号

⚠️ DG-Agent 的目标分支是 dev（不是 main）。main 仅用于发布。

例：feat(runtime): rate-limit policy injection point
    fix(web): bluetooth chooser auto-trigger regression
    docs(agent): clarify cold-start strength cap
-->

## 概述

<!-- 一两句话：改了什么 + 为什么。WHY 比 WHAT 重要。 -->

## 测试计划

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] 真机烟测：连真实郊狼，跑一遍 start / adjust_strength / change_wave / burst（涉及设备 / UI 时必须）

## 影响范围

<!--
- 是否破坏 API？是 → 加 `breaking-change` 标签，PR 标题改 `feat!` 或 `fix!`
- 是否影响下游消费者（DG-Chat / DG-MCP）？列举一下
- UI 变更是否在 CLAUDE.md 「UI Maintenance Notes」允许范围内？
-->

## 关联

<!-- closes #123, refs #456, depends on #789 -->
