import type { Result } from "unthrown";
import { expectTypeOf, test } from "vitest";
import { z } from "zod";

import { Entity } from "./entity.js";
import type { DeepReadonly } from "./types.js";

const Payload = z.json().brand("ConfigurationPayload");
class Configuration extends Entity("Configuration")({ data: Payload }) {}
class Admission extends Entity("Admission")({ data: Payload }) {
  static create(
    input: Entity.CreateInput<typeof Admission>,
  ): Result<Admission, Entity.InvalidEntity> {
    return Admission.make(input);
  }
}

test("recursive branded json can pass between entity creation inputs", () => {
  const configuration = Configuration.make({
    data: { nested: [1, { enabled: true }] },
  }).getOrThrow();
  const admission: Result<Admission, Entity.InvalidEntity> = Admission.create({
    data: configuration.data,
  });
  void admission;
});

test("recursive json keeps its brand and immutable containers", () => {
  const configuration = Configuration.make({ data: [] }).getOrThrow();
  // @ts-expect-error a different JSON brand cannot replace the declared brand
  Admission.create({ data: z.json().brand("OtherPayload").parse({}) });
  const array = null as unknown as Extract<typeof configuration.data, readonly unknown[]>;
  // @ts-expect-error recursive arrays are readonly
  array.push(null);
  const object = null as unknown as Extract<
    typeof configuration.data,
    { readonly [key: string]: unknown }
  >;
  // @ts-expect-error recursive object properties are readonly
  object["changed"] = null;
  // @ts-expect-error a required branded field cannot be omitted
  Admission.create({});
});

test("tuples retain their length and element types", () => {
  const paired = null as unknown as { pair: DeepReadonly<[string, number]> };
  const length: 2 = paired.pair.length;
  const first: string = paired.pair[0];
  const second: number = paired.pair[1];
  // @ts-expect-error tuple elements stay immutable
  paired.pair[0] = "changed";
  // @ts-expect-error tuples keep their bounds
  void paired.pair[2];
  void length;
  void first;
  void second;
});

test("branded arrays keep their element types and brand", () => {
  type Tags = string[] & z.core.$brand<"Tags">;
  type Frozen = DeepReadonly<Tags>;
  expectTypeOf<Frozen[number]>().toEqualTypeOf<string>();
  expectTypeOf<Frozen>().toExtend<z.core.$brand<"Tags">>();
});

test("tuples with optional and rest elements keep their shape", () => {
  expectTypeOf<DeepReadonly<[string, ...number[]]>>().toEqualTypeOf<
    readonly [string, ...number[]]
  >();
  expectTypeOf<DeepReadonly<[string?, ...number[]]>>().toEqualTypeOf<
    readonly [string?, ...number[]]
  >();
});

test("unbranded recursive json can pass between factories", () => {
  class Source extends Entity("Source")({ data: Entity.field(z.json(), { unbranded: true }) }) {}
  class Target extends Entity("Target")({ data: Entity.field(z.json(), { unbranded: true }) }) {}
  const source = Source.make({ data: [] }).getOrThrow();
  Target.factory({})({ data: source.data });
});

test("branded tuples retain positional types", () => {
  type Pair = DeepReadonly<[string, number] & z.core.$brand<"Pair">>;
  expectTypeOf<Pair["length"]>().toEqualTypeOf<2>();
  expectTypeOf<Pair[0]>().toEqualTypeOf<string>();
  expectTypeOf<Pair[1]>().toEqualTypeOf<number>();
});
