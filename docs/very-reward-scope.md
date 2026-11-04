# Very reward scope protocol, version 1

This specification fixes the encodings the future Very reward attester must
use. It does not implement that attester or change RewardPool. The current
harness still uses the fake credential. The live probe established behavior
for one enrollment with diagnostic scopes and challenge bindings; it did not
authenticate real wallets or prove one enrollment per human.

This supersedes the original experiment draft's section 12.2 where it treated
the contract scope and Very's external nullifier as the same representation,
and prescribed a literal wallet address as the pseudonym. The contract's full
bytes32 scope remains unchanged. The tested 128-bit challenge mechanism needs
an authenticated claimant association in the real attester.

## Exact encodings

All domain strings below are their exact UTF-8 bytes. `abi.encode` is standard
Solidity ABI encoding, not packed encoding or JSON. Integers are unsigned,
big-endian values in their ABI words. Pool addresses are 20-byte values, so
letter case does not change a result. Chain ID is positive; drawing ID may be
zero; both fit uint256. The pool address must be nonzero.

First recompute the existing RewardPool scope:

```text
S = keccak256(abi.encode(
  string("pirate-pool-registration/1"),
  uint256(chainId), address(pool), uint256(drawingId)
))
```

Then derive the numeric scope sent as `options.externalNullifier`:

```text
H = keccak256(abi.encode(string("pirate-very-external-nullifier/1"), bytes32(S)))
E = uint160(uint256(H))
externalNullifier = base10(E)
```

The cast retains the low 160 bits. Reject the zero result; do not substitute a
default or retry another domain. Decimal encoding has no leading zeros, sign,
spaces or exponent. The 160-bit width follows the numeric purpose format used
by the earlier adapter. Acceptance of these newly derived values by Very is
still a live integration check; the four-request probe used smaller constants.
This is a hash mapping, not an injective conversion: generic collision
resistance is at most 80 bits after truncation. It does not prove anonymity.

For the observed proof format, public signal 3 must equal:

```text
expectedScopeSignal = uint256(SHA256(UTF8(externalNullifier))) mod r
r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
```

Hash the canonical decimal text, not the bytes of H, S or a uint160 ABI word.
The existing probe checks this transform. No alternate transform is attempted
if it disagrees with a returned proof.

After the proof passes every required field check and the hosted verifier,
let N be its nonzero public signal 2, parsed as a canonical decimal integer
strictly below r. The contract-facing nullifier is:

```text
R = keccak256(abi.encode(
  string("pirate-very-reward-nullifier/1"), bytes32(S), uint256(N)
))
```

R is the bytes32 `nullifier` in RewardAttestation and Registration. Neither
wallet, recipient, attempt, challenge, app ID nor attester key is an input to
S, E or R. Fresh challenges therefore do not create fresh reward identities.
The pure hash helper does not verify a proof or authorize a registration.

One pool must accept only this one mapping version for its lifetime. A future
incompatible mapping requires a new pool and a new disclosed policy; accepting
both versions in an existing pool could bypass duplicate prevention. Key
rotation must not alter the mapping. The fake adapter's fixture-subject hash
is not a second accepted real-credential format.

## Attester requirements

The attester selects a configured chain and pool, confirms the RPC chain ID,
reads the deployed pool's drawing ID and scope, and recomputes S from those
values. Reject any mismatch or unrecognized pool configuration. Do not accept
a client-supplied scope or let a client select the mapping version. Checking
the scope alone does not establish that an arbitrary contract is a trusted pool.

Authenticate the claimant with the supported wallet signature, then issue a
fresh random 128-bit pseudonym. Persist its one-use association with the
claimant, S, E, complete query, expiry and issuance policy. Verify the exact
returned pseudonym and scope signal, plus the other required proof fields,
before treating N as a verified subject. Checking a new challenge establishes
request binding, not a new palm capture. An independently authenticated
claimant is still necessary; an arbitrary browser field is not authentication.

The existing EIP-712 domain remains `Pirate Reward Pool`, version `1`, chain ID
and pool address. Sign the full S, R, authenticated claimant and expiry in
RewardAttestation. The claimant's separate Registration authorization fixes
the recipient and attempt as well. Expiry must not exceed the accepted
challenge, credential/policy limit or pool registration deadline. The pool
cannot tell whether the attester actually called Very; this remains a trusted
attestation design. Ordinary ECDSA and the supported EIP-7702 case remain the
wallet boundary; this work adds no ERC-1271 compatibility.

## Frozen vectors and conformance

`fixtures/very-reward-scope-v1.json` contains synthetic, unfunded test inputs
and expected outputs. No value is a real credential or pool deployment. The
outputs were generated independently with Foundry cast 1.9.0 ABI encoding and
Keccak, and Python's SHA-256, before invoking the TypeScript implementation.
TypeScript tests read the frozen JSON; Solidity tests carry the same frozen
values and use Solidity ABI encoding, Keccak and SHA-256 independently. Tests
also vary each context field, check input bounds and reject noncanonical text.
The headless flow compares S computed by TypeScript with the actual deployed
RewardPool's `scope()` before requesting its simulated attestation.

These checks prove deterministic agreement in the experiment. They do not
establish provider support for the derived values, freshness, enrollment
deduplication or completed production reward registration.
