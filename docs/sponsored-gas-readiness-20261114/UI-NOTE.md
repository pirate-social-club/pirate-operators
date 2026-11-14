# Proposed wizard and usage experience

No wizard source is changed or admitted by this packet.

During setup show: **Transaction fees — covered by Pirate for approved community actions.** Show status as pending review, active or paused from Pirate's authoritative admission record. Do not show active sponsorship before the service is provisioned and qualified. No wallet funding, crypto purchase, merchant-key entry or invented “N transactions/month.”

An operator connects/authorizes their normal account for community administration; this is distinct from operating a gas wallet. A concise explanation names eligible actions and states that unrelated wallet transfers and arbitrary contracts are not sponsored. Eligibility is not blanket sponsorship of every wallet across every community.

After activation, a usage panel shows measured native gas cost, transaction counts, pending reserved fees, last reconciliation and pauses. Display a financial ceiling only after it has been explicitly configured; distinguish that ceiling from account balance and from any future subscription allowance. Alert the operator when an action is paused; alert Pirate privately for low operational balance, unknown receipt, invalid authority, restoration fence or global exhaustion.

A pause control stops new sponsored requests for that community. Previously signed authorizations may still execute; do not promise retroactive cancellation. Administrative overrides and treasury top-ups are Pirate operations outside the wizard. Cold root never connects to an operator's deployed Worker.

On unavailable sponsorship, preserve the original operation and show its status. Do not silently switch to a paid purchase, request unlimited token approval, reissue a name claim or open a new transaction nonce. A later self-pay route would be an explicit separate product decision.

Optional renewal sponsorship is holder/name/window limited by Pirate policy without changing the permissionless renewal contract. Select exactly one route per renewal operation; candidate MOSS holder-originated renewal is the initial design to qualify. Until qualified, renewal sponsorship remains unavailable, not duplicated through a backend fallback.

## Optional username prerequisite for selected features

A community may propose an app flow of browse/connect -> claim a community username -> unlock selected participation features. This is separate from pilot gas admission and the contract's own permissions. No particular feature list is adopted by this document.

Define the check precisely: the authenticated wallet currently holds an eligible active name in this community's admitted namespace, with canonical registry/source, generation and the product's explicit community attribution verified. Namespace equality alone is insufficient when several communities share a namespace. A display string, historical claim or name in an unrelated namespace is insufficient. Enforce it in the API as well as the UI; the contracts do not universally require usernames. Do not silently substitute manager/operator approval for ownership if the product rule is specifically holder-based.

Initial name claims must work before a username exists. Browse, authentication and original-operation recovery must remain accessible. Renewal or remediation must not be circularly blocked by the expiry it is meant to repair. Learning publication consent, controller permissions, exact call validation and Pirate fee/rate caps remain separate checks.

Before enabling an ongoing ownership gate, specify transfer, expiry/grace and temporary authority-unavailability behavior. Transfer may remove the sender's eligibility and give the recipient ownership, but does not automatically admit the recipient for pilot sponsorship. Refuse an unverifiable new gated action without deleting prior posts, results or transaction history. This proposal does not choose a production transfer/membership policy or make every feature depend on a name.

## Several names in one wallet

Do not make a username a one-to-one account identifier. One wallet may hold multiple names, including a free claim and another name acquired later. Store an optional primary display-name selection separately from the wallet/account and from authorization. If a selected-feature name gate is enabled, test whether ANY currently held name satisfies that feature's exact community/name policy, rather than demanding one particular original free name.

Changing the display name must not replace the account, discard learning/post history, or grant another gas allowance. Admission, per-wallet rate limits and community/global fee ceilings are independent of how many names the wallet holds. Validate each requested name action against its exact token/generation. Owning more names does not multiply the first-free-name entitlement; that issuance policy still needs explicit issuer enforcement.

The accepted registry permits multiple distinct NFTs per wallet and has namespace/community issuance caps, not a one-name-per-wallet rule. Its initial issuance entry point is free-only. A paid initial purchase is deferred and must not be shown as available merely because multiple ownership works. A later purchase/transfer can leave the original name intact; automatic replacement, sale or burning is not part of this proposal.
