# Contract source boundaries

The [boundary index](../docs/contracts/README.md) owns the contract inventory,
authority split, storage and indexing design, and implementation order.

`interfaces/community/` contains proposed, compilable V1 directory and post
interfaces. They have no runtime implementation, deployment, access-control
enforcement or completed acceptance. Compilation is ABI validation only.

`RewardPool.sol`, `interfaces/IMegapot.sol` and `test/Providers.sol` remain the
existing local reward experiment. The separate segment-payments branch owns
`OperatorPayments.sol`. Nothing is relocated while those lanes are active.
Naming contracts remain independently owned by `pirate-registry`.

Future implementations can live under `contracts/community/`, with their
behavior tests under `test/solidity/`. Payment and reward sources keep their
current paths until their active branches land. A folder is not evidence that
its contract or product flow is implemented.
