import type { OpenAPIGenerator } from "@orpc/openapi";

import type { OpenApiOptions } from "./openapi.js";

type GeneratorBase = NonNullable<Parameters<OpenAPIGenerator["generate"]>[1]>["base"];

declare const options: OpenApiOptions;
declare const base: GeneratorBase;

const generatorBase: GeneratorBase = options.base;
const forwarded: OpenApiOptions = { base };
