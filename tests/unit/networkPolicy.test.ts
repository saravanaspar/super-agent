import { describe, expect, it } from "vitest";
import {
  resolveHttpUrlForNetworkAccess,
  validateHttpUrlForNetworkAccess
} from "@security/networkPolicy";

describe("network policy", () => {
  it("blocks direct loopback and private IP URLs by default", async () => {
    await expect(
      validateHttpUrlForNetworkAccess("http://127.0.0.1:3000")
    ).rejects.toThrow(/Blocked local IP address/);

    await expect(
      validateHttpUrlForNetworkAccess("http://10.0.0.10")
    ).rejects.toThrow(/Blocked private or reserved IP address/);
  });

  it("returns a resolved address for direct public IP URLs", async () => {
    const resolved = await resolveHttpUrlForNetworkAccess(
      "https://93.184.216.34/path"
    );

    expect(resolved.url.href).toBe("https://93.184.216.34/path");
    expect(resolved.address).toBe("93.184.216.34");
    expect(resolved.family).toBe(4);
  });
});
