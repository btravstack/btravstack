import { z } from "zod";

/**
 * The mark `Entity.codec` leaves on its union. On the def, not the instance:
 * zod's clones (`.describe()`, `.meta()`) copy the def, so the mark follows.
 */
const ENTITY_CODEC = "entityCodec";

/** What `Entity.codec` returns: its union, carrying a phantom `json` reads. */
export type EntityCodec<W extends z.core.SomeType, D extends z.core.SomeType> = z.ZodUnion<
  [z.ZodCodec<W, D>, D]
> & { readonly __entityCodec: true };

/**
 * Declares a field whose value JSON cannot hold, public as `Entity.codec`:
 *
 * ```ts
 * amount: Entity.codec(PositiveIntegerText, Amount, {
 *   decode: (text) => BigInt(text),
 *   encode: (amount) => String(amount),
 * }),
 * ```
 *
 * It is `z.union([z.codec(wire, domain, transforms), domain])`, and both halves
 * are load bearing. The decoded member is there because a field must accept its
 * own output — `make(toJSON())`, `update` and a nested entity's construction
 * all parse the decoded value again, and a bare codec refuses it. The codec
 * comes first because `z.encode` takes the first member that accepts a value:
 * with the decoded member first, a body would carry the `bigint` itself. So
 * `make` takes the wire text or the value, `z.encode(X.output, x.toJSON())`
 * writes the text, and `X.json` describes the text alone.
 *
 * The wire schema is what `X.json` publishes for the field, so make it the
 * canonical spelling `encode` writes rather than everything `decode` accepts.
 */
export function codec<const W extends z.core.SomeType, D extends z.core.SomeType>(
  wire: W,
  domain: D,
  transforms: Parameters<typeof z.codec<W, D>>[2],
): EntityCodec<W, D> {
  const union = z.union([z.codec(wire, domain, transforms), domain]);
  (union._zod.def as unknown as Record<string, unknown>)[ENTITY_CODEC] = true;
  return union as EntityCodec<W, D>;
}

type Def = z.core.$ZodTypeDef & Record<string, unknown>;

/**
 * A codec, by its def rather than by class: `reverseTransform` is what makes a
 * pipe encodable, and a plain `.transform()` pipe has none.
 */
const isCodec = (schema: z.core.$ZodType): boolean => "reverseTransform" in schema._zod.def;

/** An entity class or an `Entity.union(...)` value: it carries its own `json`. */
const hasJson = (schema: unknown): schema is { readonly json: z.core.$ZodType } =>
  (typeof schema === "function" || (typeof schema === "object" && schema !== null)) &&
  typeof (schema as { readonly make?: unknown }).make === "function" &&
  "json" in schema;

/**
 * One field schema as its JSON form: what `z.encode` writes for it. A codec is
 * its wire side, walked again since a wire side may itself be a codec; a nested
 * entity or union is its own `json`; `z.array`, `z.optional` and `z.nullable`
 * are walked. Anything else is itself.
 *
 * Only `Entity.codec`'s union collapses, to its codec: its decoded member is
 * there for `make`'s sake, and the codec it follows is what `z.encode` writes.
 * Any other union keeps every member, each walked — the type cannot see which
 * schema object a member is, so a rule that dropped a hand-written union's
 * member would type a field the validator still parses differently.
 *
 * A wrapper is cloned only when something under it changed, as `plain` does in
 * `shape.ts`, so a field with nothing to encode stays the very same object.
 * ponytail: `z.record`, `z.tuple`, `.default()`, `.readonly()` and an inline
 * `z.object` are not walked, as in `plain`; a codec inside one stays a codec.
 */
export const json = (schema: z.core.$ZodType): z.core.$ZodType => {
  if (hasJson(schema)) return schema.json;
  const def = schema._zod.def as Def;
  if (isCodec(schema)) return json((def as unknown as z.core.$ZodCodecDef).in);
  if (def.type === "union") {
    const { options } = def as unknown as z.core.$ZodUnionDef;
    if (def[ENTITY_CODEC] === true) return json(options[0] as z.core.$ZodType);
    const next = options.map(json);
    return next.every((member, i) => member === options[i])
      ? schema
      : z.core.util.clone(schema, { ...def, options: next } as typeof def);
  }
  if (def.type === "array") {
    const { element } = def as unknown as z.core.$ZodArrayDef;
    const next = json(element);
    return next === element
      ? schema
      : z.core.util.clone(schema, { ...def, element: next } as typeof def);
  }
  if (def.type === "optional" || def.type === "nullable") {
    const { innerType } = def as unknown as z.core.$ZodOptionalDef;
    const next = json(innerType);
    return next === innerType
      ? schema
      : z.core.util.clone(schema, { ...def, innerType: next } as typeof def);
  }
  return schema;
};
