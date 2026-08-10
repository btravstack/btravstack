import { runMain, start } from "@btravstack/start";

import { AppModule } from "./app.js";
import { httpRuntime } from "./http-runtime.js";

const port = Number(process.env["PORT"] ?? 3000);

await runMain(
  start(AppModule, {
    runtime: httpRuntime({
      port,
      onListening: (bound) => process.stdout.write(`listening on http://127.0.0.1:${bound}\n`),
    }),
  }),
);
