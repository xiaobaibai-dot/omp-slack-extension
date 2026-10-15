import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import slackExtension from "./index.ts";
import { readWindowsConfig } from "./src/windows-config.ts";
export default function windowsSlackExtension(pi: ExtensionAPI) {
  slackExtension(pi, readWindowsConfig);
}
