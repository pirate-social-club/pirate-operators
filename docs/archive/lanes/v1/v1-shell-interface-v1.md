# Community shell interface v1

Lane 1 owns the live entry, navigation and global layout at release base
`67cbe118ade39790bc1539999ca75d0d7ff10b6d`. Feature components remain independently
owned. This document and `apps/web/src/shell/interfaces.ts` define version 1.

The shell uses native `/#/`, `/#/songs`, `/#/account` and `/#/publish` links.
They require no new Worker routes. Existing `/wallet`, `/verify/very` and
`/operator/rewards` routes retain their existing components. `/operator`
remains the independent operator application. An unknown fragment gets a
visible recovery page. The skip link focuses content without becoming a route.

Study uses `?study=<postId>&lesson=<lessonId>`. Karaoke uses `?sing=<postId>`;
its existing server attempt read resumes the open take. These parameters are
mutually exclusive. The shell retains an unauthenticated deep link through
sign-in and resolves it only against the actual published feed. Opening an
activity pushes browser history; closing clears only its activity parameters.
Back/forward synchronizes overlays and releases their capture components.
Lane 5 owns attempt/resume internals and may propose an exact routing amendment.

`ShellIntegrations` supplies explicitly mounted Solid render functions for a
public video feed, account settings and private Dance. Each receives the
current community ID, session, and a read-only published-song snapshot.
Private components receive session CSRF only while authenticated. They must
recheck authority at their server. A public-posting capability is supplied by
lane 3, with `unresolved` distinct from `allowed`; absence grants no posting
right. Private Dance is independent of public-posting permission. No unavailable
feature is rendered as an active control. Lane 2's existing `LiveRewardWallet`
continues to mount with `csrf` and `onExit`; no wallet rewrite is needed here.

Lane 3 should return real public video cards from `publicFeed`, including its
loading/error/retry/empty states, and a permitted uploader from `publicComposer`.
Lane 4 supplies `privateDance` with its own submission/review authority.
Telegram supplies `accountSettings`. Coordinator integration imports these
components and passes render functions to `App`; no global registry, centralized
API, alternate authentication or placeholder posts are introduced.

The current feed does not expose streaks or an authoritative draw clock.
Consequently the shell shows published songs and existing server offers without
inventing Your Songs membership, counts or a daily draw timer. A future version
can add server facts for those views. Public video feed and private Dance
acceptance require the feature integrations, which are not implied by shell tests.
