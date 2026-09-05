// The "serves nothing" gate: `HttpModule` composes a router, fragments, or
// both, and refuses a call that supplies neither. A gate that refuses
// everything would pass this file on the negative case alone, so all three
// valid shapes are pinned as positives too. Each `@ts-expect-error` is an
// assertion: if one stops erroring, the gate is gone.
import { start } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
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

// The `unit` needs-propagation gate: a bound `unit.anonymous` module's own
// unmet needs join `HttpModule`'s own Needs channel (an import's own unmet
// needs are not `HttpModule`'s OWN call to re-declare — di's `NeedsGate`
// TSDoc), so the gate that refuses them is `start`'s ordinary
// `UNSATISFIED DEPENDENCIES`, never a marker of the kernel's.
const startOptions = { signals: false, probes: false } as const;
class UnitDep extends Port("UnitModuleTypeDDep")<{ readonly value: number }> {}
class UnitSpan extends Port("UnitModuleTypeDSpan")<{ readonly at: number }> {}
const UnitModule = Module("UnitModuleTypeD")({
  needs: [UnitDep],
  provides: [
    Provider(UnitSpan)({ inject: { dep: UnitDep }, sync: ({ dep }) => ({ at: dep.value }) }),
  ],
  exports: [UnitSpan],
});

const _withUnitSatisfied = start(
  HttpModule("WithUnitSatisfied")({
    router,
    port: 0,
    unit: { anonymous: UnitModule },
    provides: [Provider(UnitDep)({ inject: {}, value: { value: 1 } })],
  }),
  startOptions,
);
void _withUnitSatisfied;

const _unloggedUnit = HttpModule("WithUnitUnmet")({
  router,
  port: 0,
  unit: { anonymous: UnitModule },
});
// @ts-expect-error — UNSATISFIED DEPENDENCIES: nothing provides `UnitDep`, which `UnitModule` needs
const _withUnitUnmet = start(_unloggedUnit, startOptions);
void _withUnitUnmet;
