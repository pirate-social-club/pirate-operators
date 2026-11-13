import test from "node:test";
import assert from "node:assert/strict";
import { firstSong } from "../services/first-song-profile.ts";
import { communityId } from "../packages/community/manifest-core.ts";
import { validateCommunityDeploymentProfile, communityIpfsTransport } from "../services/community-deployment-profile.ts";

test("deployment origin accepts a TLD or SLD independently of the registry identity", () => {
  for (const origin of ["https://pirate", "https://app.pirate", "https://other.example"])
    assert.equal(validateCommunityDeploymentProfile({ ...firstSong, origin }).directoryProfile.communityId,
      firstSong.directoryProfile.communityId);
});

test("different community registry and origin produce independent deployment identities", () => {
  const registry = "0x2222222222222222222222222222222222222222" as const;
  const other = validateCommunityDeploymentProfile({ ...firstSong, origin: "https://other.pirate",
    directoryProfile: { ...firstSong.directoryProfile, registry, communityId: communityId(6343, registry) } });
  assert.notEqual(other.origin, firstSong.origin);
  assert.notEqual(other.directoryProfile.communityId, firstSong.directoryProfile.communityId);
});

test("deployment rejects wrong chain, wrong registry identity and malformed state scope", () => {
  for (const patch of [{ chainId: 1 }, { registry: "0x2222222222222222222222222222222222222222" },
    { directoryCodeHash: "0x12" }, { deploymentBlock: "-1" }, { deploymentBlock: "18446744073709551616" }])
    assert.throws(() => validateCommunityDeploymentProfile({ ...firstSong,
      directoryProfile: { ...firstSong.directoryProfile, ...patch } }));
});

test("deployment refuses non-HTTPS origins, credential URLs and unknown fields", () => {
  for (const patch of [{ origin: "http://app.pirate" }, { origin: "https://app.pirate/path" },
    { rpcUrl: "https://operator:password@rpc.example" }, { rpcUrl: "http://chain:8545" },
    { rpcUrl: "http://2130706433:8545" }, { rpcUrl: "https:\\rpc.example" },
    { ipfsGateways: [] }, { ipfsGateways: ["http://object-store:9000"] }, { issuerTld: "pirate" }])
    assert.throws(() => validateCommunityDeploymentProfile({ ...firstSong, ...patch }));
});

test("loopback chain/content endpoints remain explicit server inputs", () => {
  const profile = validateCommunityDeploymentProfile({ ...firstSong,
    rpcUrl: "http://127.0.0.1:8545", ipfsGateways: ["http://127.0.0.1:8080"] });
  assert.equal(profile.rpcUrl, "http://127.0.0.1:8545");
  assert.throws(() => communityIpfsTransport(profile)(new Request("https://unselected.example/ipfs/test")));
});
