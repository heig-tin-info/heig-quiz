/// <reference types="vite/client" />

/** lucide's alias names, each mapped to its canonical name (vite.config.ts). */
declare module "virtual:lucide-aliases" {
  import type { IconName } from "lucide-react/dynamic";
  const aliases: Readonly<Partial<Record<IconName, IconName>>>;
  export default aliases;
}
