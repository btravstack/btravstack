import { authenticated } from "@btravstack/contract";
import { oc } from "@orpc/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { openApiDocument } from "./openapi.js";

const bearer = { type: "http", scheme: "bearer" } as const;
const mtls = { type: "mutualTLS" } as const;

const ref = z.object({ id: z.string() });
const base = { info: { title: "Orders", version: "1" } };

describe("openApiDocument", () => {
  it("answers through the Result channel — async, and cannot fail", async () => {
    // GIVEN any contract
    // WHEN a document is generated
    // THEN it arrives as an Ok on an AsyncResult<_, never> — a generator fault
    // is a defect, never a raw rejection escaping to the caller
    await expect(
      openApiDocument({ health: oc.output(z.object({ ok: z.boolean() })) }, { base }),
    ).toBeOkWith(expect.objectContaining({ info: base.info }));
  });

  it("gives a marked procedure the schemes and scopes its contract names", async () => {
    // GIVEN a contract whose orders are marked and whose health check is not
    const contract = {
      orders: authenticated({ user: ["orders:write"] })({ place: oc.input(ref).output(ref) }),
      health: oc.output(z.object({ ok: z.boolean() })),
    };

    // WHEN a document is generated
    const doc = (
      await openApiDocument(contract, {
        base,
        securitySchemes: { user: bearer },
      })
    ).get();

    // THEN the marked operation carries its requirement and the unmarked one carries none
    expect({
      place: doc.paths?.["/orders/place"]?.post?.security,
      health: doc.paths?.["/health"]?.post?.security,
      schemes: doc.components?.securitySchemes,
    }).toEqual({
      place: [{ user: ["orders:write"] }],
      health: undefined,
      schemes: { user: bearer },
    });
  });

  it("round-trips OR as one requirement per alternative", async () => {
    // GIVEN a procedure either scheme may satisfy.
    //
    // There is no AND case to test: `@btravstack/contract` REFUSES a
    // requirement naming two schemes, because OpenAPI reads that as AND and
    // this package would run it as OR. So AND cannot reach a document — the
    // contract stops it a layer earlier, and the compiler stops this spec from
    // pretending otherwise.
    const contract = {
      either: authenticated({ user: [] }, { mtls: [] })({ run: oc.output(ref) }),
    };

    // WHEN a document is generated
    const doc = (
      await openApiDocument(contract, {
        base,
        securitySchemes: { user: bearer, mtls },
      })
    ).get();

    // THEN each alternative is its own object, which is OpenAPI's own OR
    expect(doc.paths?.["/either/run"]?.post?.security).toEqual([{ user: [] }, { mtls: [] }]);
  });

  it("lets a procedure's own mark shadow the record's", async () => {
    // GIVEN a marked record holding a procedure marked differently
    const contract = {
      admin: authenticated({ user: [] })({
        purge: authenticated({ mtls: ["admin"] })(oc.output(ref)),
        list: oc.output(ref),
      }),
    };

    // WHEN a document is generated
    const doc = (
      await openApiDocument(contract, {
        base,
        securitySchemes: { user: bearer, mtls },
      })
    ).get();

    // THEN the nearest mark wins, and its sibling still inherits the record's
    expect({
      purge: doc.paths?.["/admin/purge"]?.post?.security,
      list: doc.paths?.["/admin/list"]?.post?.security,
    }).toEqual({ purge: [{ mtls: ["admin"] }], list: [{ user: [] }] });
  });
});
