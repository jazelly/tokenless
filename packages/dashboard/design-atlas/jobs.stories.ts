import DesignAtlas from "./DesignAtlas.svelte";
import {
  canonicalViewports,
  commonArgTypes,
  defaultArgs,
  type AtlasStory,
} from "./storybook-meta";

export default {
  title: "Chat History",
  component: DesignAtlas,
  args: { ...defaultArgs, screen: "jobs" },
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
