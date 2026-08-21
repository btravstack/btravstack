/**
 * A UUIDv7, which `crypto.randomUUID()` is not — it mints v4, and
 * `z.uuidv7()` rejects it. Test-only: nothing in an example generates an id,
 * they all arrive from a caller.
 *
 * Layout is RFC 9562: 48 bits of Unix milliseconds, the version nibble `7`,
 * the variant bits `10`, random elsewhere.
 */
export const uuidv7 = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const millis = BigInt(Date.now());
  for (let index = 0; index < 6; index++) {
    bytes[index] = Number((millis >> BigInt(8 * (5 - index))) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
