# Bounded MOSS activation proof

The consent captured on November 4 verified through the MegaETH RPC. The
local fork rehearsal activated the account and opened its LearningRecords
attempt with the inner passkey signature. That is fork evidence, not a live
activation. The owner must explicitly approve the real-account change after
review of the prepared source. Local regression tests need no owner signature.

The manual command is `npm run megaeth:moss-activation`. Without `--send`, it
makes only read-only network calls and prints the remaining stages. It creates
or opens its private local journal but does not read the operator key. The
owner-approved send command would be
`npm run megaeth:moss-activation -- --send`. Do not run that command merely
because local tests passed.

The command pins chain 6343, the captured learner and attempt, LearningRecords,
MOSS's delegate and initializer. It refuses a different network or input
identity. The chain-0 authorization is not limited to testnet: broadcasting it
on testnet makes it available for replay elsewhere when its nonce and chain
conditions allow. The underlying full signature and signed activation
transaction therefore stay in private state; public evidence contains hashes
and public transaction references only.

## Durable state and recovery

The SQLite journal is outside the repository, at
`~/.local/state/pirate-operators-moss-consent/activation/<attemptId>.sqlite`.
Its directory is mode 0700 and its files are mode 0600. It contains signed
transactions and must be handled like the captured authorization, never
uploaded with public evidence. A separate `.lock` SQLite database serializes
invocations and releases its operating-system lock when a process dies. Keep
the Node 24 runtime required by the repository.

Only this command may use the dedicated operator account while the proof is
running. The journal lock protects concurrent command invocations; it cannot
coordinate a different service independently using that account's nonce.

Run the identical command again after a crash or unknown RPC outcome. The
sender saved its intent, nonce, fee bounds and signed bytes before broadcast.
It queries receipts and rebroadcasts those same bytes rather than assigning a
new transaction. An already opened attempt is checked against every immutable
consent field and reported complete without sending again.

An activated account does not need empty code or its original authorization
nonce on restart. It must have the expected delegation and accept the consent
through ERC-1271. If delegation remains after a reverted setup, the command can
send the initializer once without replaying the authorization. A temporary RPC
failure stops the invocation for retry; it is never treated as proof of failed
setup. Private errors stay in the journal because SDK diagnostics can contain
authorization material.

Preserve the journal on failure. Do not delete it, edit its rows or substitute
a fresh journal to bypass a failed transaction or spending bound. Back up only
when the runner is stopped; copy the whole private activation directory and
restore it with the same permissions and one writer. A budget, signature,
contract or profile change requires a new reviewed plan, not an automatic
journal reset.

## Enforced maximum

The prepared profile permits at most these three transaction intents, across
all restarts:

| Stage                                       | Gas limit |
| ------------------------------------------- | --------: |
| Activate, including the setup call          |   300,000 |
| Repeat setup, only after an account refusal |   300,000 |
| Open the one consented attempt              |   400,000 |

Every transaction is limited to 1,000,000 wei per gas (0.001 gwei), and the
cumulative maximum is 1,000,000,000,000 wei, or 0.000001 test ETH. The sender
reserves each transaction's entire gas limit times its maximum fee, including
reverted or unresolved transactions. A higher observed gas price or an
allocation exceeding the remaining bound is refused before signing. Unused
reserved gas is deliberately not recycled into extra transactions.

These limits provide headroom over the recorded successful fork activation
(182,952 gas) and opening (260,823 gas). Current simulation must still pass
within the limits. A simulation failure or changing gas price does not permit
raising them silently. The original sub-0.000001 figure was an estimate; this
profile makes 0.000001 test ETH a hard maximum, excluding earlier experiments.

## Tests and remaining acceptance

The actual operator handlers are tested for temporary verification RPC errors,
activation followed by interruption, failed initialization and refusal. The
manual runner uses the same transaction sender, exercised with a real local
SQLite journal and Anvil. Tests kill a journal-owning process, hide mined
receipts, restart after a reverted activation, rerun after opening and reject
fee or profile changes. None uses the captured private consent or real keys.

The real-account activation, opening, passkey verification and exact public
receipt reads remain pending owner approval and live execution. Full audio
upload, microphone transcription and stable post identity remain their
separate integration work.
