# Telegram description delivery — staged, disabled by default

The controlled real canary has now passed. See [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md)
for its four confirmed messages, SHA256/checkpoint evidence, safe merge sequence,
and remaining Desktop-export check. Production activation is still pending.

Telegram is the persistent description store. No description archive branch,
permanent description database, new filtering, or historical backfill is added.
The new feature is gated by `SEARCH57_DESCRIPTIONS_ENABLED=true`. This work does
not set that variable, change any cron expression, or send any Telegram messages.

## Flow and bounded work

1. `check_jobs.py` keeps every original company, keyword, location predicate,
   tier, and `include_descriptions=False` builder. Selection is frozen against
   the baseline AST in `tests/fixtures/original_selection.json`.
2. For newly selected notifications, it checkpoints identity-only pending data
   before sending the fast alert. Listing descriptions go to a **one-day Actions
   artifact**, never git. No detail requests occur inside the company scan.
   Successful alerts checkpoint an acknowledgement; failed alerts remain pending.
3. `description-followup.yml` runs after the existing fast/slow workflow finishes,
   under the **same tier concurrency lock**. It checks out latest `main`, restores
   the transient payload when available, then calls `description_delivery.py`.
4. Each run processes at most 12 pending jobs in 240 seconds. Each selected
   retrieval runs in a subprocess with a 25-second wall timeout. It never calls
   `fetch()` or rescans a catalog for enrichment. It reuses listing bodies first;
   Apple/Oracle summaries and short Amazon teasers trigger targeted detail work.
5. Plain-text sends require Telegram's `ok=true` and a message ID. Rate limits
   honor `retry_after`; network/5xx errors have at most three attempts bounded by
   the remaining run budget. Messages are paced at 3.1 seconds. Every confirmed
   wire message is checkpointed by its content hash. Incomplete delivery remains
   pending, reports a failed workflow, and resumes after a later watcher run or
   manual follow-up. FIFO-by-last-attempt rotation prevents starvation.
6. Only pending metadata, revision hashes and message acknowledgements persist
   in `pending_fast.json` / `pending_slow.json`. Entries are deleted after a
   terminal description-status record is fully delivered. Retrieval failure
   produces a truthful `failed`, `unavailable`, or `partial` record; an already
   sent alert remains valid. Terminal retrieval failures are not endlessly
   retried; delivery failures are. No permanent body cache is introduced.

The independent startup digest is covered too: it captures full listing text
before its existing 1,200-character display summary, but queues descriptions
**only for the jobs its existing selector chose**. Its existing funding alerts,
filters, ranking and daily cap remain unchanged. The bounded worker runs after
the digest, using `descriptionPending` metadata inside its existing state and a
transient `.runtime/description-listings.json`. No additional startup schedule.

## Provider behavior (ats-scrapers 0.3.0 pinned)

| Providers | Missing-body retrieval |
| --- | --- |
| Eightfold, Workday, Oracle, SmartRecruiters, iCIMS, Google, Meta, Tesla | Library `get_description(job)` for exactly one saved job |
| Apple | Library `_enrich_apple_details([job], ...)` for exactly one job; the pinned version has no public targeted override |
| Greenhouse | One public job-detail API request if listing body absent |
| Amazon | One canonical posting page; extract JobPosting JSON-LD if listing full body absent |
| Startup Lever/Ashby | Reuse complete existing listing payload; single-page JSON-LD fallback if transient payload expired |

Browser-gated Tesla retrieval may exceed the time budget or require existing
scraper browser setup. Google/Meta listing failures remain existing limitations;
this feature cannot retrieve descriptions for postings the scan never finds.
Unavailable, blocked, closed, or changed detail pages are explicitly reported.
HTML is normalized into readable plain text without a transport length cap.
Possible upstream 25,000-character caps and Google's possible meta-description
fallback are labeled `partial`. `available` means text was returned, **not** an
independent proof that upstream supplied the complete original document.

## Wire format v1

Every record begins `[Search57 v1]`, has readable company/title/location/link,
then `[Record]` and one JSON metadata line, `[Description]`, optional plain-text
body, and `[/Search57]`. JSON escaping prevents title/newline delimiter injection.
Metadata includes company, title, location, platform, ATS ID, requisition ID,
URL, `key`, `sha256`, `status`, `note`, `parts`, `part`, `kind`, and `v`.

`key` is a company-scoped SHA256 identity using platform + requisition/ATS ID
(location suffixes after `@` collapse), with normalized URL fallback. A body's
full SHA256 is its revision. Short text uses one self-contained `job` record.
Long text uses a job header, numbered `part` messages, then a `complete` marker.
Bodies are split on Unicode code points within a conservative UTF-16-unit limit;
every complete wire message must fit 4,096 units. Nothing is silently truncated.
All parts must be present and their reconstructed SHA256 must match. Repeated
identical parts are harmless; conflicting parts or incomplete transfers fail QA.

To preserve notification latency, the initial fast alert is sent immediately;
the follow-up metadata and short description combine in one message. Telegram
therefore contains the original alert plus its description record. Ambiguous
network timeouts or crashes between Telegram acknowledgement and remote state
commit can produce duplicate wire messages: Telegram has no client idempotency
key. Versioned identities make reconstruction safe; exactly-once delivery is
not claimed. If the upstream description changes during a retry, the new hash
starts a separate transfer, never a mixture of versions.

## Local export parser

Canonical source: `telegram_export.py` + `telegram_jobs.py`; standard library
only. Local copies are installed in the Codex resume workspace as
`scripts/telegram_export_parser.py` + `scripts/telegram_jobs.py`. The application
tracker is imported only by the local copy when explicitly requested, using
`read_database` and `check_job`; no log sync or tracker CLI is invoked.

```powershell
python scripts/telegram_export_parser.py index C:/Exports/result.json --output C:/Exports/index.csv
python scripts/telegram_export_parser.py index C:/Exports/result.json --applications applications/applications.csv --skip-applied
python scripts/telegram_export_parser.py show C:/Exports/result.json --key s57_... --output C:/Exports/selected-description.txt
```

The parser streams a single-chat or all-chats Desktop JSON export. It performs
two deterministic passes, temporarily spooling bodies for end-to-end hash
verification, and deletes that spool on exit. The index contains identities,
URLs, statuses, part counts, hashes and message IDs, **no full descriptions**.
`show` rereads the original export and loads bodies only for the selected key.
Keep `result.json`; the CSV is not a description archive. Legacy title+URL
messages remain indexable with unavailable-description status. Known ATS URL
patterns recover IDs where possible; unknown/ambiguous identities remain
separate. Company-scoped requisitions collapse location/cross-ATS variants. The most recent complete available revision is preferred; incomplete additional transfers remain flagged in the notes.
Applied matches can be excluded; uncertain application matches remain `review`.
Do not send the full export to a language model.

Isolated `CANARY TEST` records are excluded by default. Use `--include-canary`
explicitly for the canary export verification. Canary job keys are scoped by
run ID so they cannot complete a production transfer.

## Activation and recovery — setup remains pending

- Review/merge the isolated feature branch after the no-send dry run.
- Keep existing `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` secrets; no new secret.
- Only after approving activation, set repository Actions variable
  `SEARCH57_DESCRIPTIONS_ENABLED` to exactly `true`.
- Existing fast/slow cron intervals remain 10/30 minutes. The new follow-up has
  no cron: it uses `workflow_run` plus optional manual `tier`/`send=true` dispatch.
- Follow-up requires Actions read and contents write permissions. Existing
  startup state permissions/lease/concurrency remain in effect.
- Missing transient artifacts fall back to targeted retrieval. Check failed
  follow-up runs and remaining pending counts. To pause, unset the variable;
  existing alerts continue and pending metadata remains available for recovery.
- No automatic replay of all previously seen postings is performed.

## Verification

Run `python -m unittest discover -s tests -v` and `node --test` from startup-watch.
Tests never use real Telegram credentials. See `DRY_RUN_REPORT.md` for the saved
results, live retrieval-only smoke, workflow checks, and tracker hash audit.
