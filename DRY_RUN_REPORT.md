# No-send dry run — 2026-11-09

Historical pre-canary results. The subsequent real Telegram canary succeeded;
see [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) for current evidence and
the remaining Desktop-export verification. Production remains disabled.

Result: **PASS for local mocked/integration checks and limited live retrieval.**
Production activation remains pending. No Telegram sends, repository-variable
updates, workflow dispatches, schedule changes, or resume generation occurred.

| Check | Result |
| --- | --- |
| Python regression/integration suite | 30/30 passed |
| Startup Node suite, including existing regressions | 22/22 passed |
| Python syntax compilation | Passed |
| Edited/new workflow YAML parsing | 5/5 passed |
| Existing fast/slow/startup trigger definitions vs baseline | Identical |
| Frozen original company/filter/builder AST | Identical |
| Enabled/disabled watcher selection with PhD/business/stretch fixtures | Same selected jobs; no new filters |
| Startup enabled/disabled selected items and original Telegram bodies | Identical |
| Real subprocess with cached synthetic Unicode description | Passed; no HTTP |
| Installed local parser source vs repository source | Byte-identical |
| Local parser CLI index/show | Passed |
| Local parser confirmed-applied exclusion | Passed with existing tracker read-only API |
| Canonical application CSV and Markdown log SHA256 before/after | Unchanged |

Covered short combined records, long Unicode multipart records, exact text
roundtrips, missing header/chunks/completion, conflicting/corrupt chunks,
out-of-order messages, duplicates, revision isolation, location variants,
legacy title+URL notifications, delimiter injection, HTML normalization,
4,096-unit limits, upstream cap labeling, targeted-only retrieval, summary
hydration, rate limits, transient errors, ambiguous timeouts, partial checkpoint
resume, retrieval failures that preserve alerts, and other-job progress.

The Windows sandbox blocks Python asyncio's internal local socket pair; the
mocked async test was rerun with loopback permission. All remote HTTP in that
suite stayed mocked. Node tests and actual retrieval-only smoke passed separately.

## Limited live retrieval smoke

Installed and inspected **ats-scrapers 0.3.0**. One first-page NVIDIA Eightfold
query and one lightweight Axon Greenhouse listing supplied sample identities.
Exactly one selected job description per provider was retrieved. Neither
`fetch()` nor a second catalog scan was used to obtain descriptions.

| Provider | Result | Returned source characters | Telegram sends |
| --- | --- | ---: | ---: |
| NVIDIA / Eightfold targeted library method | available | 2,982 | 0 |
| Axon / Greenhouse single-job detail endpoint | available | 11,263 | 0 |

Combined elapsed retrieval time was 1.34 seconds in this local run. The NVIDIA
versioned message preview fit in one 3,660 UTF-16-unit message. Character counts
above are scraper-returned source before the later HTML-to-plain-text change;
normalization and message-size checks were subsequently verified with mocks.
Live descriptions are not retained in the repository. This small smoke does
not certify every provider, prove complete original source text, or exercise
real Telegram delivery. No actual Desktop export was supplied; export tests use
synthetic fixtures matching Desktop string/entity and all-chat wrapper shapes.

## Known limits / operational follow-up

- Telegram has no caller-supplied idempotency key. A send accepted remotely but
  timed out locally may repeat; parser dedupe and hashes prevent mixed content.
- Transient listing artifacts expire after one day. Later retries perform only
  targeted retrieval; unavailable/closed pages can leave partial records.
- Upstream summaries, 25k caps, bot blocks, Google/Meta listing failures, and
  Tesla's browser setup/budget remain best-effort limitations, explicitly labeled.
- A fully delivered failed/unavailable retrieval record is terminal. Delivery
  errors remain pending for later retries, and pending workflows report failure.
- All queued jobs remain pending beyond the 12-job/240-second per-run budget;
  no arbitrary backlog truncation. Monitor failed workflows and pending counts.
- GitHub runner/network outages, a hard kill before state commit, or remote push
  failure can cause replay. Checkpoints reduce loss; exactly-once is not claimed.
- GitHub Actions itself and real Telegram sending have not been exercised here.
  Review/merge and activation setup are documented in TELEGRAM_DESCRIPTIONS.md.

References consulted: Telegram's [sendMessage API](https://core.telegram.org/bots/api#sendmessage)
and [bot rate-limit guidance](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this),
plus the installed ats-scrapers wheel source (all existing provider adapters).
