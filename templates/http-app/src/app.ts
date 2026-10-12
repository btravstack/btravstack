import { HttpModule, defineHttp } from "@btravstack/orpc-server";
import { OkAsync } from "unthrown";

import { contract } from "./contract.js";

const api = defineHttp();
const router = api.OrpcRouter(contract)({
  sync: () => ({
    hello: ({ input }) => OkAsync({ message: `Hello, ${input.name}!` }),
  }),
});

export const App = HttpModule("App")({ router });
