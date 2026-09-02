import DesignAtlas from "./DesignAtlas.svelte";
import {
  canonicalViewports,
  commonArgTypes,
  defaultArgs,
  type AtlasStory,
} from "./storybook-meta";

export default {
  title: "Foundations / Design tokens",
  component: DesignAtlas,
  args: { ...defaultArgs, screen: "foundations" },
  argTypes: commonArgTypes,
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true, disable: false },
    viewport: { options: canonicalViewports },
  },
  globals: { viewport: "desktop" },
};

export const Tokens: AtlasStory = {};
export const Mobile: AtlasStory = { globals: { viewport: "mobile" } };
