import type { Meta, StoryObj } from "@storybook/svelte-vite";
import DesignAtlas from "./DesignAtlas.svelte";
import type { DesignAtlasArgs, DesignScreen } from "./atlas-types";

export const canonicalViewports = {
  desktop: {
    name: "Desktop · 1440 × 900",
    styles: { width: "1440px", height: "900px" },
    type: "desktop",
  },
  mobile: {
    name: "Mobile · 390 × 844",
    styles: { width: "390px", height: "844px" },
    type: "mobile",
  },
};

export const defaultArgs: DesignAtlasArgs = {
  screen: "overview",
  language: "en",
  accentColor: "#171715",
  backgroundColor: "#f6f5f2",
  surfaceColor: "#ffffff",
  textColor: "#171715",
  radius: 10,
  density: "comfortable",
  designState: "ready",
  selectedProfile: "design",
  selectedProvider: "ChatGPT",
  selectedJob: "job-4821",
  modal: "none",
};

export const commonArgTypes = {
  screen: {
    name: "Screen / 页面",
    control: "select",
    options: [
      "setup",
      "overview",
      "profiles",
      "providers",
      "provider-detail",
      "capabilities",
      "jobs",
      "job-detail",
      "system",
      "loading",
      "offline",
      "fatal",
      "modal",
    ] satisfies DesignScreen[],
    description: "Switch the Tokenless API Dashboard screen shown in the canvas.",
  },
  language: {
    name: "Language / 语言",
    control: "select",
    options: ["en", "zh-CN"],
    description:
      "All reasonable UI copy has an English and Simplified Chinese variant.",
  },
  accentColor: {
    name: "Accent / 强调色",
    control: { type: "color" },
  },
  backgroundColor: {
    name: "Background / 背景色",
    control: { type: "color" },
  },
  surfaceColor: {
    name: "Surface / 表面色",
    control: { type: "color" },
  },
  textColor: {
    name: "Text / 文字色",
    control: { type: "color" },
  },
  radius: {
    name: "Radius / 圆角",
    control: { type: "range", min: 0, max: 24, step: 1 },
  },
  density: {
    name: "Density / 密度",
    control: "select",
    options: ["compact", "comfortable", "airy"],
  },
  designState: {
    name: "UI state / 界面状态",
    control: "select",
    options: ["ready", "busy", "error"],
    description: "Preview the ready, busy, or error UI state.",
  },
  selectedProfile: {
    name: "Profile / 配置档",
    control: "select",
    options: ["design", "studio", "research", "personal"],
  },
  selectedProvider: {
    name: "Provider / 服务商",
    control: "select",
    options: ["ChatGPT", "Claude", "Gemini", "Grok", "Qwen / 千问", "DeepSeek", "Perplexity", "Z.ai / GLM", "Doubao / 豆包"],
  },
  selectedJob: {
    name: "Job / 作业",
    control: "select",
    options: ["job-4821", "job-4818", "job-4804", "job-4796"],
  },
  modal: {
    name: "Modal / 弹窗",
    control: "select",
    options: ["none", "profile", "provider", "capability", "command"],
  },
};

export function createAtlasMeta(
  title: string,
  screen: DesignScreen
): Meta<typeof DesignAtlas> {
  return {
    title,
    component: DesignAtlas,
    args: { ...defaultArgs, screen },
    argTypes: commonArgTypes,
    parameters: {
      layout: "fullscreen",
      controls: {
        expanded: true,
        disable: false,
        sort: "requiredFirst",
      },
      viewport: {
        options: canonicalViewports,
      },
      docs: {
        description: {
          component:
            "Tokenless API Dashboard UI reference. Story data is local and does not call the daemon.",
        },
      },
    },
    globals: { viewport: "desktop" },
  };
}

export type AtlasStory = StoryObj<typeof DesignAtlas>;
