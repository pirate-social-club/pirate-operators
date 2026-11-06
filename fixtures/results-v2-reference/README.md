# Public evidence input

public-before-policy.json.gz contains a read-only MegaETH testnet capture made
by harness/reference-results-v2.ts on 2026-11-06. It contains raw logs, receipts,
block metadata, contract code/views and referenced public IPFS document bytes.
It contains no private community API response, transcript or learner recording.
The existing public terminal publication has 23 outcomes and predates its first
qualification policy. It earns no qualifying day.

The uncompressed SHA-256 is
e20a4d26c3523784cec8b42ee5e66ee29f76cc13023544075cd934079943921f.
Recompute it by hashing the gzip-decoded bytes. The capture's block hash and
evaluation timestamp are embedded in the raw JSON. Replaying it starts both
readers with the same raw evidence, rather than sharing normalized result rows.

The test factory replaces learner grants and performance events with explicitly
synthetic offline traces. Those fixtures test corrections, policies, failure
statuses, clocks, eligibility and chain replacement. They are not honest learner
performances, funded transactions or live post-policy qualification evidence.
