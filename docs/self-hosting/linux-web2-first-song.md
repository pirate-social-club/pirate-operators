# Linux Web2 first-song installation

Source slice based on merged enrollment `0510f779568e1ad27525ae2f40cc390fffe33e16`.
This is an explicit fresh-install profile. Existing HNS create/restore profiles
retain their validators and history. The selected host is Ubuntu 24.04 amd64.
No public deployment, certificates, credentials or funding have been performed.

## Boundary and failure plan

The Wizard owns its hosted-enrollment client, readable controller consent and UI.
It supplies `LinuxWeb2Draft` to `createWeb2Installation(hostInputs)`. Host inputs
come from the installed, authenticated host configuration; browser JSON cannot
select filesystem paths, executables, RPC providers, signer keys or trust roots.
`prepare(draft)` returns a plan ID/digest and public summary; `apply(selection)`
rechecks authority and journals before effects; `status(selection)` observes only.
`close()` detaches setup; it does not delete resources, release unknown custody
or stop a community. The explicit `web2-service.ts` foreground host service owns
the Caddy child independently of setup. Only explicit service shutdown stops its
owned ingress; containers and state remain. This is not a detached daemon or a
systemd installation. Service startup may resume a previously started original
after fresh authority/resource checks; a prepared plan without a start intent
does not authorize starting the community.

Hosted status is a hint identifying the original transaction, not a signed chain
proof. The installer authenticates its exact transaction, accepted Directory V3
source/deployment, receipt, event, safe block and current configuration. Controller,
publisher, installation, community, config URI/digest and HTTPS origin must match.
Registration does not establish DNS/HNS control, verified listing or name issuance.
The first-song profile leaves names, learning, Dance and dependent features off.

Before implementation, these are the observable failures the proof must cover:

- Forged status/receipt, another community's successful transaction, wrong chain,
  wrong source or ABI, wrong installation, changed controller/publisher/origin,
  stale safe state, missing receipt and reorg must refuse before local effects.
- Mutation during awaited verification cannot replace the captured draft or
  original operation. Repeated prepare/apply/restart retains the original plan,
  installation, resource bindings and signed evidence; no adoption of foreign state.
- Corrupt/missing original evidence, changed signed release, revoked/expired host
  authority, mismatched target or unsupported schema cannot initialize or start.
- Failed file/directory sync prevents effects. Lost effects remain uncertain,
  with the original intent retained; no blind recreate or new operation identity.
- Wrong Host/SNI, cross-origin writes, forged forwarding/native-readback headers,
  private operator routes and invalid upstream TLS cannot reach authorized work.
- Actual application sign-in, upload, publication, media ranges and logout must
  work through Caddy. Stop/start must preserve DB, objects, jobs, sessions and the
  publication journal, while using a fresh process boot identity.
- Selected external services work; an unconfigured origin and cross-origin
  redirect remain refused. Provider outage is unavailable, never fabricated success.

## HTTPS and persistence

Caddy is a separately pinned host process. Public TCP 80/443 reaches only Caddy;
the community upstream remains HTTPS on a private loopback port, and the paired
operator Wizard remains loopback-only. Caddy sends the exact configured public
Host, verifies the upstream certificate using a pinned CA and server name, and
does not infer origin from caller-supplied forwarding headers. No on-demand TLS,
wildcard DNS credentials or insecure upstream TLS bypass is introduced.

Caddy's certificate/account storage persists separately from application DB,
objects, jobs, scheduler and configuration roots. Application outbound traffic
uses the existing exact-origin workerd gate; this is not a Docker URL firewall.
Required RPC, IPFS and managed endpoints are explicit installed inputs.
The retained host target digest covers the actual containers, ingress and native
runtime directory. Installation `running` requires a live original Caddy process
and a real application reply through local Caddy TLS, rechecked against current
authority. That observation does not establish external DNS/firewall reachability.

Local acceptance uses real Anvil, native workerd/D1/R2, real Caddy TLS and the
actual browser application. Fixture CA evidence proves local protocol behavior;
public DNS, public ACME issuance and the actual selected host remain separate
acceptance. No backup, restore, upgrade or HNS migration is a first-install gate.

The first two real Caddy cases passed locally: adaptation/validation, exact Host,
private routes, forged-header removal, untrusted upstream rejection, persistent
CA restart and cleanup after a failed startup-journal acknowledgement. Subsequent
source changes require requalification. The two new chain-authority cases and
the installed service/application/browser journey remain UNRUN. The W1 Web2
application profile and consumer are explicit source dependencies; validators
are imported from their owner, never copied into this installer.

Local ingress tests require an explicitly pinned `PIRATE_CADDY_BINARY`,
`PIRATE_CADDY_SHA256` and private `TMPDIR`. Local CI installs Caddy 2.11.9 before
network isolation, checks both the pinned archive SHA-256 and upstream SHA-512,
then checks executable bytes. Fixture TLS sets `skip_install_trust`; no system
certificate store changes or public CA requests are part of these tests.

Primary references checked 2026-11-15:
[Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https),
[upstream TLS and Host](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[internal HTTP/HTTPS ports](https://caddyserver.com/docs/caddyfile/options).
