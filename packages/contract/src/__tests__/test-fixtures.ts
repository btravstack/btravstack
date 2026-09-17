import { test } from "vitest";

type Row = { readonly id: number; readonly label: string };

/**
 * A store with a keyset seek, standing in for the one call `keyset` cannot
 * make: order by the direction it was given, resume STRICTLY after the cursor,
 * and answer at most `take` rows — which is what every real store's cursor
 * call promises, and what the arithmetic around it is built on.
 */
const seek = (rows: readonly Row[]) => ({
  rows,
  seek: ({
    take,
    backward,
    cursor,
  }: {
    readonly take: number;
    readonly backward: boolean;
    readonly cursor: string | undefined;
  }): readonly Row[] => {
    const walked = backward ? [...rows].reverse() : rows;
    const resumed =
      cursor === undefined
        ? walked
        : walked.slice(walked.findIndex((row) => row.id === Number(cursor)) + 1);
    return resumed.slice(0, take);
  },
});

export const it = test.extend<{
  readonly fragment: { readonly place: { readonly kind: "procedure" } };
  readonly store: ReturnType<typeof seek>;
  readonly empty: ReturnType<typeof seek>;
}>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  fragment: async ({}, use) => {
    await use({ place: { kind: "procedure" } });
  },
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  store: async ({}, use) => {
    await use(seek([1, 2, 3, 4, 5].map((id) => ({ id, label: `row-${id}` }))));
  },
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  empty: async ({}, use) => {
    await use(seek([]));
  },
});
