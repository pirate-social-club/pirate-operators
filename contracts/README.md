# Contract source boundaries

The [boundary index](../docs/contracts/README.md) owns the contract inventory,
authority split, storage and indexing design, and implementation order.

`interfaces/community/` defines the V1 directory and post interfaces.
`community/CommunityDirectoryV1.sol` and `community/CommunityPostsV1.sol`
implement them locally. Their authorization, revision and event tests live in
`test/solidity/community/`. The [implementation profile](../docs/contracts/community-implementation.md)
records constructor inputs and remaining deployment/service acceptance. No
public-chain deployment or real first-song acceptance is claimed.

`RewardPool.sol`, `interfaces/IMegapot.sol` and `test/Providers.sol` remain the
existing local reward experiment. The separate segment-payments branch owns
`OperatorPayments.sol`. Nothing is relocated while those lanes are active.
Naming contracts remain independently owned by `pirate-registry`.

The shared reference validator is `community/PublicationReference.sol`.
Payment and reward sources keep their
current paths until their active branches land. A folder is not evidence that
its contract or product flow is implemented.
