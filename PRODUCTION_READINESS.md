# Controlled canary and production readiness — 2026-11-09

**Status: real canary passed; branch prepared for review. No merge or production
activation has been performed. Desktop-export verification remains pending.**

## Live evidence

- [Manual canary run 42590138956](https://github.com/SatejShinde/Search57/actions/runs/42590138956)
- Tested commit: `19a945bbf1435a0e3c22aec0623154c9bbc40a34`.
- Job: NVIDIA, **NVIDIA 2027 Internships: Systems Software Engineering**, `JR2023492`,
  [official posting](https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/NVIDIA-2027-Internships--Systems-Software-Engineering_JR2023492).
- The old saved Eightfold link returned 404. The original smoke report retained
  provider/counts but not its selected posting IDs, so this accessible NVIDIA
  engineering internship was pinned instead. Only targeted detail requests were
  used; no catalog scan or historical backlog was invoked.
- Exactly one manual workflow dispatch, `canary=true`, `send=true`, review branch.
  `SEARCH57_DESCRIPTIONS_ENABLED` was unset before dispatch and remains unset.
- Telegram confirmed **4 messages**: job header, parts **1/2** and **2/2**, completion.
  Returned message IDs: **12743, 12744, 12745, 12746**.
- All **6,664 characters** of the retrieved description were reconstructed from
  Telegram's actual returned text. No transport truncation or echo changes.
- Description SHA256:
  `af245f15ff6ff77dc18e8860dc4c9a178384ddcf43ef9549df3146fc11da6ac6`.
- Completion/checkpoint, unique message IDs, wire sequence, and completed-queue
  no-replay check all passed. Source completeness is still subject to the
  upstream provider; the full text returned by this retrieval was delivered.
- The normal `check` job was **skipped**. Canary had **contents: read**, no
  persisted checkout credentials, no git-push step, and no production queue load.
  Hashes of both watcher states and existing/absent pending files were unchanged.
- Artifact ZIP SHA256 was independently checked after download:
  `db7d8c4b3031a9c1b42247af1c762b6b1704f4a860b2003ffab68038e36889a6`.
  Local reconstruction and checkpoint validation passed again.
- Temporary receipt artifact retention is one day; raw bodies are not committed.
  Credentials are masked in Actions logs; artifacts contain only returned
  message IDs/text and job/checkpoint metadata, not chat IDs or credentials.

The parser was exercised against **real Bot API response echoes**, not an actual
Telegram Desktop export. Do not call this Desktop end-to-end verification yet.
For that final check, export the four messages and run:

```powershell
python scripts/telegram_export_parser.py index C:/Exports/result.json --include-canary --output C:/Exports/canary-index.csv
python scripts/telegram_export_parser.py show C:/Exports/result.json --include-canary --key s57_2ccc1b906001d6d5a75951f2cd758492 --output C:/Exports/canary-description.txt
```

Require one complete canary row, two description parts, 6,664 characters, and the
SHA256 above. Canary messages are ignored by normal indexing; their scoped job
keys cannot complete or replace a production description transfer.

## Readiness review and corrections

| Area | Reviewed behavior |
| --- | --- |
| First activation | Existing seen states remain authoritative. Only new notifications are queued; no historical backfill. Startup digest retains its existing independent delivery history. |
| Follow-up trigger | `workflow_run` only for existing fast/slow watchers on main; manual tier/send recovery remains available after merge. Canary runs on the review branch cannot trigger production follow-up. |
| Permissions | Original watchers/follow-up need contents write; follow-up needs actions read for transient artifacts. Canary uses contents read only, with secrets confined to its send step. No new secrets. |
| Same-tier concurrency | Scan/follow-up share their tier lock and check out current main **after** lock acquisition. `queue: max` prevents a follow-up from replacing a pending scan; queue capacity remains finite (100 pending runs). |
| Cross-tier state pushes | New allowlisted publisher fetches/rebases and retries non-force pushes at most three times. Its CLI refuses local/feature-branch publication; normal scan jobs only run on main. A genuine conflict aborts conservatively; remote state is never overwritten. Tested with a temporary local Git remote containing stale fast/slow checkouts. |
| Checkpoint recovery | Each confirmed wire is checkpointed. Failed pushes retain one-day **metadata-only** recovery artifacts. Do not overwrite newer remote queues from an artifact without reconciling acknowledgements. |
| Time budgets | 12 jobs / 240 seconds per follow-up; one detail subprocess max 25 seconds; sender retries honor remaining deadline. An 8-minute workflow allows install/persist overhead. Startup worker remains inside its existing 20-minute digest job. |
| Backlog | Unfinished jobs rotate by last attempt and stay pending; no arbitrary body/queue truncation. One-day listing artifact expiry falls back to one-job retrieval. Monitor queue age and workflow failures. |
| Disable | Unset the feature variable: original scheduled scans/alerts continue; description handoff/recovery jobs pause. Pending metadata stays intact for re-enable. Already-unconfirmed alert retries inside paused follow-up also pause; check pending entries before a prolonged shutdown. |
| Upstream failure | Explicit partial/unavailable/failed records; no claim of complete text when upstream caps or summary fallbacks are detected. Fully delivered terminal retrieval failures do not retry forever. |
| Ambiguous sends | Telegram cannot guarantee client exactly-once delivery. Timeouts/crashes can repeat a wire identity; parser hashes/sequence prevent mixed reconstruction. |

No notification-selection predicates, company inventory, description-scan flags,
production cron expressions, application records, or resumes were changed.

## Synchronization and tests

Main was merged into the feature branch, preserving its latest watcher-state
versions. Before publishing the final branch, main was fetched/merged again and
`git diff origin/main -- state_fast.json state_slow.json` was required to be empty.
No force-push to main, merge into main, or production variable change occurred.
Live watcher commits can advance main again; repeat this check immediately before
merge rather than copying stale state files from an old feature snapshot.

- **45 Python tests passed** after synchronization, including canary guards,
  multipart API-echo verification, read-only protected-state checks, parser
  canary exclusion, bounded push retries/conflicts and a real local Git race test.
- **22 Node tests passed**, preserving startup selectors and original alert text.
- GitHub canary ran the then-current **38 Python tests successfully on Linux**
  before the real send; later publisher tests ran locally without production writes.
- YAML parsing passed; original fast/slow cron expressions match main.
- The application CSV and Markdown log hashes remain unchanged. The local parser
  copies match their repository sources. No applications, resumes, or other jobs
  were processed.

## Exact merge/activation sequence — requires separate approval

1. Finish the optional-but-recommended actual Desktop export verification above;
   resolve any reconstruction failure before activation. Review the feature diff.
2. Fetch main and merge **main into the review branch**, preserving main's latest
   `state_fast.json`/`state_slow.json` (and any pending files). Require main to be
   an ancestor of HEAD and require no watcher-state diff against that main SHA.
   Rerun Python/Node suites if the synchronization changes code. Push normally.
3. Merge the reviewed branch through GitHub's normal PR merge process. **Keep
   `SEARCH57_DESCRIPTIONS_ENABLED` unset/false during the merge.** No force push,
   copied old state files, new cron schedules, or manual backlog injection.
4. Confirm main contains `description-followup.yml`, `persist_watcher_state.py`
   and the tested formatter/worker, and that existing Actions secrets and
   contents-write/actions-read permissions are available. Branch rules must permit
   the same bot state commits already used by the watchers.
5. Only after explicit activation approval, set repository Actions variable
   `SEARCH57_DESCRIPTIONS_ENABLED` to exactly `true`. No schedule edits or new
   secret values. Wait for the next normal scans; do not force a catalog/backfill
   or reuse the canary workflow as a production scan.
6. Inspect first fast/slow runs and their follow-ups: new alerts unchanged,
   pending entries created/drained, Telegram multipart completion consistent,
   state pushes successful. Startup description work begins with its next
   already-scheduled externally dispatched digest; do not run an extra digest.
7. If needed, unset the variable to pause description work while original alerts
   continue. Keep pending metadata for recovery. After approval/re-enable, the
   bounded follow-up can resume on the next watcher completion or a manual
   `description-followup.yml` tier/send dispatch. Inspect failed-push artifacts
   conservatively rather than replacing newer state wholesale.

Remaining external checks: actual Desktop export roundtrip, production trigger
operation and first-run workload under real traffic. These are not implied by
the successful one-job canary. Activation has **not** been approved or performed.

Primary references: [manual dispatch/default-branch behavior](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow),
[GitHub concurrency queues](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
