#!/usr/bin/env python3
"""Poll target companies for new internship/co-op postings and notify via Telegram.

Usage:
    python check_jobs.py --tier fast
    python check_jobs.py --tier slow

State (which job IDs have already been seen and notified on) is kept in
state_<tier>.json in the repo root. The GitHub Actions workflow commits that
file back after every run, so state persists across runs even though each
run starts on a fresh machine.

Tiers exist because company catalogs are wildly different sizes:
  - "fast": small-catalog targets (dozens to low hundreds of open roles
    company-wide), so a full scan every ~10 min is cheap and this is where
    being first actually matters -- these postings aren't watched by every
    other tracker. One deliberate exception: NVIDIA has ~1,100 open roles
    (not actually small) but stays here anyway as your explicit #1 target --
    a priority-based inclusion, not a size-based one.
  - "slow": large/mega catalogs (~1,000+ roles company-wide) -- Microsoft
    (~1,000-2,000), Amazon (~20,000), Apple, Google, Meta, Tesla. Scanned
    less often (~30 min) to stay fast and polite; postings at this scale
    get picked up by every other tracker within minutes anyway, so
    sub-10-minute notice buys you little here.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable

import requests
from ats_scrapers.scrapers import (
    AmazonScraper,
    AppleScraper,
    EightfoldScraper,
    GoogleScraper,
    GreenhouseScraper,
    MetaScraper,
    OracleScraper,
    SmartRecruitersScraper,
    TeslaScraper,
    WorkdayScraper,
)

# Meta's scraper listens for background network calls after loading the
# page rather than calling an API directly, and only waits 8s by default
# for them to fire. Confirmed 2026-08: Meta silently returned 0 results
# in CI (no error -- the browser loaded fine, it just didn't catch
# anything in that window) while Tesla, which uses the same browser
# mechanism, succeeded with 357 results in the same run. Stretching the
# window is a cheap, low-risk experiment for a shared CI runner being
# slower than a residential machine. Not guaranteed to fix it.
import ats_scrapers.scrapers.meta as _meta_module
_meta_module._GRAPHQL_SETTLE_MS = 20_000

# --------------------------------------------------------------------------
# Company config
# --------------------------------------------------------------------------
# AMD is deliberately not here: careers.amd.com doesn't match any ATS
# pattern in the ats-scrapers inventory or any pattern I could confirm
# live. Needs a manual DevTools pass before it can be added.
COMPANIES: list[dict[str, Any]] = [
    # --- fast tier: hardware / semiconductor / industrial (your wedge) ---
    # NVIDIA: ~1,100 open roles globally -- not actually "small," but kept
    # in the fast tier deliberately: this is the stated #1 target, so the
    # extra polling load is a reasonable price. Not a size-based inclusion,
    # a priority-based one -- don't use this as precedent for adding other
    # medium-catalog companies here.
    {"name": "NVIDIA", "tier": "fast", "platform": "eightfold", "slug": "nvidia"},
    {"name": "Qualcomm", "tier": "fast", "platform": "eightfold", "slug": "qualcomm"},
    {
        "name": "John Deere", "tier": "fast", "platform": "eightfold", "slug": "deere",
        "domain": "johndeere.com", "company_name": "John Deere",
    },
    {"name": "STMicroelectronics", "tier": "fast", "platform": "eightfold", "slug": "stmicroelectronics"},
    {
        "name": "Siemens", "tier": "fast", "platform": "eightfold", "slug": "siemens",
        "base_url": "https://jobs.siemens.com", "domain": "siemens.com",
    },
    {"name": "Intel", "tier": "fast", "platform": "workday",
     "url": "https://intel.wd1.myworkdayjobs.com/external"},
    {"name": "Analog Devices", "tier": "fast", "platform": "workday",
     "url": "https://analogdevices.wd1.myworkdayjobs.com/External"},
    {"name": "Rockwell Automation", "tier": "fast", "platform": "workday",
     "url": "https://rockwellautomation.wd1.myworkdayjobs.com/External-Rockwell-Automation-Early-Careers"},
    {"name": "Broadcom", "tier": "fast", "platform": "workday",
     "url": "https://broadcom.wd1.myworkdayjobs.com/external_career"},
    {"name": "Microchip", "tier": "fast", "platform": "workday",
     "url": "https://microchiphr.wd5.myworkdayjobs.com/external"},
    {"name": "NXP", "tier": "fast", "platform": "workday",
     "url": "https://nxp.wd3.myworkdayjobs.com/careers"},
    {"name": "Silicon Labs", "tier": "fast", "platform": "workday",
     "url": "https://silabs.wd1.myworkdayjobs.com/siliconlabscareers"},
    {"name": "Texas Instruments", "tier": "fast", "platform": "oracle",
     "url": "https://edbz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX"},
    {"name": "Honeywell", "tier": "fast", "platform": "oracle",
     "url": "https://ibqbjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/Honeywell"},
    {"name": "Emerson Electric", "tier": "fast", "platform": "oracle",
     "url": "https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1"},
    {"name": "Western Digital", "tier": "fast", "platform": "smartrecruiters", "slug": "westerndigital"},
    {"name": "Axon", "tier": "fast", "platform": "greenhouse", "slug": "axon"},

    # --- slow tier: large/mega catalogs (~1,000+ roles company-wide) ---
    {
        "name": "Microsoft", "tier": "slow", "platform": "eightfold", "slug": "microsoft",
        "base_url": "https://apply.careers.microsoft.com", "domain": "microsoft.com",
        "job_url_host": "https://jobs.careers.microsoft.com",
    },
    {"name": "Amazon", "tier": "slow", "platform": "amazon"},
    {"name": "Apple", "tier": "slow", "platform": "apple"},
    {"name": "Google", "tier": "slow", "platform": "google"},
    {"name": "Meta", "tier": "slow", "platform": "meta"},
    {"name": "Tesla", "tier": "slow", "platform": "tesla"},
]

# Only notify on titles that look like an internship/co-op. \b keeps
# "intern" from matching inside "international". Tune this list as needed --
# e.g. add "new grad" once you want that signal too.
KEYWORDS = re.compile(r"\b(intern|internship|co-?op)\b", re.IGNORECASE)

PLATFORM_BUILDERS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "amazon": lambda c: AmazonScraper("amazon", include_descriptions=False),
    "apple": lambda c: AppleScraper("apple", include_descriptions=False),
    "google": lambda c: GoogleScraper("google", include_descriptions=False),
    "meta": lambda c: MetaScraper("meta", include_descriptions=False),
    "tesla": lambda c: TeslaScraper("tesla", include_descriptions=False),
    "eightfold": lambda c: EightfoldScraper(
        c["slug"],
        include_descriptions=False,
        base_url=c.get("base_url"),
        domain=c.get("domain"),
        company_name=c.get("company_name"),
        job_url_host=c.get("job_url_host"),
    ),
    "workday": lambda c: WorkdayScraper.from_url(
        c["url"], company_name=c["name"], include_descriptions=False
    ),
    "oracle": lambda c: OracleScraper(
        c["url"], company_name=c["name"], include_descriptions=False
    ),
    "smartrecruiters": lambda c: SmartRecruitersScraper(c["slug"], include_descriptions=False),
    "greenhouse": lambda c: GreenhouseScraper(c["slug"], include_descriptions=False),
}


def load_state(path: Path) -> dict[str, list[str]]:
    if path.exists():
        return json.loads(path.read_text())
    return {}


def save_state(path: Path, state: dict[str, list[str]]) -> None:
    path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")


def send_telegram(token: str, chat_id: str, text: str) -> None:
    resp = requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": False,
        },
        timeout=15,
    )
    if not resp.ok:
        print(f"  [telegram error] {resp.status_code}: {resp.text[:200]}", file=sys.stderr)


def canonical_url(platform: str, job: Any) -> str:
    """Some platforms' raw APIs occasionally return an internal or
    malformed URL instead of the public listing link. Amazon confirmed
    2026-08: its `urlNextStep` field sometimes returns an internal
    apply-flow URL (account.amazon.com/jobs/{id}/apply) that doesn't
    resolve, instead of the public listing. The reliably-working format,
    verified against real postings, is the plain ID-based public URL --
    rebuild it from the job ID rather than trust the raw field. Extend
    this dict if other platforms show the same issue.
    """
    overrides = {
        "amazon": lambda j: f"https://www.amazon.jobs/en/jobs/{j.ats_id}",
    }
    fix = overrides.get(platform)
    return fix(job) if fix else job.url


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tier", choices=["fast", "slow"], required=True)
    args = parser.parse_args()

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        sys.exit("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set")

    state_path = Path(f"state_{args.tier}.json")
    state = load_state(state_path)
    companies = [c for c in COMPANIES if c["tier"] == args.tier]

    total_new = 0
    for company in companies:
        name = company["name"]
        builder = PLATFORM_BUILDERS[company["platform"]]
        seen = set(state.get(name, []))
        try:
            jobs = builder(company).fetch()
        except Exception as exc:  # one bad tenant should never kill the whole run
            print(f"  [{name}] fetch failed: {exc}", file=sys.stderr)
            continue

        relevant = [j for j in jobs if KEYWORDS.search(j.title or "")]
        current_ids = {j.ats_id for j in relevant}
        new_ids = current_ids - seen

        for job in relevant:
            if job.ats_id in new_ids:
                total_new += 1
                url = canonical_url(company["platform"], job)
                msg = f"\U0001f195 <b>{name}</b>: {job.title}\n{job.location or ''}\n{url}"
                send_telegram(token, chat_id, msg)

        state[name] = sorted(current_ids)
        print(f"  [{name}] {len(relevant)} intern/co-op postings, {len(new_ids)} new")

    save_state(state_path, state)
    print(f"Done. {total_new} new postings sent to Telegram.")


if __name__ == "__main__":
    main()
