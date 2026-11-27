# Open onboarding interface v1

Lane 6 owns this proposal against source 67cbe118ade39790bc1539999ca75d0d7ff10b6d.
Shared mounts, runtime environment declarations, Alchemy bindings and release
profiles remain coordinator-owned. This source work activates no deployment.

`acceptAuthorization` retains its V4 request and receipt. First-use ERC-8010
activation no longer depends on a manually approved address. Explicit positive
`ACTIVATION_TOTAL_CAP_WEI`, `ACTIVATION_ACCOUNT_CAP_WEI` and
`ACTIVATION_MAX_ACCOUNTS` admit a bounded cohort. Each account reserves both
activation and authorization transaction maxima atomically, within the existing
lifetime `SPONSOR_*` budget. One first-use slot per account binds the original
authorization digest. Unknown outcomes, reverts, process restarts and new
sign-ins never replenish the slot or budget. Exact retries reuse the journal.
No configuration means no sponsored activation. These are gas-cost ceilings,
not token funding or a guarantee of Sybil resistance.

`practiceAuthorization(env, db, accountId, subject, atS, now)` remains the
website and connected-learning admission API. A selected authorization must
still belong to that account and wallet, predate the activity, and survive a
fresh operator authorization read and a second local withdrawal fence. A slow,
malformed or unavailable operator yields a retryable pending answer, never
permission from a cached sign-in. A chain withdrawal refuses stale work.
Publication and economic eligibility continue to require the contract's own
authorization rules; application checks cannot replace them. Telegram must
resolve its verified link to this same account and wallet before calling this
API. Trial history is never supplied as connected/rewarded history.

Community setup v1 describes one HTTPS community in its own Cloudflare account,
with separate community and speech/grader Workers in that account, its own
Infisical project/environment/folder, managed ElevenLabs key, optional bot token,
grader identity, contract permissions, songs and explicit spending/speech caps.
Platform login credentials remain separate from community bot credentials.
Plans are deterministic and contain secret references only. The setup runner
prepares a review package; Alchemy owns actual resource reconciliation. No
Spaces provisioning, production activation or credentials in chat is admitted.

Integration dependencies: lane 5 supplies its versioned speech reservation
interface and per-channel reservation semantics; Telegram owns link issuance,
bot generation and unlinking; coordinator mounts setup routes/components and
assigns bindings. Existing contract authorization/publication fences stay in
force without a contract migration. Real unallowlisted MOSS sign-in and a second
community are release acceptance, not established by local fixture tests.

The additive linked-learning entry is `connectedPracticeAuthorization`; its
resolver returns `ConnectedLearningLinkV1` and must authenticate the current
Telegram link. `LEARNING_AUTHORITY_INTERFACE` exports
`pirate.learning-authorization/1`. Fresh-community binding generation lives in
`packages/community-setup/bindings.ts`. Its proposed
`pirate-community-learning-v4` runtime profile admits V4 without inventing V2/V3
history. Existing runtime admission currently requires historical addresses;
the coordinator must adopt the supplied profile patch and Alchemy recipe before
releasing a genuinely fresh community. Legacy profiles retain their old gates.
