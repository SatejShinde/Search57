# Startup funding and summer 2027 internship sources

Research checked October 31, 2026. Target: a UC Davis computer-engineering student seeking hardware-related internships. U.S. is the provisional location scope. F-1 with possible CPT is user-provided context, not a statement that a particular position is eligible or that authorization has been approved.

## Selected free source

**Midu** publishes a documented read-only funding API. Its current early-access allowance is 1,000 requests/day and 60/minute, with an email-created key and no card. `/api/v1/rounds` supports dates, region, and source filters. This implementation requests U.S. news reports and keeps source links. It does not treat SEC offering filings as completed funding rounds. Attribution is required; the free offer can change. The documentation exposes only a partial record schema, so a credentialed smoke test is still required before activating delivery. Unknown domain, stage, or amount stays unknown.

Source: [Midu API documentation and terms](https://midu.si/api).

## Alternatives evaluated

| Source | Current access | Decision |
| --- | --- | --- |
| Recent Funding | Free key: 10 calls/day with data at least 14 days delayed. Live pay-as-you-go: $0.10/call, $10 minimum credit purchase. | Possible fallback if free coverage proves inadequate; not enabled or purchased. One call per day is about $3 per 30 days, with pagination/enrichment extra. |
| Fundz Pro | $49/month billed annually; 50 API requests/day. | More cost than the initial personal workflow needs. Its capture date is not necessarily the announcement date. |
| Crunchbase / Dealroom | API access is separately licensed or sales-assisted. | Do not assume a consumer website subscription includes an API. Unnecessary for this first version. |

Sources: [Recent Funding API](https://recentfunding.com/docs/), [Recent Funding terms](https://recentfunding.com/terms/), [Fundz pricing](https://app.fundz.net/pricing), [Fundz API dates](https://app.fundz.net/knowledge/api-references/authentication), [Crunchbase API FAQ](https://support.crunchbase.com/hc/en-us/articles/32319290128019-Crunchbase-API-FAQ), [Dealroom API](https://dealroom.co/products/dealroom-api/).

Recent Funding's current API documentation and older terms disagree about key/pricing requirements. Resolve that before paying. No paid service or subscription was activated.

## Open-role sources

- [Greenhouse Job Board API](https://docs.greenhouse.io/job-board): public GET endpoints for known employer board tokens.
- [Lever Postings API](https://github.com/lever/postings-api): public posted jobs for known company slugs; U.S. and EU API hosts.
- [Ashby public Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api): public board endpoint; exclude `isListed: false` records.
- [YC startup jobs](https://www.ycombinator.com/jobs/) and [Wellfound jobs](https://wellfound.com/jobs): useful additional discovery channels. The research did not locate an official general-purpose public jobs API for either, so the daily integration does not depend on private endpoints.

These ATS APIs list jobs for a known company; they do not provide a complete directory of startups. Linking a company to its official careers page is a separate discovery step. Companies with unknown websites or unsupported careers systems remain review leads.

## How to use the leads

Funding is a useful outreach signal, not evidence of an internship opening or a hiring budget. An open role should be identified from a currently published ATS listing. Summer 2027 timing must be explicit to receive that label; otherwise review the timing. Employer citizenship, work-authorization, sponsorship, and export-control wording should be read for the specific role.

For a funding prospect without a posted internship, use the linked announcement and official careers/contact page to decide whether to approach the company. A useful email can identify one hardware project or technical need, connect it to a specific project from the student's resume, and ask whether a summer internship could fit. This version does not find personal email addresses, send outreach, or submit applications. The supplied master resume informs a deterministic technical-overlap score, with embedded/sensors/controls/instrumentation prioritized and unsupported FPGA/ASIC implementation skills labeled exploratory. Personalized outreach drafts can be added separately.

## Cost and operation

The daily program uses ordinary API requests and deterministic filters, with **no model/API token usage**. GitHub Actions usage is subject to the account's plan and quotas. Search57 already uses `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; the new funding key is `MIDU_API_KEY`.

Run once daily through cron-job.org's GitHub workflow dispatch, retain a lookback window for late discoveries, deduplicate across runs, and keep watching discovered ATS boards as the funding announcement ages. A failed source or delivery should be visible as a failed workflow. The funding-provider response must be tested with a real key before calling the integration live.

Operational references: [GitHub scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [Telegram sendMessage](https://core.telegram.org/bots/api#sendmessage), [existing Search57](https://github.com/SatejShinde/Search57).
