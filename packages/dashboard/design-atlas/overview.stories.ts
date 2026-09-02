import DesignAtlas from "./DesignAtlas.svelte";
import {
  canonicalViewports,
  commonArgTypes,
  defaultArgs,
  type AtlasStory,
} from "./storybook-meta";

export default {
  title: "Overview / Usage analytics",
  component: DesignAtlas,
  args: { ...defaultArgs, screen: "overview" },
  argTypes: commonArgTypes,
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true, disable: false },
    viewport: { options: canonicalViewports },
  },
  globals: { viewport: "desktop" },
};

export const Default: AtlasStory = {};
export const Mobile: AtlasStory = { globals: { viewport: "mobile" } };
export const Chinese: AtlasStory = { args: { language: "zh-CN" } };
export const Loading: AtlasStory = { args: { designState: "busy" } };
export const Error: AtlasStory = { args: { designState: "error" } };
