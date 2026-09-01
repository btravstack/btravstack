// The "serves nothing" gate: `HttpModule` composes a router, fragments, or
// both, and refuses a call that supplies neither. A gate that refuses
// everything would pass this file on the negative case alone, so all three
// valid shapes are pinned as positives too. Each `@ts-expect-error` is an
// assertion: if one stops erroring, the gate is gone.
import { oc } from "@orpc/contract";
import { OkAsync } from "unthrown";

import { defineHttp } from "./define-http.js";
import { html } from "./html.js";
import { HttpModule } from "./http-module.js";

const api = defineHttp();

const contract = oc.router({ hello: oc });
const router = api.OrpcRouter(contract)({
  inject: {},
  sync: () => ({ hello: () => OkAsync("hi") }),
});

const rowFragment = api.HtmxGet("/row")({
  inject: {},
  sync: () => () => OkAsync(html`<p>row</p>`),
});
const fragments = api.HtmxFragments([rowFragment]);

// @ts-expect-error — neither `router` nor `fragments` is supplied
void HttpModule("Neither")({ port: 0 });

void HttpModule("RouterOnly")({ router, port: 0 });

void HttpModule("FragmentsOnly")({ fragments, port: 0, provides: [rowFragment] });

void HttpModule("Both")({ router, fragments, port: 0, provides: [rowFragment] });
