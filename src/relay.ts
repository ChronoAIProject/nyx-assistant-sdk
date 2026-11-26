import manifest from "../package.json" with { type: "json" };

export const officialRelay = manifest.version.includes("-")
  ? "https://nyx-assistant-sdk-staging-chronoai.apps.nyxid.ai"
  : "https://nyx-assistant-sdk-chronoai.apps.nyxid.ai";
