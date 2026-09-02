export type DesignScreen =
  | "setup"
  | "overview"
  | "profiles"
  | "providers"
  | "provider-detail"
  | "capabilities"
  | "jobs"
  | "job-detail"
  | "system"
  | "loading"
  | "offline"
  | "fatal"
  | "modal";

export type DesignLanguage = "en" | "zh-CN";
export type Density = "compact" | "comfortable" | "airy";
export type DesignState = "ready" | "busy" | "error";
export type DesignModal =
  | "none"
  | "profile"
  | "provider"
  | "capability"
  | "command";

export type DesignAtlasArgs = {
  screen: DesignScreen;
  language: DesignLanguage;
  accentColor: string;
  backgroundColor: string;
  surfaceColor: string;
  textColor: string;
  radius: number;
  density: Density;
  designState: DesignState;
  selectedProfile: string;
  selectedProvider: string;
  selectedJob: string;
  modal: DesignModal;
};
