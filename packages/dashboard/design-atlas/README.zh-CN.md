# Tokenless API Design Atlas

Storybook 使用本地示例数据渲染正式 Dashboard 的组件和样式。产品和 Atlas 都使用 `src/Dashboard.svelte`，不再分别维护页面实现。

## 打开 Atlas

```bash
npm run design:dev
```

打开 `http://localhost:6007/`，在侧栏选择页面、组件或交互。Controls 可以切换语言、配置档、加载或错误状态，以及正式 CSS 变量的预览值。视口工具栏提供桌面和移动端布局。

```bash
npm run design:build
```

此命令将独立的 Storybook 构建到 `design-atlas-static/`。

## 在哪里修改设计

| 修改内容 | 唯一维护位置 |
| --- | --- |
| 导航、顶栏组合、加载与离线及致命错误布局 | `src/Dashboard.svelte` |
| 页面布局和交互 | `src/views/*.svelte` |
| 配置档选择器、指标卡等共用组件 | `src/components/*.svelte` |
| 颜色、字体、间距和响应式规则 | `src/styles.css` 与组件内样式 |
| 产品文案 | `src/i18n/index.ts` |
| 示例数据、初始状态和评审场景 | `design-atlas/preview-data.ts`、`preview-state.svelte.ts` 和 `*.stories.ts` |

共用 UI 的修改会体现在 Storybook 和下一次 Dashboard 构建中。Controls 只改变当前预览；确认设计后，请将修改保存到共用源码。示例容器仅用于摆放组件，不覆盖组件字体或颜色。

## 边界

- `src/App.svelte` 负责认证、轮询、真实 API 操作和应用导航，并向共用 Dashboard 传入数据和操作。
- Atlas 引用正式 UI、样式、翻译和展示类型。正式产品不得引用 Atlas 数据或 Storybook 代码。
- Atlas 数据仅供设计展示，不代表遥测、服务商能力证据或 benchmark 结果。
- 配置档与配置编辑、对话取消只影响当前预览。切换场景或刷新后重置示例数据。
- 浏览器、服务商、Harness 和 tokenizer 操作会显示说明性错误，不连接真实服务。预览中的语义路由保持关闭。
- 详情与弹窗 stories 通过真实产品控件打开。仅存在于旧 Atlas、尚未在产品实现的命令面板、卡片、徽标等设计已从当前设计目录移除。
- Storybook 是代码设计工作台。新的产品设计在共用 UI 中实现，通过 stories 评审状态和交互。

## 验证

`npm run lint --workspace packages/dashboard` 一并检查产品、Atlas 和 Storybook 配置。可见修改应在 Storybook 和构建后的 Dashboard 中验证；本地示例数据不能证明后端行为。
