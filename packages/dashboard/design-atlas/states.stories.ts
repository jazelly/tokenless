import DesignAtlas from "./DesignAtlas.svelte";
import {
  canonicalViewports,
  commonArgTypes,
  defaultArgs,
  type AtlasStory,
} from "./storybook-meta";

export default {
  title: "States / Loading, offline, fatal",
  component: DesignAtlas,
  args: { ...defaultArgs, screen: "loading" },
  argTypes: commonArgTypes,
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true, disable: false },
    viewport: { options: canonicalViewports },
  },
  globals: { viewport: "desktop" },
};

export const Loading: AtlasStory = { args: { screen: "loading" } };
export const Offline: AtlasStory = { args: { screen: "offline" } };
export const Fatal: AtlasStory = { args: { screen: "fatal" } };
export const MobileOffline: AtlasStory = {
  args: { screen: "offline" },
  globals: { viewport: "mobile" },
};
