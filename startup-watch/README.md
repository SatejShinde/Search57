# Daily startup hardware internship watch

Find funding outreach prospects and posted hardware internships for summer 2027, then deliver new items through the existing Search57 Telegram bot. cron-job.org dispatches the separate startup workflow once daily. It uses Node 22+, built-in modules, and no model calls or npm dependencies. See [SETUP_SEARCH57.md](SETUP_SEARCH57.md) for the exact PowerShell/Git commands and cron-job.org fields.

**Status:** implemented and locally tested; not deployed. The Midu API requires a user-created key for a credentialed live test. Telegram delivery and GitHub's hosted workflow have not been run. The connected GitHub account currently has read-only access to Search57.

## Included behavior

- Free-first Midu news funding feed with a rolling 30-day lookback and required attribution.
- Hardware company keywords, including Chinese terms because some Midu summaries are Chinese.
- Configurable technical-evidence matching based on the master resume: embedded/firmware, sensors/electronics testing, PLC/controls, instrumentation, and current low-power research. FPGA/ASIC/RTL are explicitly exploratory. Only nonidentifying technical summaries are stored; the full resume is not bundled.
- Public Greenhouse, Lever, and Ashby job-board reads, including direct-link-only listing exclusions.
- A small persistent company registry; supported ATS boards are discovered from an available official company website or supplied explicitly.
- Separate funding prospects and currently published internship matches. Dates, role fit, geography, and eligibility remain qualified when uncertain.
- New items only, with a configurable daily cap and an unsent backlog.
- Plain-text Telegram messages, bounded message size, and state checkpoints after confirmed delivery.
- Preview mode by default. `--demo` uses fictional fixtures, never calls the network, and never changes delivery state, even if `--send` is also passed.

The seed watchlist includes Rugged Robotics, whose public Greenhouse board was checked during development. This seed does not imply a recent funding event. Newly discovered supported boards remain monitored after their original funding news ages out.

## Install into Search57 or a new repository

The supplied archive has this repository-relative layout:

```text
.github/workflows/startup-daily.yml
startup-watch/
  config.json
  run.mjs
  lib/
  test/
  package.json
  README.md
  RESEARCH.md
  .gitignore
  .env.example
```

Copy both directories into the repository root. Keep the workflow in `.github/workflows`, not at the root: root-level workflow YAML files do not run. Existing Search57 code and its fast/slow schedules do not need modification.

1. Sign in at [Midu's API page](https://midu.si/api) and create a free API key. Its current early-access offer requires no card; check the displayed terms when signing up.
2. In the GitHub repository's **Settings → Secrets and variables → Actions**, set repository secret `MIDU_API_KEY`. Reuse Search57's existing `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. A new repository needs all three secrets. Do not put credentials in JSON, source code, or chat.
3. Commit the package and workflow to `main`. There is no native GitHub schedule; cron-job.org sends a workflow dispatch. Send requests are skipped while repository variable `STARTUP_WATCH_ENABLED` is absent or not `true`.
4. In **Actions → Startup prospect daily digest → Run workflow**, leave `send` false. This runs tests and generates a live preview artifact. Check whether the funding response matches the adapter, company source links resolve correctly, and the target filters are useful.
5. Set repository variable `STARTUP_WATCH_ENABLED` to `true` when ready for delivery. A manual run with `send` true exercises the Telegram path. Configure cron-job.org with a daily POST to the workflow dispatch endpoint, using the instructions in [SETUP_SEARCH57.md](SETUP_SEARCH57.md).

GitHub's workflow token needs permission to write repository contents and create/update the `startup-watch-state` branch. Repository or organization rules may restrict this even though the YAML requests it. A separate personal access token is not normally required.

The proposed cron-job.org schedule is **08:37 every day**, with its timezone set to **America/Los_Angeles**. The named timezone follows daylight saving changes. The workflow accepts `workflow_dispatch` only, so this package does not create a second native schedule. External dispatch still depends on GitHub runner availability. A run with no new matches sends no Telegram message.

## Local use

From the `startup-watch` directory, with Node 22 or newer:

```sh
node --test
node run.mjs --demo --output .local/demo
```

To test live data locally, copy `.env.example` to `.env`, enter the keys locally, then:

```sh
node --env-file=.env run.mjs --config config.json --state .local/state.json --output .local/preview
```

Preview mode makes read-only source requests but does not send messages or change delivery state. To send to the configured Telegram destination, explicitly add `--send`:

```sh
node --env-file=.env run.mjs --config config.json --state .local/state.json --output .local/preview --send
```

The output directory contains `preview.txt` and `digest.json`. The GitHub workflow keeps these as an Actions artifact for 14 days. Artifacts and the state branch may contain public job/news data but no API keys, resume, or personal application answers.

## Configure targets

Edit `config.json`:

| Setting | Purpose |
| --- | --- |
| `lookbackDays` | Funding-news window; default 30 days |
| `maxProspectsPerDay` | Maximum combined new internship/prospect items per run; default 10 |
| `maxNewWebsiteChecksPerDay` | Bound company-site discovery; default 5 companies, up to two pages each |
| `maxRequests` | Source-request cap per run; default 120. Telegram delivery has its own bounded budget. |
| `hardwareKeywords` | Hardware-role terminology |
| `prospectKeywords` | Broader sector terms used for funding-company discovery |
| `matchProfile` | Demonstrated technical categories, weights, evidence summaries, and exploratory skills; scores represent keyword overlap, not qualification probabilities |
| `companies` | Optional verified company websites, careers pages, and ATS slugs |

For a manually verified board, add an entry like this, replacing the illustrative values:

```json
{
  "name": "Company name",
  "careersUrl": "https://jobs.ashbyhq.com/verified-board-name",
  "boards": [{ "type": "ashby", "slug": "verified-board-name" }]
}
```

Supported types are `ashby`, `greenhouse`, and `lever`; use `"region": "eu"` for a Lever EU board. A registry `website` or `domain` must be verified rather than guessed. A company website is not guaranteed in the Midu schema; such companies can still appear as funding prospects, with career discovery left for review.

The current configuration targets U.S. opportunities. Unknown locations or remote restrictions need review. Summer 2027 must be supported by role timing; graduation-year mentions alone are not enough. Eligibility is never inferred from student status or the possibility of CPT. Resume-based ranking is deterministic and shows the evidence behind its scores. Outreach drafting is not part of this monitor.

## Reliability and limits

State is stored independently on `startup-watch-state`, so it does not compete with Search57's existing tracked state files. A workflow restores that branch before delivery and persists checkpoints even if a later message fails. A corrupt state or failed remote-state lookup stops delivery instead of resetting history. Concurrent state changes fail the push lease instead of overwriting state.

A successful scan is saved before delivery starts, so a first-message failure preserves discoveries and backlog without marking items as delivered. A fatal funding-source failure blocks delivery and state changes. Individual website or ATS failures allow other fresh results through, preserve progress, and produce a nonzero partial-source status for investigation. Failed ATS polls suppress stale job alerts until a successful refresh. Mechanical-only roles are excluded; description-only hardware matches are flagged for role-fit review below direct hardware title matches.

Exactly-once delivery cannot be guaranteed across Telegram and GitHub: a process crash after Telegram accepts a message but before the checkpoint is saved, or a failed state push, can cause a duplicate on the next run. An ambiguous Telegram timeout is not retried automatically. Previously delivered items are deduplicated; this is not an application tracker.

Coverage is limited by the funding provider, keyword matching, company-domain availability, and supported ATS systems. Dynamic sites, custom careers systems, or missing source fields can require a registry entry/manual review. A newly funded company is only an outreach prospect. No email is sent and no application is submitted by this package.

See [RESEARCH.md](RESEARCH.md) for provider comparisons, primary sources, and the outreach strategy.
