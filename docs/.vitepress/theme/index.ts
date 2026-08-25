import Theme from "@btravstack/theme";

import CompileErrorDemo from "./CompileErrorDemo.vue";

import "./custom.css";

export default {
  ...Theme,
  // Spreading `Theme` and defining `enhanceApp` REPLACES the theme's own, so
  // the whole context is forwarded — not just `app`, which would silently drop
  // `router` and `siteData` the day the theme starts reading them.
  enhanceApp(ctx: { app: { component: (name: string, c: unknown) => void } }) {
    Theme.enhanceApp?.(ctx as never);
    ctx.app.component("CompileErrorDemo", CompileErrorDemo);
  },
};
