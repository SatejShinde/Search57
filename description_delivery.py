"""Bounded, resumable Telegram follow-up. Pending state contains NO descriptions.

Listing descriptions travel in expiring Actions artifacts, not git history. Only
pending identity/retry/ack metadata is committed. Telegram is the durable store.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time

import requests

from telegram_jobs import job_key, units


def save(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(path)


def load(path):
    path = Path(path)
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


class DeliveryError(Exception):
    pass


def send_plain(token, chat_id, text, *, deadline=None, post=None, sleep=time.sleep, receipt=None):
    """Retries are bounded; timeout ambiguity may duplicate a wire identity, never
    imply success. No tokens, URLs containing tokens, or response bodies logged.
    """
    if units(text) > 4096:
        raise DeliveryError("Message too large")
    post = post or requests.post
    deadline = deadline or time.monotonic() + 55
    for attempt in range(3):
        remaining = deadline - time.monotonic()
        if remaining < 1:
            break
        wait = 2 ** attempt
        try:
            response = post(f"https://api.telegram.org/bot{token}/sendMessage",
                            json={"chat_id": chat_id, "text": text,
                                  "disable_web_page_preview": True},
                            timeout=min(15, remaining))
            try:
                body = response.json()
            except ValueError:
                body = {}
            if response.ok and body.get("ok") is True and body.get("result", {}).get("message_id"):
                if receipt:
                    receipt(body["result"]["message_id"], body["result"].get("text"))
                return body["result"]["message_id"]
            code = body.get("error_code", response.status_code)
            if code == 429:
                wait = max(1, float(body.get("parameters", {}).get("retry_after", 1)))
            elif code < 500:
                raise DeliveryError(f"Telegram rejected message ({code})")
        except requests.RequestException:
            pass
        if attempt == 2 or time.monotonic() + wait + 1 >= deadline:
            break
        sleep(wait)
    raise DeliveryError("Telegram delivery unconfirmed; pending for retry")


def make_record(company, job, url):
    record = {"company": company["name"], "title": job.title,
            "location": job.location or "", "platform": company["platform"],
            "ats_id": str(job.ats_id or ""),
            "requisition_id": str(getattr(job, "requisition_id", None) or ""), "url": str(url)}
    if company['platform']=='oracle' and '/job/' not in str(url):
        from urllib.parse import urlsplit
        site=urlsplit(company.get('url',''))
        native=str(job.ats_id or '').split(':')[-1].split('@')[0]
        if site.scheme=='https' and '/CandidateExperience/' in site.path and native.isdigit():
            record['direct_url']=f'{site.scheme}://{site.netloc}{site.path.rstrip("/")}/job/{native}'
    return record


def enqueue(queue, company, job, url, cache):
    record = make_record(company, job, url)
    key = job_key(record)
    # Only the fields required for targeted detail retrieval. Never persist raw
    # payloads: some providers embed whole description bodies inside raw.
    wire_job = {"title": job.title, "company": company["name"], "ats_type": company["platform"],
                "ats_id": job.ats_id, "url": str(url), "location": job.location,
                "requisition_id": record["requisition_id"] or None}
    queue.setdefault(key, {"record": record, "company": company, "job": wire_job,
                           "alert_sent": False, "acks": {}, "attempts": 0})
    if job.description:
        text = job.description
        # Amazon exposes qualifications beside, rather than inside, the body.
        # Preserve those already-returned fields without putting them in git.
        if company["platform"] == "amazon":
            for field, label in (("basic_qualifications", "Basic qualifications"),
                                 ("preferred_qualifications", "Preferred qualifications")):
                value = (getattr(job, "raw", None) or {}).get(field)
                if isinstance(value, str) and value.strip() and value not in text:
                    text += f"\n\n{label}\n{value}"
        cache[key] = text
        # Already-returned full text is protected before any Telegram request.
        from archive_bridge import capture_detail
        cached=result(text,'listing',company['platform'])
        if company['platform'] in {'apple','oracle'}:cached['status']='partial'
        capture_detail(queue[key],cached)
    return key


def retrieve(payload):
    """Child process entry point: at most ONE selected posting, never fetch()."""
    from ats_scrapers.models import Job
    from ats_scrapers.scrapers.base import BaseScraper
    from check_jobs import PLATFORM_BUILDERS
    company = payload["company"]
    platform = company["platform"]
    job = Job.model_validate(payload["job"])
    listing = payload.get("listing") or ""
    # Apple jobSummary and Oracle ShortDescriptionStr are NOT full JDs.
    summary_provider = platform in {"apple", "oracle"}
    if listing and not summary_provider and not (platform == "amazon" and len(listing) < 500):
        return result(listing, "listing", platform)
    if platform in {"lever", "ashby"}:
        from ats_scrapers.scrapers import LeverScraper, AshbyScraper
        cls = LeverScraper if platform == "lever" else AshbyScraper
        scraper = cls(company["slug"], include_descriptions=False)
    else:
        scraper = PLATFORM_BUILDERS[platform](company)
    scraper.timeout = 12
    text = None
    if platform == "apple":
        # v0.3.0 exposes only its bounded batch helper; pass exactly ONE job.
        from ats_scrapers.scrapers.apple import _enrich_apple_details
        scraper._run_sync(_enrich_apple_details([job], 12))
        text = job.description
    elif type(scraper).get_description is not BaseScraper.get_description:
        text = scraper.get_description(job)
    else:
        # No targeted library override (Amazon/Greenhouse). Single posting
        # fallback; never invoke fetch/enrich_descriptions for a company.
        from bs4 import BeautifulSoup
        if platform == "greenhouse":
            from ats_scrapers.scrapers.greenhouse import _clean_description
            url = f"https://boards-api.greenhouse.io/v1/boards/{company['slug']}/jobs/{job.ats_id}"
            response = requests.get(url, timeout=12)
            response.raise_for_status()
            text = _clean_description(response.json().get("content"))
        else:
            response = requests.get(str(job.url), timeout=12)
            response.raise_for_status()
            soup = BeautifulSoup(response.text, "html.parser")
            for node in soup.find_all("script", type="application/ld+json"):
                try:
                    values = json.loads(node.string or node.get_text())
                except ValueError:
                    continue
                stack = values if isinstance(values, list) else [values]
                while stack:
                    obj = stack.pop()
                    if not isinstance(obj, dict):
                        continue
                    stack.extend(obj.get("@graph", []))
                    if "JobPosting" in obj.get("@type", []) and obj.get("description"):
                        text = BeautifulSoup(obj["description"], "html.parser").get_text("\n")
    if text:
        return result(text, "targeted", platform)
    if listing:
        return {"text": plain_description(listing), "status": "partial", "note": "Listing summary only; full detail unavailable"}
    return {"text": "", "status": "unavailable", "note": "Provider returned no targeted description"}


def result(text, source, platform):
    limitations = []
    if len(text) >= 25000:
        limitations.append("Possible upstream 25,000-character cap; full source completeness unverified")
    if platform == "google":
        limitations.append("Scraper may return meta-description fallback; full source completeness unverified")
    return {"text": plain_description(text), "status": "partial" if limitations else "available",
            "note": f"Source: {source}; completeness not independently verified" +
                    ("; " + "; ".join(limitations) if limitations else "")}


def plain_description(text):
    # Scraper 0.3.0 intentionally leaves HTML for a later normalization stage.
    # Convert semantic content to readable plain text, never shorten it.
    if re.search(r"</?(?:p|div|li|ul|ol|br|h[1-6]|section|strong|span)\b", text, re.I):
        from bs4 import BeautifulSoup
        import html
        soup = BeautifulSoup(html.unescape(text), "html.parser")
        for node in soup(["script", "style"]):
            node.decompose()
        return re.sub(r"\n{3,}", "\n\n", soup.get_text("\n")).strip()
    return text


def bounded_retrieve(entry, listing, seconds):
    try:
        completed = subprocess.run([sys.executable, __file__, "--retrieve-one"],
                                   input=json.dumps({**entry, "listing": listing}),
                                   text=True, encoding="utf-8", capture_output=True,
                                   env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                                   timeout=seconds, check=True)
        return json.loads(completed.stdout)
    except (subprocess.SubprocessError, ValueError):
        if listing:
            return {"text": plain_description(listing), "status": "partial", "note": "Targeted request failed/timed out; listing text only"}
        return {"text": "", "status": "failed", "note": "Targeted request failed/timed out"}


def deliver(queue, cache, checkpoint, send, retrieve_fn=bounded_retrieve, *, seconds=240, max_jobs=12, archive_fn=None, retain_staged=False, allow_alerts=True):
    """Recover an unsent compact alert, then hand the full JD to the archive.

    No description formatter or multipart Telegram sender is reachable here.
    The encrypted outbox is durable before this extraction entry is retired.
    """
    from compact_alert import alert
    from archive_bridge import capture_detail,staged_detail
    archive_fn=archive_fn or capture_detail
    deadline=time.monotonic()+seconds;processed=0
    for key,entry in sorted(list(queue.items()),key=lambda pair:pair[1].get('last_attempt',0)):
        if processed>=max_jobs or deadline-time.monotonic()<40:break
        processed+=1;entry['attempts']+=1;entry['last_attempt']=time.time();checkpoint(queue)
        try:
            if not entry['alert_sent'] and allow_alerts:
                try:
                    send(alert(entry['record']),deadline);entry['alert_sent']=True;checkpoint(queue)
                except Exception as exc:
                    entry['alert_error']=type(exc).__name__;checkpoint(queue)
            staged=staged_detail(entry)
            if retain_staged and staged and staged.get('status')=='available':continue
            detail=staged if staged and staged.get('status')=='available' else retrieve_fn(entry,cache.get(key,''),min(25,deadline-time.monotonic()-10))
            if not archive_fn(entry,detail):raise DeliveryError('Archive staging unconfirmed; pending retained')
            entry['retrieval_status']=detail['status']
            if not retain_staged and entry['alert_sent']:del queue[key]
            checkpoint(queue)
        except Exception as exc:
            entry['last_error']=type(exc).__name__;checkpoint(queue)
    return processed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--retrieve-one", action="store_true")
    parser.add_argument("--tier", choices=["fast", "slow"])
    parser.add_argument("--send", "--process", dest="send", action="store_true", help="Process archive work and compact unsent-alert retries; never send descriptions")
    parser.add_argument("--wrapper-state", type=Path,
                        help="Startup digest state; queue is descriptionPending property")
    args = parser.parse_args()
    if args.retrieve_one:
        # Redirect verbose scraper stdout away from the JSON protocol.
        import contextlib
        with contextlib.redirect_stdout(sys.stderr):
            value = retrieve(json.load(sys.stdin))
        print(json.dumps(value)); return
    if not args.tier and not args.wrapper_state:
        parser.error("--tier required")
    path = args.wrapper_state or Path(f"pending_{args.tier}.json")
    state = load(path)
    queue = state.setdefault("descriptionPending", {}) if args.wrapper_state else state
    def checkpoint(q):
        save(path, state if args.wrapper_state else q)
    if not args.send:
        print(json.dumps({"mode": "no-send", "pending": len(queue)})); return
    if os.getenv("SEARCH57_DESCRIPTIONS_ENABLED") != "true":
        sys.exit("Archive description collection disabled")
    token = "" if args.wrapper_state else os.environ["TELEGRAM_BOT_TOKEN"]
    chat = "" if args.wrapper_state else os.environ["TELEGRAM_CHAT_ID"]
    cache = path.parent/"description-listings.json" if args.wrapper_state else Path(f".runtime/listings_{args.tier}.json")
    deliver(queue, load(cache), checkpoint,
            lambda text, deadline: send_plain(token, chat, text, deadline=deadline), retain_staged=bool(args.wrapper_state), allow_alerts=not bool(args.wrapper_state))
    print(json.dumps({"pending": len(queue), "complete": not queue}))
    if any(not e.get("archive_detail") or (not args.wrapper_state and not e['alert_sent']) for e in queue.values()):
        sys.exit(1)


if __name__ == "__main__":
    main()
