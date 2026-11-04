# Operators experiment

This is a standalone, public, local-first experiment. The workspace_owner
confirmed D1 through D6 and authorized public repository creation on 2026-11-03.
The initial coordinator bootstrap publishes main after local checks. Later
changes use named branches and pull requests under the workspace lifecycle.

Use cf for Cloudflare tooling. Do not introduce Wrangler configuration.
No production deployment, provider credentials, funded operations or mainnet
activity belongs to the local skeleton. Fixture private keys are public test
keys and must never be funded outside a disposable local chain.

The current application-contract target is MegaETH testnet 6343; local tests
use anvil. Use dedicated test keys only under an explicitly admitted testnet
task. No new Pirate contract deployment belongs on another EVM application
chain. External Megapot's Base deployment is a provider dependency, not our
deployment target. Local fork inspection remains distinct from public writes.
The creator-wallet design has its own Sui/Ika and Aeneid testnet scope; this
instruction does not authorize that integration, new credentials or transactions.
Mainnet activity and managed production-key exports remain excluded.

Keep provider simulations explicit and run the actual handlers, cryptography,
WebSockets, storage and pool locally. The local protocol subset must be named;
do not claim full revision 5 or M1 conformance from the skeleton.

Never write personal names. Preserve copied source provenance. Keep each
operational script under 400 lines where practical. Run npm run check before
publication; record any incomplete checks and remaining acceptance work.
