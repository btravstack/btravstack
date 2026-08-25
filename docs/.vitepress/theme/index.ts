import Theme from "@btravstack/theme";

import CompileErrorDemo from "./CompileErrorDemo.vue";

import "./custom.css";

export default {
  ...Theme,
  enhanceApp({ app }: { app: { component: (name: string, c: unknown) => void } }) {
    Theme.enhanceApp?.({ app } as never);
    app.component("CompileErrorDemo", CompileErrorDemo);
  },
};
