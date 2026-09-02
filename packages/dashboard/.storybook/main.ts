import type { StorybookConfig } from "@storybook/svelte-vite";

const config: StorybookConfig = {
  stories: ["../design-atlas/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
  addons: [],
  framework: {
    name: "@storybook/svelte-vite",
    options: {},
  },
  docs: {
    autodocs: "tag",
  },
};

export default config;
