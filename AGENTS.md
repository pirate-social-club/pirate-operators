# Operators experiment

This is a standalone, public, local-first experiment. The workspace_owner
confirmed D1 through D6 and authorized public repository creation on 2026-11-03.
The initial coordinator bootstrap publishes main after local checks. Later
changes use named branches and pull requests under the workspace lifecycle.

Use cf for Cloudflare tooling. Do not introduce Wrangler configuration.
No production deployment, provider credentials, funded operations or mainnet
activity belongs to the local skeleton. Fixture private keys are public test
keys and must never be funded outside a disposable local chain.

Our contracts target MegaETH testnet (chain 6343) only, with Anvil as the
local chain. Public testnet work needs its own authorization, dedicated random
keys stored privately outside the repository and test tokens only. Refuse
mainnet chain IDs and the public local fixture keys. Public-chain scripts are
manual opt-in and never run in default CI. Nothing here authorizes production,
mainnet funds, existing managed-key exports or real provider credentials.

Keep provider simulations explicit and run the actual handlers, cryptography,
WebSockets, storage and pool locally. The local protocol subset must be named;
do not claim full revision 5 or M1 conformance from the skeleton.

Never write personal names. Preserve copied source provenance. Keep each
operational script under 400 lines where practical. Run npm run check before
publication; record any incomplete checks and remaining acceptance work.
