# FragranceOS — Funnel Diagnostic

*Run against the live `fragrance-os` Supabase project on 2026-07-25. Everything below was discovered by database introspection — no table or column names were assumed. De-identified for storage in a public repo: individual users are labelled, not named.*

**Ground-truth boundary:** the FragranceOS *application code* was not available in the environment where this ran (the session was rooted in an unrelated repository). Steps 1–4 are answered fully from the database. Step 5's code-tracing questions (share route, middleware, onboarding screen) **could not** be answered and are marked as such rather than guessed.

---

## Step 1 — Schema discovery

Live funnel tables found:

| Role | Table | Rows |
|---|---|---|
| Users / auth | `auth.users`, `auth.identities` | 9 users |
| Search log | `fragrance.catalog_demand_log` (`query`, `result_count`, `event_type`) | 110 (78 search, 32 select) |
| Failed-search log | `fragrance.missing_fragrance_requests` (`search_query`) | 0 |
| Collection (owned) | `fragrance.fragrances` + `fragrance.bottle_inventory` | 347 / 333 |
| App-open / session telemetry | `fragrance.app_open_events` | 0 (empty) |
| Share (manual logs) | `fragrance.share_log`, `shared_by_me`, `shared_with_me` | 0 / 0 / 0 |

**Expected but NOT found — the missing tables are the finding:**

1. **No wishlist / saved / favorites table anywhere** (searched all schemas for `wish|favorite|saved|bookmark|want`). Wishlist adds cannot be computed — the concept is not persisted. Every "wishlist adds" figure here is **N/A, not zero**.
2. **No pre-authentication / anonymous / device / share-open event table** (searched `anon|visitor|device|impression|click|open|referrer|utm|deeplink`). The only match, `app_open_events`, requires a `user_id` and is empty. There is nowhere a logged-out visitor's event could land.
3. **`app_open_events` exists but has 0 rows** — session instrumentation was built and is not being written to.

~250 dated `*_backup_*`/`*_removed_*` tables and the `intelligence.*` / `robos.*` schemas were excluded as internal catalog-building / market-intelligence ops, not user funnel.

---

## Step 2 — The silent users

Roster reality (this does not match the "three silent users" framing, and the difference matters):

- 9 accounts total; **4 are non-human** (`claude@`, `collector1/2/3@fragranceos.io` — three never signed in).
- **Founder** = excluded. A **second founder account** (`…@mac.com`) also exists: 1 collection add, 0 searches.
- **Exactly three real external prospects**, all Google sign-ups:

| User (label) | First login | Searches | Collection adds | Wishlist | Last recorded action |
|---|---|---|---|---|---|
| Invested User A | 2026-07-16 | 36 | 26 | N/A | wear_log |
| Silent User B | 2026-07-16 | 0 | 0 | N/A | none |
| Silent User C | 2026-07-21 | 0 | 0 | N/A | none |

Silent Users B and C are **zero across every user-writable table** (0 search rows, 0 fragrances, 0 data-quality events, 0 errors, 0 pairings). They authenticated and did nothing else.

**Failure mode: decisively (a) — logged in, saw an empty state, left without ever searching.** Mode (b) requires at least one disappointing search; there is not a single search-log row for either account.

- **MEASURED:** 0 rows for B and C in `fragrance.catalog_demand_log` and `fragrance.fragrances`.
- **NOT MEASURED:** what they actually saw and how long they stayed — `app_open_events` empty, no screen-view telemetry. "Left" is inferred from absence of writes, not a recorded exit.
- **ASSERTION AUTHOR:** agent (defined "silent" = zero rows across all activity tables).
- **MISLEADING IF:** they are alt/bot signups rather than real prospects, or interacted on a client that never persisted anything (then "did nothing" overstates "recorded nothing").

**Session-count gap (all users):** no real session count is available. `app_open_events` is empty; `auth.sessions` holds only currently-valid refresh sessions (expired ones are pruned), so its residual count is not a lifetime total. To measure sessions, start writing to `app_open_events` (already exists) or log an app-open event per launch.

---

## Step 3 — The invested user (Invested User A)

Full annotated query stream: `analysis/real-user-queries.json`.

- **36 search events, 26 selects, 26 collection adds, 0 zero-result searches.**
- **Search-to-add conversion: 26 of 26 product-name searches → ~100%** (72% if dividing adds by raw search *events*).

Behavior reconstructed from interleaved timestamps: **search by name → tap top result → add → repeat**, ~26 times over two evenings — a person entering a real-world collection, not someone hunting and failing. Houses skew Middle-Eastern / clone: Lattafa ×8, Dossier ×3, Oakcha ×2.

- **Zero-result queries:** none.
- **Results-but-no-add:** effectively none for product searches. The only non-converting searches were **three accord/"vibe" descriptions** (`Black currant and vanilla`, `Coffee and whiskey`, `Coffee and whiskey bath`) — scent profiles rather than product names. Small n, but a real directional signal: name-search closes, vibe-search doesn't.
- **Reformulations:** 8 consecutive near-identical pairs. Seven benign (as-you-type keystrokes / deliberate narrowing). **One genuine friction signature:** `Memories` re-issued verbatim 40 seconds later, after it had already been added.

- **MEASURED:** 36/26/26/0 and per-query `result_count` from `catalog_demand_log` for A's `user_id`, cross-referenced to her `fragrances` rows by timestamp.
- **NOT MEASURED:** true tap-through per search — `select` rows store `frag_id` but a **NULL `query`**, so search→select can't be joined on text; linkage is temporal inference.
- **ASSERTION AUTHOR:** conversion definition is the agent's; raw search/select/add rows are pre-existing app instrumentation.
- **MISLEADING IF:** "36 searches" is read as 36 intents (it's ~26, inflated by as-you-type logging); `result_count` is capped at 25 ("25" = "≥25"); and 100% conversion is one power-user in a data-entry mood (n=1), not a product-wide rate.

---

## Step 4 — The invisible leak

**Share-link opens are not logged at all — not gated by auth, simply absent.** There is no pre-auth event sink. The three share tables are manual "I shared this with a friend" journals, each keyed to an authenticated `user_id`, and all three are empty. No table can hold a share-link *open* (logged-in or not).

**The top of the funnel is unmeasured by construction.** "How many opened a share link / from how many devices / how many became accounts" cannot be answered — the event does not exist in storage.

- **MEASURED:** 0 rows in all three share tables; 0 tables capable of holding a pre-auth/share-open event (schema-wide search).
- **NOT MEASURED:** the entire pre-auth funnel — opens, devices, open→signup.
- **ASSERTION AUTHOR:** agent (conclusion from absence of any suitable table, not a metric reading zero).
- **MISLEADING IF:** share-open events are captured outside Postgres — a client analytics SDK, CDN logs, or app-server logs. Only the database and its edge functions were checked.

**Fix:** emit a share-open event *before* the auth gate carrying an anonymous device/visitor id + share token into a new `share_opens` (or generic `events`) table; open→signup then becomes a join.

---

## Step 5 — Read the code

**Auth methods / Sign in with Apple:**
- Provable from data: only `email` (6) and `google` (4) identities have ever existed. **Zero Apple identities. Zero SSO providers configured.** Every real external signup used Google.
- Definitive answer, honestly: it is provable that **no user has ever signed in with Apple**, and Apple is almost certainly not enabled — but "enabled-but-unused" cannot be distinguished from "disabled" via the database. The authoritative source is the GoTrue auth config (Auth → Providers), not exposed to this run.
- **MISLEADING IF:** Apple was enabled recently but not yet used — identical signature to "disabled" here. Confirm in the Auth dashboard. (App Store 4.8 risk: a public build offering Google without Apple is the classic rejection trigger — verify against config.)

**Unauthenticated share-URL behavior / zero-fragrance onboarding:**
- **Could not be traced — application code was not available in this environment**, and the project ships only one edge function (`catalog-coverage-worker`, internal catalog tooling). Answering redirect-vs-blank-vs-404-vs-public-render and "is there a first-run screen" requires the app repository.
- The Step-2 evidence (two users authenticated, then wrote nothing) is *consistent with* a bare/empty landing screen but is circumstantial, not a code trace.

---

## Closing

**Single highest-confidence finding:** the two genuinely silent prospects **authenticated and never issued a single search** — failure mode (a). The fix is onboarding / empty-state, not search quality. The one user who did search converted **26 of 26 name-searches to adds with zero dead-ends**, direct evidence the search-and-add loop already works. The leak is getting users to the first search, not the search itself.

**Single biggest thing not measurable:** the **entire pre-authentication funnel** — share-link opens, devices, open→signup. No table can hold that event; it is blind by construction until a pre-auth share-open event is instrumented. (Same root cause, second order: session counts — `app_open_events` exists but is empty.)
