import DesignAtlas from "./DesignAtlas.svelte";
import {
  canonicalViewports,
  commonArgTypes,
  defaultArgs,
  type AtlasStory,
} from "./storybook-meta";

export default {
  title: "Jobs / Detail",
  component: DesignAtlas,
  args: { ...defaultArgs, screen: "job-detail" },
  argTypes: commonArgTypes,
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true, disable: false },
    viewport: { options: canonicalViewports },
  },
  globals: { viewport: "desktop" },
};

export const Default: AtlasStory = {};
export const Canceled: AtlasStory = { args: { selectedJob: "job-4796" } };
export const Mobile: AtlasStory = { globals: { viewport: "mobile" } };
