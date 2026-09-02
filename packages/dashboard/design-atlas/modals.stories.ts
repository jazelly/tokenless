import DesignAtlas from "./DesignAtlas.svelte";
import {
  canonicalViewports,
  commonArgTypes,
  defaultArgs,
  type AtlasStory,
} from "./storybook-meta";

export default {
  title: "Modals / Local interactions",
  component: DesignAtlas,
  args: { ...defaultArgs, screen: "modal" },
  argTypes: commonArgTypes,
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true, disable: false },
    viewport: { options: canonicalViewports },
  },
  globals: { viewport: "desktop" },
};

export const ProviderPicker: AtlasStory = {
  args: { screen: "modal", modal: "provider" },
};
export const ProfilePicker: AtlasStory = {
  args: { screen: "modal", modal: "profile" },
};
export const CapabilityDetail: AtlasStory = {
  args: { screen: "modal", modal: "capability" },
};
export const CommandPalette: AtlasStory = {
  args: { screen: "modal", modal: "command" },
};
export const Mobile: AtlasStory = {
  args: { screen: "modal", modal: "provider" },
  globals: { viewport: "mobile" },
};
