import { BlockList, isIP } from "node:net";

import { Err, Ok, fromThrowable, type Result } from "unthrown";

import { HttpPolicyInvalid, type HttpPolicy } from "./contracts.js";

const parseOrigin = fromThrowable(
  (origin: string) => new URL(origin),
  () => new HttpPolicyInvalid({ field: "privateOrigins" }),
);

/** Compile origin-scoped RFC 1918 and IPv6 unique-local approvals into owned address sets. */
export const privateOrigins = (
  bindings: HttpPolicy["privateOrigins"],
  origins: ReadonlySet<string>,
): Result<ReadonlyMap<string, BlockList>, HttpPolicyInvalid> => {
  const result = new Map<string, BlockList>();
  if (bindings !== undefined && !Array.isArray(bindings))
    return Err(new HttpPolicyInvalid({ field: "privateOrigins" }));
  for (const binding of bindings ?? []) {
    if (binding === null || typeof binding !== "object" || typeof binding.origin !== "string")
      return Err(new HttpPolicyInvalid({ field: "privateOrigins" }));
    const url = parseOrigin(binding.origin).getOrUndefined();
    if (
      url === undefined ||
      url.href !== url.origin + "/" ||
      !origins.has(url.origin) ||
      result.has(url.origin) ||
      !Array.isArray(binding.cidrs) ||
      binding.cidrs.length === 0
    )
      return Err(new HttpPolicyInvalid({ field: "privateOrigins" }));
    const addresses = new BlockList();
    for (const cidr of binding.cidrs) {
      if (typeof cidr !== "string") return Err(new HttpPolicyInvalid({ field: "privateOrigins" }));
      const [address = "", bits, extra] = cidr.split("/");
      const family = isIP(address);
      const prefix = Number(bits);
      if (
        extra !== undefined ||
        bits === undefined ||
        !/^(0|[1-9]\d*)$/.test(bits) ||
        family === 0 ||
        !Number.isInteger(prefix) ||
        prefix > (family === 4 ? 32 : 128) ||
        !privateRange(address, prefix, family)
      )
        return Err(new HttpPolicyInvalid({ field: "privateOrigins" }));
      addresses.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
    }
    result.set(url.origin, addresses);
  }
  return Ok(result);
};

export const privateRange = (address: string, prefix: number, family: number): boolean => {
  if (family === 6) return prefix >= 7 && /^f[cd][\da-f]{2}:/i.test(address);
  const [first, second] = address.split(".").map(Number);
  return (
    (first === 10 && prefix >= 8) ||
    (first === 172 && second! >= 16 && second! <= 31 && prefix >= 12) ||
    (first === 192 && second === 168 && prefix >= 16)
  );
};
