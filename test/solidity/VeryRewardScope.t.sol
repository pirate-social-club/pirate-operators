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

    function testBaseSepoliaVector() public pure {
        checkVector(
            Vector({
                chainId: 84532,
                pool: 0x1111111111111111111111111111111111111111,
                drawingId: 7,
                scope: 0xd36ef3fd2bec6daccd48761101319732581ba0c0a4c089d213715fb7665ddc48,
                domainHash: 0xf273e8f95a89b67536de4179b46706e8d9de62822985976abc0b71f5d49e3f87,
                externalNullifier: 1029915917412561647741321628686678282886266634119,
                expectedSignal: 15528079924984600461116204484018431878310994032754333369729387376329019402362,
                rewardNullifier: 0x6721bebf2781d966f5479fef564e7af9c4d39b0d5cdf55c90c5815fdd28ec5dd
            })
        );
    }

    function testOtherDrawingVector() public pure {
        checkVector(
            Vector({
                chainId: 84532,
                pool: 0x1111111111111111111111111111111111111111,
                drawingId: 8,
                scope: 0x2ee5d124248318aef640eac4ec8a9fa1d19d62076ce43719a78d29c05a8ba093,
                domainHash: 0xb8519224810302443bfb275a00ed73f5cb5390866a29fe215adaeee56ff763f3,
                externalNullifier: 5295378164380980842841068246485212168403248115,
                expectedSignal: 3223878683203056288971245209316473171124804967721690581752638335257762418181,
                rewardNullifier: 0xe04bb23f8f2bc7af8626a185e48661895f4bd9098f26fae040a1fd2c92e974fa
            })
        );
    }

    function testOtherPoolVector() public pure {
        checkVector(
            Vector({
                chainId: 84532,
                pool: 0x2222222222222222222222222222222222222222,
                drawingId: 7,
                scope: 0x2d1607d6f5707f0db5e1fe5a6b41e6a817a19e47702a6e8bccbc9382af472d5d,
                domainHash: 0x83f51dee6a6c23ccfd50e76e2097fabcc84caced85c6967fe59873c12f661d44,
                externalNullifier: 186076959502152631179085034419273387786168048964,
                expectedSignal: 17013048388397614370916525406888355816356089167906927662142367128697087759615,
                rewardNullifier: 0x8da54a437ea0bafa932f240ed3c781e7cfa56e666c6d3d846293dacf4ca7eb73
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
