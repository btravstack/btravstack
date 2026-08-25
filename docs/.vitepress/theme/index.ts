import Theme from "@btravstack/theme";
import type { EnhanceAppContext, Theme as VitePressTheme } from "vitepress";

import "./custom.css";

import CompileErrorDemo from "./CompileErrorDemo.vue";

export default {
  ...Theme,
  // Spreading `Theme` and defining `enhanceApp` replaces the theme's own, so
  // the context is forwarded to it whole rather than dropped.
  enhanceApp(ctx: EnhanceAppContext) {
    Theme.enhanceApp?.(ctx);
    ctx.app.component("CompileErrorDemo", CompileErrorDemo);
  },
} satisfies VitePressTheme;
