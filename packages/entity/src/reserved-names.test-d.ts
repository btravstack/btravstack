import { z } from "zod";

import { Entity } from "./index.js";

const Reserved = z.string().brand("Reserved");
const id = Entity.field(z.string().brand("Id"), { identity: true });
const derived = Entity.computed(Reserved, () => "bad");
abstract class Root extends Entity.abstract("Root")({ id }) {}
const events = z.object({ type: z.literal("Opened") });
const opens = { Opened: () => ({ id: "a" as z.infer<typeof id.schema> }) };

// @ts-expect-error concrete declared `_tag` cannot shadow the instance protocol
Entity("Concrete")({ _tag: Reserved });

// @ts-expect-error abstract declared `_tag` cannot shadow the instance protocol
Entity.abstract("Abstract")({ _tag: Reserved });

// @ts-expect-error variant declared `_tag` cannot shadow the instance protocol
Root.extend("Variant")({ _tag: Reserved });

// @ts-expect-error aggregate declared `_tag` cannot shadow the instance protocol
Entity.aggregate("Aggregate")({ id, _tag: Reserved });

// @ts-expect-error concrete computed `_tag` cannot shadow the instance protocol
Entity("Concrete")({ id }, { computed: { _tag: derived } });

// @ts-expect-error abstract computed `_tag` cannot shadow the instance protocol
Entity.abstract("Abstract")({ id }, { computed: { _tag: derived } });

// @ts-expect-error variant computed `_tag` cannot shadow the instance protocol
Root.extend("Variant")({}, { computed: { _tag: derived } });

// @ts-expect-error aggregate computed `_tag` cannot shadow the instance protocol
Entity.aggregate("Aggregate")({ id })({ events, opens, evolve: {}, computed: { _tag: derived } });

// @ts-expect-error concrete declared `sameIdentityAs` cannot shadow the instance protocol
Entity("Concrete")({ sameIdentityAs: Reserved });

// @ts-expect-error abstract declared `sameIdentityAs` cannot shadow the instance protocol
Entity.abstract("Abstract")({ sameIdentityAs: Reserved });

// @ts-expect-error variant declared `sameIdentityAs` cannot shadow the instance protocol
Root.extend("Variant")({ sameIdentityAs: Reserved });

// @ts-expect-error aggregate declared `sameIdentityAs` cannot shadow the instance protocol
Entity.aggregate("Aggregate")({ id, sameIdentityAs: Reserved });

// @ts-expect-error concrete computed `sameIdentityAs` cannot shadow the instance protocol
Entity("Concrete")({ id }, { computed: { sameIdentityAs: derived } });

// @ts-expect-error abstract computed `sameIdentityAs` cannot shadow the instance protocol
Entity.abstract("Abstract")({ id }, { computed: { sameIdentityAs: derived } });

// @ts-expect-error variant computed `sameIdentityAs` cannot shadow the instance protocol
Root.extend("Variant")({}, { computed: { sameIdentityAs: derived } });

Entity.aggregate("Aggregate")({ id })({
  events,
  opens,
  evolve: {},
  // @ts-expect-error aggregate computed `sameIdentityAs` cannot shadow the instance protocol
  computed: { sameIdentityAs: derived },
});

// @ts-expect-error concrete declared `toJSON` cannot shadow the instance protocol
Entity("Concrete")({ toJSON: Reserved });

// @ts-expect-error abstract declared `toJSON` cannot shadow the instance protocol
Entity.abstract("Abstract")({ toJSON: Reserved });

// @ts-expect-error variant declared `toJSON` cannot shadow the instance protocol
Root.extend("Variant")({ toJSON: Reserved });

// @ts-expect-error aggregate declared `toJSON` cannot shadow the instance protocol
Entity.aggregate("Aggregate")({ id, toJSON: Reserved });

// @ts-expect-error concrete computed `toJSON` cannot shadow the instance protocol
Entity("Concrete")({ id }, { computed: { toJSON: derived } });

// @ts-expect-error abstract computed `toJSON` cannot shadow the instance protocol
Entity.abstract("Abstract")({ id }, { computed: { toJSON: derived } });

// @ts-expect-error variant computed `toJSON` cannot shadow the instance protocol
Root.extend("Variant")({}, { computed: { toJSON: derived } });

// @ts-expect-error aggregate computed `toJSON` cannot shadow the instance protocol
Entity.aggregate("Aggregate")({ id })({ events, opens, evolve: {}, computed: { toJSON: derived } });

// @ts-expect-error concrete declared `update` cannot shadow the instance protocol
Entity("Concrete")({ update: Reserved });

// @ts-expect-error abstract declared `update` cannot shadow the instance protocol
Entity.abstract("Abstract")({ update: Reserved });

// @ts-expect-error variant declared `update` cannot shadow the instance protocol
Root.extend("Variant")({ update: Reserved });

// @ts-expect-error aggregate declared `update` cannot shadow the instance protocol
Entity.aggregate("Aggregate")({ id, update: Reserved });

// @ts-expect-error concrete computed `update` cannot shadow the instance protocol
Entity("Concrete")({ id }, { computed: { update: derived } });

// @ts-expect-error abstract computed `update` cannot shadow the instance protocol
Entity.abstract("Abstract")({ id }, { computed: { update: derived } });

// @ts-expect-error variant computed `update` cannot shadow the instance protocol
Root.extend("Variant")({}, { computed: { update: derived } });

// @ts-expect-error aggregate computed `update` cannot shadow the instance protocol
Entity.aggregate("Aggregate")({ id })({ events, opens, evolve: {}, computed: { update: derived } });

// @ts-expect-error concrete declared `constructor` cannot shadow the instance protocol
Entity("Concrete")({ constructor: Reserved });

// @ts-expect-error abstract declared `constructor` cannot shadow the instance protocol
Entity.abstract("Abstract")({ constructor: Reserved });

// @ts-expect-error variant declared `constructor` cannot shadow the instance protocol
Root.extend("Variant")({ constructor: Reserved });

// @ts-expect-error aggregate declared `constructor` cannot shadow the instance protocol
Entity.aggregate("Aggregate")({ id, constructor: Reserved });

// @ts-expect-error concrete computed `constructor` cannot shadow the instance protocol
Entity("Concrete")({ id }, { computed: { constructor: derived } });

// @ts-expect-error abstract computed `constructor` cannot shadow the instance protocol
Entity.abstract("Abstract")({ id }, { computed: { constructor: derived } });

// @ts-expect-error variant computed `constructor` cannot shadow the instance protocol
Root.extend("Variant")({}, { computed: { constructor: derived } });

Entity.aggregate("Aggregate")({ id })({
  events,
  opens,
  evolve: {},
  // @ts-expect-error aggregate computed `constructor` cannot shadow the instance protocol
  computed: { constructor: derived },
});

// @ts-expect-error concrete declared `emit` cannot shadow the instance protocol
Entity("Concrete")({ emit: Reserved });

// @ts-expect-error abstract declared `emit` cannot shadow the instance protocol
Entity.abstract("Abstract")({ emit: Reserved });

// @ts-expect-error variant declared `emit` cannot shadow the instance protocol
Root.extend("Variant")({ emit: Reserved });

// @ts-expect-error aggregate declared `emit` cannot shadow the instance protocol
Entity.aggregate("Aggregate")({ id, emit: Reserved });

// @ts-expect-error concrete computed `emit` cannot shadow the instance protocol
Entity("Concrete")({ id }, { computed: { emit: derived } });

// @ts-expect-error abstract computed `emit` cannot shadow the instance protocol
Entity.abstract("Abstract")({ id }, { computed: { emit: derived } });

// @ts-expect-error variant computed `emit` cannot shadow the instance protocol
Root.extend("Variant")({}, { computed: { emit: derived } });

// @ts-expect-error aggregate computed `emit` cannot shadow the instance protocol
Entity.aggregate("Aggregate")({ id })({ events, opens, evolve: {}, computed: { emit: derived } });

// A runtime guard checks dynamic maps whose keys the type cannot enumerate.
const dynamicComputed: Record<string, Entity.ComputedField<typeof Reserved, unknown>> = {
  description: derived,
};
Entity("Dynamic")({ id }, { computed: dynamicComputed });
