# V4 testnet rollout

The workspace_owner approved the policy and single sign-in statement on November
10. The approved policy hash is recorded in learning-policy-v4-review.md. This
rollout adds no exercise consent screen and never enables automatic payments.

The maintained Study deployment and activation commands have explicit `/2`
profiles for this rollout. Their default is offline planning. The existing `/1`
profiles still describe the historical V3 rollout. Execution uses the same
controller inventory, exclusive custody, finite window, fee ceilings, signed
transaction journal and canonical readback as V3. No separate transaction runner
is introduced.

The deployment `/2` profile binds revision 5 and the retained V3 code as its
predecessor. Its historical `resultsV2` field names that predecessor; for `/2`
it contains V3, not V2. It compiles LearningResultsV4 and binds the application's
exact origin as the fourth constructor argument. Its five operations deploy
the contract, configure both graders and activate the two unchanged activity
qualification policies. Policy activation must be prospective, so the application
release must wait for their effective daily period.

The activation `/2` profile includes all five published directory manifests,
their hashes, the retained V3 address and code hash, V4 address and code hash,
the origin, policies, deployed release identities and fresh independent readiness.
The only manifest changes are revision 5 to 6 and learningRecords to V4. Owner
publishing, rewards settings, payments and all other manifest values are retained.

The release order is V4 contract and graders/policies, compatible retained speech
operator, community application with migration 0013 and the reviewed V3/V4 rewards
selection, then directory activation. Before activation, verify the real MOSS
signature against the deployed contract and the account's ERC-1271 implementation,
record the normal wallet presentation, and independently review readiness. Old
results, old offers, private histories, resource identities and nonce journals
remain retained. The operator journal must be inspected for unresolved result
transactions before upgrading.

The retained operator currently sponsors activation only for the owner account.
For the distinct pilot learner, the same V4 release may explicitly name a previous
and replacement activation address. The profile and custody hash bind both.
Cloud readback checks each against the exact old or new module before normalizing
that one field for the retained settings invariant. A binding-only change with
identical module bytes is refused. The single-account restriction, sponsorship
ceilings and journals stay in force; no general activation permission or learner
eligibility approval is added. The account holder's next normal MOSS sign-in
supplies the activation proof. Earlier refused sign-ins are retained.

After deployment, attach a new rehearsal offer with a future window. Use the
distinct learner account for a real lesson, verify its public result and private
history, and qualify only from the offer's rules. Complete Very at Claim, one
explicitly signed aggregate payment, canonical reconciliation and learner Send.
Simulated winnings and prefunded test tokens stay explicitly labeled. The owner
performs the passkey, microphone and payment approval actions; agents collect
evidence and maintain the ledger.
