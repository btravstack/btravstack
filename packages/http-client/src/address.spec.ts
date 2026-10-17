import { describe, expect, it } from "vitest";

import { publicAddress } from "./address.js";

describe("public destinations", () => {
  it.each([
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.9",
    "192.0.2.1",
    "192.31.196.1",
    "192.52.193.1",
    "192.88.99.1",
    "192.168.1.1",
    "192.175.48.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::a00:1",
    "64:ff9b:1::1",
    "100::1",
    "100:0:0:1::1",
    "2001::1",
    "2001:1::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "3fff::1",
    "2620:4f:8000::1",
    "5f00::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:1000::1",
    "2001:c000::1",
    "2003:4000::1",
    "2004::1",
    "2420::1",
    "2612::1",
    "2d00::1",
    "3ffe::1",
    "invalid",
  ])("refuses reserved destination %s", (address) => {
    // GIVEN
    // WHEN
    const allowed = publicAddress(address);
    // THEN
    expect(allowed).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "accepts public destination %s",
    (address) => {
      // GIVEN
      // WHEN
      const allowed = publicAddress(address);
      // THEN
      expect(allowed).toBe(true);
    },
  );
});
