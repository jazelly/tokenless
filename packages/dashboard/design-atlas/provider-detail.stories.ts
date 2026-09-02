import DesignAtlas from "./DesignAtlas.svelte";
import {
  canonicalViewports,
  commonArgTypes,
  defaultArgs,
  type AtlasStory,
} from "./storybook-meta";

export default {
  title: "Providers / Detail + routing",
  component: DesignAtlas,
  args: { ...defaultArgs, screen: "provider-detail" },
  argTypes: commonArgTypes,
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true, disable: false },
    viewport: { options: canonicalViewports },
  },
  globals: { viewport: "desktop" },
};

export const Default: AtlasStory = {};
export const AlternateProvider: AtlasStory = {
  args: { selectedProvider: "Claude" },
};
export const Mobile: AtlasStory = { globals: { viewport: "mobile" } };
