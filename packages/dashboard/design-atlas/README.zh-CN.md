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
| 色板与颜色的语义角色 | `src/palette.css` → Foundations / Color & units |
| Token 单位图标与辅助说明 | `src/components/TokenIcon.svelte` 和 `TokenUnit.svelte` |
| 字体、间距和响应式规则 | `src/styles.css` 与组件内样式 |
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

## 色板与单位规则

- 界面以石墨色 `#171715` 和暖纸色 `#F6F5F2` 为基础；复用 `src/palette.css`，不要在图表里新增独立十六进制色值。Foundations / Color & units 展示实际共享色值。
- 类别图表按原始顺序使用 Tableau 10 的前七色：蓝 `#4E79A7`、橙 `#F28E2C`、红 `#E15759`、青绿 `#76B7B2`、绿 `#59A14F`、黄 `#EDC949`、紫 `#AF7AA1`。保持固定的能力类别映射；主要数据系列使用 Tableau 蓝，需求强度使用 ColorBrewer Greens[5]。需求图使用不常驻数字的紧凑方格，悬停、键盘聚焦或点按显示次数和统计口径。
- 状态色板中的灰绿、赭色、陶土色分别表示成功、警告、失败，这些状态变量与类别色分开；使用配套背景与边框，并保留状态文字或图标。Provider 品牌图形保留自身识别色。
- 带短横的圆框 T 是产品内的 **tokens** 单位图标，不是标准货币符号。数值旁使用 `src/components/TokenUnit.svelte`，已有说明的控件中使用 `TokenIcon.svelte`；辅助阅读标签和提示保留完整单位。
- 能力需求使用**次数**，不使用 token 图标。每个已结束任务的每种不同能力计 1 次，包括失败和取消；同一任务在一个类别中可以计多次。中性空格表示已接入但无需求记录，虚线方格表示无需求记录且未接入。绿色深浅不表示成功率，方格代表 Provider 与能力类别的组合，不是日期。

数据用色参考 [Carbon 对类别色、连续色阶和状态色的区分](https://carbondesignsystem.com/data-visualization/color-palettes/)；类别色值来自 [D3 schemeTableau10](https://d3js.org/d3-scale-chromatic/categorical)，数量色值来自 [D3 schemeGreens[5] / ColorBrewer](https://d3js.org/d3-scale-chromatic/sequential)。
