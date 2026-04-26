<!--
PR 标题请用 conventional-commit 风格：type(scope): subject

  type   ::= feat | fix | docs | refactor | perf | test | chore | ci | style
  scope  ::= 包名 / 子目录 / 'release' 等
  subject::= 祈使句、简体中文或英文均可、不带句号

📍 分支约定：
  - 日常 PR 一律 base 到 dev
  - main 仅接收发布 — 进入 main 必须带版本号 bump，否则 release-guard 会拦截
  - DG-Kit 走 changesets：写 .changeset/*.md → PR 到 dev → 合并 → 机器人自动开发布 PR 到 main
  - 其它仓库：dev 上手动 bump version 后 → PR 到 main → release-guard 校验 → 合并 → auto-tag

例：feat(protocol): add setLimits() to update strength caps
    fix(web): bluetooth chooser auto-trigger regression
    docs(agent): clarify cold-start strength cap
-->

## 概述

<!-- 一两句话：改了什么 + 为什么。WHY 比 WHAT 重要。 -->

## 测试计划

- [ ] `npm run lint`
- [ ] `npm run typecheck`（如适用）
- [ ] `npm run test`（如适用）
- [ ] `npm run build`
- [ ] 真机 / 浏览器烟测（如涉及设备 / UI）

## 影响范围

<!--
- 是否破坏 API？是 → 加 `breaking-change` 标签，PR 标题改 `feat!` 或 `fix!`
- 是否需要 changeset / changelog？(DG-Kit 必加；其它项目按需)
- 是否影响下游消费者？列举一下
-->

## 关联

<!-- closes #123, refs #456, depends on #789 -->
