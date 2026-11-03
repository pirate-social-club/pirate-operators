# Two-network acceptance spike

The manual testnet harness runs the same business flow as offline acceptance.
Community sessions, signed admission evidence, karaoke tickets, WebSocket
scoring and reward qualification still run locally in the Workers runtime.
A Node payment gateway uses the operator's role and mppx 0.17.0 to accept real
Tempo v2 MPP sessions. The payer Worker calls that gateway through its payment
provider binding. This gateway is a test adapter, not an additional production
identity or evidence that a Cloudflare MPP deployment is ready.

MPP payments use Moderato (42431) and pathUSD. The pool, test token and mock
Jackpot execute transactions on Base Sepolia (84532). Identification, Very and
the Jackpot outcome remain simulated. The token is a freshly deployed test
ERC-20, not Circle USDC. The bridge is not exercised. No mainnet transaction,
real provider credential or real-person uniqueness proof belongs to this run.

## Prepare and run

After npm ci and the ordinary local bootstrap, run:

```sh
npm run testnet:prepare
npm run testnet:tempo
npm run testnet:e2e
```

Prepare creates nine dedicated random keys in a private user configuration
store outside the repository, prints only public addresses, checks both chain
IDs and requests Moderato faucet tokens when needed. It prints the Base
sponsor address and balance; that address needs Base Sepolia faucet ETH.
The observed run used 0.01 test ETH. Public fixture keys are refused. Mainnet
chain IDs are refused. Testnet scripts are never called by default CI.

The full run tops up the verifier, executor and three participant wallets with
small amounts of test ETH so ordinary signed transactions can be tested. Gas
sponsorship, relayed registration and automatic payouts are separate choices.
There is no basis here for a fixed dollar gas quote. Receipts include execution
gas and available L1 fee fields. The harness stops on an observed execution-fee
threshold; that is not a production spending policy or a total-fee estimate.

The payment adapter charges 0.002 test pathUSD for each two-unit evaluation:
one admission and three karaoke attempts cost 0.008 in total. It suggests a
0.01 channel deposit and caps the manager at 0.05. Duplicate calls in the same
run use a persisted job response. Server channel state and client hints use
separate prefixes in an atomic private SQLite store; a process lease prevents
concurrent runs sharing these wallets. This does not prove the complete M2
failure/restart matrix or atomic application idempotency across every crash
window. Treat a failed public run as requiring receipt reconciliation rather
than blindly retrying an unknown payment.

Base timestamps cannot be fast-forwarded. The demo uses a two-minute entry
cutoff and a 30-second registration window and waits for actual chain time.
Those durations are for this fixture, not a community policy recommendation.
The normal offline flow retains its injected clock and deterministic trace.
The public-chain harness has no general due-alarm drain implementation yet.

The run saves public receipt metadata under .local/testnet. The private key
and SDK stores remain outside the checkout and must not be copied into a
report, workflow or deployment. A Base-only run is also available:

```sh
npm run testnet:base
```

That uses simulated operator payments. A Tempo-only run makes two distinct
paid calls plus an idempotent repeat and closes the shared channel. The combined
run performs the complete sign-in-to-withdrawal scenario with both networks.
These are integration spikes before full M1; they do not mark M1, M2 or M3
complete. Off-Tempo passkeys, real Very delivery, real Megapot compatibility,
channel headroom billing, credit limits and the complete fault matrix remain
unverified.

## Inspect the observed run

The [receipt bundle](evidence/moderato-base-sepolia-2026-11-03.json) records a
successful combined run during adapter implementation. The accompanying
manifest identifies expected actors and the raw trace digest. It is an
observation, not a deployed-source attestation. No private keys are included.

Read-only verification needs no key store or wallet funding:

```sh
npm run testnet:verify -- docs/evidence/moderato-base-sepolia-2026-11-03.json
```

It checks contract code hashes and balances at the recorded terminal Base
block, three payouts of 3,333,333 test-token units, two units of sponsor dust,
an empty fixture pool, and the actual Moderato reserve transfers: 8,000
pathUSD atomic units to the expected operator and 2,000 unused units back to
the payer. It uses historical RPC state; provider archive availability remains
a dependency of later verification.

Funding documentation:
[Tempo faucet](https://tempo.xyz/developers/docs/quickstart/faucet),
[Tempo funding paths](https://tempo.xyz/developers/docs/guide/getting-funds),
[Base testnet funds](https://docs.base.org/get-started/get-funds).
The Tempo guide separates mainnet wallet funding from Moderato test tokens.
No supported Base Sepolia-to-Moderato bridge route has been established here.
The two networks were funded independently.
