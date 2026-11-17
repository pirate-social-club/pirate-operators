# Sponsored gas readiness review — 2026-11-14

This is a public, documentation-only snapshot of the Pirate-paid gas pilot proposal. It is not a sponsorship service implementation, deployment, wallet setup or funded trial.

## Review order

1. [Architecture](ARCHITECTURE.md)
2. [Proposed types](interfaces/sponsorship-proposal.ts) and [84 planned cases](gate-plan.json)
3. [Readiness and custody](READINESS.md)
4. [Rehearsal](REHEARSAL.md) and [cost accounting](COSTS.md)
5. [Wizard experience](UI-NOTE.md) and [indexing](INDEXING.md)
6. [Successor specification proposal 0.1](SUCCESSOR-SPEC.md)
7. [Reviewer dispositions](REVIEW-DISPOSITIONS.md) and [primary sources](official-sources.json)

All 84 cases are **UNRUN plans**, not executable tests or passing results. The TypeScript file is an uncompiled interface sketch under documentation, outside the repository's application TypeScript includes.

Focus the review on the pre-deployment attester successor decision and refresh revisions; manual same-nonce recovery preserving the original, with group-max liability and protected Pirate recovery headroom; optional username/multiple-name behavior without new membership infrastructure; atomic global/community fee reservations; durable original-operation and rollback recovery; manual pilot admission plus existing action-specific authorization; separate issuer/submitter/payer keys; and actual MOSS nested consent from initialized AND fresh accounts, including safe mint, sender and payer debit.

The registry source boundary is [56d63ad](https://github.com/pirate-social-club/pirate-registry/commit/56d63ad2738e0e6816b6157dba7174198700f2fa), with [bf480445](https://github.com/pirate-social-club/pirate-registry/commit/bf480445c88030910501923ac12350b2fe1d7e6e) documentation. Its 119-entry ABI digest is e580c03988a02a6ecd1d414c7a3e0ac0e306c823e07b0f9a9078b30a06c3a802. Existing isolated local-chain acceptance does not establish public testnet or service integration.

At preparation time the public Directory caller checkpoint remained [af70dc7](https://github.com/pirate-social-club/pirate-operators/commit/af70dc7e744c2f4b4886802e4b78125d3eb79444). Its corrected successor was local and still undergoing separate gates. This branch does not publish or adopt that successor.

## Scope and provenance

The branch starts from public main c9a969ce02f2af1cc0b76d9b305ecbaedab59f63 and adds only this directory. No contract, ABI, runtime caller, dependency, workflow, deployment, account or fee policy changes.

The original sealed readiness packet remains unchanged. Original manifest SHA-256: e6d2f2b1aa3dd3debef77e28ad5b6b5caae722296daea7eb9bd8b6980d4b71c0. Original seal SHA-256: b070c2a5a2f0e1a41e96e4f3ddec42157113f909c544b624c1db18d7abc4fc29.

[Public provenance](PUBLIC-PROVENANCE.json) maps this revision to the exact public parent bc39fdd15290677261e99b9abad92d42e6d2c799 and records each changed file. Its provenance chain retains the original sealed-to-public redaction mapping. Machine paths, turn/sandbox records, device inventories, local task records and role-address inventory are deliberately omitted. Public-copy edits remove private custody/history and internal evidence assertions, expand checkpoint/coordinator shorthand and pin source links. The follow-up changes design proposals and case coverage, not implementation evidence. No service, contract, policy or deployment is activated by publication.

No local npm check, compiler, formatter, runtime test, MOSS interaction, provider call, signing or funded action was executed for this documentation publication. Repository CI remains unchanged; any automatic run is separate evidence and is not reported as passed here. Merge and deployment remain outside this review publication.

The owner's updated workflow permits agents to commit/push assigned isolated branches and publish sanitized review documents. Integration merges, shared-interface coordination and competing heavy-runtime allocation stay coordinated; key, signing and funded actions need their own authorization.

The successor proposal is not implementation-complete: exact module/quote/export wire interfaces and commercial inputs are explicitly open. Fixed-price settlement, uniform recipient consent and holder-initiated export are review proposals. Current registry/Directory bytes and the main rollout do not change through this document.
