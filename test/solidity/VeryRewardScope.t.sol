// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

// Frozen synthetic values from fixtures/very-reward-scope-v1.json.
// Generated with cast ABI/Keccak and Python SHA-256, not the TypeScript helper.
contract VeryRewardScopeTest {
    uint256 constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct Vector {
        uint256 chainId;
        address pool;
        uint256 drawingId;
        bytes32 scope;
        bytes32 domainHash;
        uint160 externalNullifier;
        uint256 expectedSignal;
        bytes32 rewardNullifier;
    }

    function checkVector(Vector memory v) internal pure {
        bytes32 scope = keccak256(abi.encode("pirate-pool-registration/1", v.chainId, v.pool, v.drawingId));
        require(scope == v.scope, "pool scope");
        bytes32 domainHash = keccak256(abi.encode("pirate-very-external-nullifier/1", scope));
        require(domainHash == v.domainHash, "domain hash");
        uint160 externalNullifier = uint160(uint256(domainHash));
        require(externalNullifier == v.externalNullifier, "numeric scope");
        require(uint256(sha256(bytes(decimal(externalNullifier)))) % R == v.expectedSignal, "scope signal");
        bytes32 nullifier = keccak256(abi.encode("pirate-very-reward-nullifier/1", scope, uint256(12345)));
        require(nullifier == v.rewardNullifier, "reward nullifier");
    }

    function decimal(uint256 value) internal pure returns (string memory) {
        uint256 copy = value;
        uint256 length;
        do {
            ++length;
            copy /= 10;
        } while (copy != 0);
        bytes memory output = new bytes(length);
        do {
            output[--length] = bytes1(uint8(48 + value % 10));
            value /= 10;
        } while (length != 0);
        return string(output);
    }

    function testMegaethTestnetVector() public pure {
        checkVector(
            Vector({
                chainId: 6343,
                pool: 0x1111111111111111111111111111111111111111,
                drawingId: 7,
                scope: 0x66f646bf167eab5e7b53616c1d0ac3d347d1e7938c832f22ee11a19b0591534e,
                domainHash: 0x1087d563efc52be5686d591cdf87ed56766960b3d24dfe35ed4ee583ace97ed7,
                externalNullifier: 1276136217528963286438276924773934326101872049879,
                expectedSignal: 9987988031917035604339859757035284859828123499243339578990325130716592220601,
                rewardNullifier: 0x833a95afe23dcced72932062b125af61e6462390c3004962e74a1cbd3edd7bf8
            })
        );
    }

    function testOtherDrawingVector() public pure {
        checkVector(
            Vector({
                chainId: 6343,
                pool: 0x1111111111111111111111111111111111111111,
                drawingId: 8,
                scope: 0x65657e501d857be9061ef86d6196b4549f23b7e0d7a3197ae961f695b870e106,
                domainHash: 0x3212c35fbdaff950db2cd4130c511464452618a5645b48a6c1fa39ab7401ea53,
                externalNullifier: 70316025976836920935361076021307070126720412243,
                expectedSignal: 6500218037171198286818052551046358367240603005885307789930463912832643428962,
                rewardNullifier: 0x8c481a559ea8352355b1c9e77db9f197fcaeef5e90100437de9d67f7602e5297
            })
        );
    }

    function testOtherPoolVector() public pure {
        checkVector(
            Vector({
                chainId: 6343,
                pool: 0x2222222222222222222222222222222222222222,
                drawingId: 7,
                scope: 0xd17b14d70e49241407b11997669bc5fa395581bf7fbdf874ac49a4b24b9a6dfb,
                domainHash: 0x12ab0e82db9b0c77dda839de64eef2e553904137a0ad9c02e616da0fbe42e211,
                externalNullifier: 576227813648566688767274195578646617556229743121,
                expectedSignal: 3356580098072245178689534558110363741873369180700218450587025690282305927858,
                rewardNullifier: 0xdee44275ddde6ea12795b2d6f9df1d04126bbf8285e364e30ea54a302ed0c098
            })
        );
    }

    function testOtherChainVector() public pure {
        checkVector(
            Vector({
                chainId: 31337,
                pool: 0x1111111111111111111111111111111111111111,
                drawingId: 7,
                scope: 0x9f1bbce30a0e451ad6151b810541d144f4d05000e0d3b40c46c1dd0ce6a074db,
                domainHash: 0x8e5a38189ad4a257c548ed8e522a7ac99c369ba401eccb7b6d9093a12df8a1f0,
                externalNullifier: 469084570809175661158095070034613577683111027184,
                expectedSignal: 12758209348851740108660650100441688623966131340440020774005903594036663129726,
                rewardNullifier: 0xd82b84e0830972cac63fd2e71dcbc3b49ee4624982f7d02e10940a2378f5f3e3
            })
        );
    }
}
