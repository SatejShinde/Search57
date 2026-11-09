# Search57 Telegram descriptions — production deployment

Deployment and activation succeeded with explicit user approval.

- Feature merge on main: `27cc70b7537c1b6cd3091e22d4115e1131006b3f`.
- Latest pre-merge production parent: `3e349583c4be9df44ffc3217c1223e526eb03941`.
- GitHub connector PR creation returned 403. The authorized authenticated Git
  fallback was used; main was unprotected and push permission was confirmed.
  A normal merge/push succeeded. No force push or protection bypass.
- `SEARCH57_DESCRIPTIONS_ENABLED=true` was created at **09:24:16 UTC** and
  independently read back. Follow-up workflow was registered and active on main.
- Existing Telegram secret names and Actions availability were confirmed without
  reading/logging secret values. The canary was not repeated.
- **45 Python tests and 22 Node tests passed**, including another full run on the
  merged main tree before activation. No critical test failed.

## Production observation

All runs below arose from the unchanged external scheduler or automatic
`workflow_run` follow-up. No manual scan, backfill, job injection or resend.

| Run | Result |
| --- | --- |
| [Fast watcher 42594014245](https://github.com/SatejShinde/Search57/actions/runs/42594014245) | Success; one new Qualcomm posting, original alert acknowledged, one description queued. Canary job skipped. |
| [Fast follow-up 42594300951](https://github.com/SatejShinde/Search57/actions/runs/42594300951) | Success; targeted retrieval path, confirmed delivery loop completed, pending zero. |
| [Slow watcher 42594016343](https://github.com/SatejShinde/Search57/actions/runs/42594016343) | Success; zero new postings, no description backlog created. |
| [Slow follow-up 42594402172](https://github.com/SatejShinde/Search57/actions/runs/42594402172) | Success; empty queue, pending zero. |

The fast listing-description artifact contained zero cached descriptions, so its
one queued job required targeted retrieval. Git history confirms:

1. `fea5e9dff1982f30c10ebaf66a514a96cf981dcc` saved one pending Eightfold job with
   its original alert acknowledged. Its ATS ID was absent from the preceding
   production seen state, confirming genuinely new traffic rather than backfill.
2. `64a52602b534f08d2a84ce27b23f40cedd878668` saved the successfully drained queue.

The worker reported `{"pending": 0, "complete": true}`. Successful completion
requires every formatted wire message to receive Telegram's confirmation and a
message ID. No unconfirmed alerts, failed workflows, or duplicate alerts were
indicated in this observation. Per-job bodies/part counts are not retained by the
production summary, so independent reconstruction of this new posting still
requires its Telegram export; no unsupported account access was attempted.

Final observed pending counts: **fast 0, slow 0**. Feature variable remained true.

## Preserved behavior and outstanding checks

- The latest production watcher-state blobs were identical before/after the
  feature merge. There was no existing pending state to overwrite. Subsequent
  queue/seen-state changes above were normal production watcher commits.
- Original company inventory, title/location predicates, lightweight scraper
  flags and cron expressions matched the pre-deployment baseline. Existing
  dispatch URLs and request bodies remained compatible and worked unchanged.
  **cron-job.org required no changes.**
- Application CSV/log SHA256 hashes remained unchanged. No resumes or internship
  applications were generated or processed.
- The available real Desktop export contains 6,162 messages and ends on
  **2026-11-07 00:31:20**, before the November 9 canary. It does not contain the
  canary key. Actual Desktop-export verification is therefore **outstanding,
  nonblocking**, as explicitly authorized. Prior real API-echo reconstruction of
  all 6,664 canary characters and its SHA256 remains valid.
- Pre-existing provider access errors remain for **John Deere, Siemens, NXP,
  Meta and Tesla**. They were confirmed in pre-deployment watcher logs; no
  companies were removed or extra filters added to conceal them.
- The empty slow queue had no listing artifact. The optional download step
  reported artifact-not-found; fallback handled it and the overall run succeeded.
- No serious deployment regression was observed, so rollback was not needed.
  To pause description work, set the feature variable false/unset it; preserve
  pending state and keep the original watchers running.

See PRODUCTION_READINESS.md for the canary key/hash, parser command and bounded
recovery behavior. Routine future traffic should continue under the existing
schedules; no additional activation step is required.
