import { expectTypeOf } from "vitest";

import { VERSION } from "./index.js";

expectTypeOf(VERSION).toEqualTypeOf<string>();
