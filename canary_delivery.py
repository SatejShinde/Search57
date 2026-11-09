"""One pinned REAL internship; no catalog fetch, production queue/state, or git writes.

Live sending is allowed only by explicit manual Actions dispatch. Artifacts are
temporary canary receipts, not a permanent description store. Never log secrets.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import re

from description_delivery import (bounded_retrieve, deliver, enqueue, save,
                                  send_plain, DeliveryError)
from telegram_jobs import digest, job_key, messages, decode, units
from telegram_export import inspect_export

ROOT = Path(__file__).resolve().parent
PROTECTED = ("state_fast.json", "state_slow.json", "pending_fast.json", "pending_slow.json")


def protected_hashes():
    import hashlib
    return {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() if (ROOT/name).exists() else None
            for name in PROTECTED}


def authorize(env):
    if not (env.get("GITHUB_ACTIONS") == "true"
            and env.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and env.get("SEARCH57_CANARY_SEND") == "true"
            and env.get("GITHUB_RUN_ATTEMPT") == "1"
            and env.get("GITHUB_REF") == "refs/heads/codex/telegram-job-descriptions"
            and re.fullmatch(r"[0-9]+", env.get("GITHUB_RUN_ID", ""))):
        raise DeliveryError("Canary requires explicit first-attempt manual review-branch dispatch")
    if not env.get("TELEGRAM_BOT_TOKEN") or not env.get("TELEGRAM_CHAT_ID"):
        raise DeliveryError("Canary credentials missing")


def run_canary(*, send=False, env=None, retrieve_fn=bounded_retrieve, transport=send_plain):
    env = env or os.environ
    if send:
        authorize(env)
    run_id = env.get("GITHUB_RUN_ID", "preview") if send else "preview"
    output = ROOT/".runtime"/"canary"/run_id
    if send and output.exists():
        raise DeliveryError("Canary output already exists; refusing an accidental replay")
    output.mkdir(parents=True, exist_ok=True)
    before = protected_hashes()
    config = json.loads((ROOT/"canary_job.json").read_text(encoding="utf-8"))
    from ats_scrapers.models import Job
    job = Job.model_validate(config["job"])
    queue = {}; cache = {}
    original_key = enqueue(queue, config["company"], job, str(job.url), cache)
    entry = queue.pop(original_key)
    entry["record"].update(canary=True, canary_id=run_id)
    key = job_key(entry["record"])
    # The structured description job header itself is the canary notification.
    # No unlabelled legacy alert, and no other queue can ever be loaded here.
    entry["alert_sent"] = True
    queue[key] = entry
    detail = retrieve_fn(entry, "", 25)
    if detail["status"] != "available" or not detail["text"].strip():
        raise DeliveryError("Pinned live description unavailable/partial; nothing sent")
    wires = messages(entry["record"], detail["text"], detail["status"], detail["note"])
    assert all(decode(w)[0].get("canary") for w in wires)
    assert all(units(w) <= 4096 for w in wires)
    receipts = []
    acknowledged = {}
    summary = dict(mode="live canary" if send else "retrieval-only preview", job_key=key,
                   company=job.company, title=job.title, ats_id=job.ats_id, url=str(job.url),
                   sha256=digest(detail["text"]), description_characters=len(detail["text"]),
                   expected_messages=len(wires), description_parts=decode(wires[0])[0]["parts"],
                   confirmed_messages=0, checkpoint_complete=False, parser_validation=False,
                   desktop_export_validation="pending user export", production_state_unchanged=True)
    save(output/"report.json", summary)
    if not send:
        if before != protected_hashes():
            raise DeliveryError("Protected state changed unexpectedly")
        return summary

    def checkpoint(value):
        for pending in value.values():
            acknowledged.update(pending.get("acks", {}))
        save(output/"checkpoint.json", {"pending": value, "acknowledged": acknowledged,
                                        "complete": not value})

    def sender(text, deadline):
        def receipt(message_id, echo):
            receipts.append(dict(id=message_id, type="message", text=echo))
            # Store only returned message text and IDs, never chat/user/token data.
            save(output/"telegram-api-receipts.json", {"source": "Telegram Bot API response echoes, not a Desktop export",
                                                       "messages": receipts})
            if echo != text:
                raise DeliveryError("Telegram response echo differs from submitted message")
        return transport(env["TELEGRAM_BOT_TOKEN"], env["TELEGRAM_CHAT_ID"], text,
                         deadline=deadline, receipt=receipt)

    try:
        # Production retrieval already ran once. Freeze its real result for this
        # single transfer; production multipart sender and checkpoint code remain
        # exactly the same, with max_jobs=1 and a fresh one-entry in-memory queue.
        checkpoint(queue)
        deliver(queue, {}, checkpoint, sender, lambda *args: detail, seconds=180, max_jobs=1)
        rows, errors = inspect_export(output/"telegram-api-receipts.json", key, include_canary=True) if receipts else ([], [])
        summary.update(confirmed_messages=len(receipts), message_ids=[r["id"] for r in receipts],
                       checkpoint_complete=not queue and len(acknowledged) == len(wires),
                       parser_validation=(not errors and len(rows) == 1 and
                                          rows[0]["delivery_status"] == "complete" and
                                          rows[0].get("description") == detail["text"]),
                       unique_message_ids=len({r["id"] for r in receipts}) == len(receipts),
                       wire_sequence_valid=[digest(r["text"]) for r in receipts] == [digest(w) for w in wires])
        def no_replay(*args):
            raise AssertionError("Completed queue attempted replay")
        deliver(queue, {}, checkpoint, no_replay, lambda *args: detail, seconds=180, max_jobs=1)
        summary["completed_checkpoint_no_replay"] = not queue
        summary["success"] = (summary["checkpoint_complete"] and summary["parser_validation"]
                              and summary["unique_message_ids"] and summary["wire_sequence_valid"])
        if not summary["success"]:
            raise DeliveryError("Canary incomplete; inspect temporary checkpoint and receipt artifacts")
    finally:
        summary["production_state_unchanged"] = before == protected_hashes()
        save(output/"report.json", summary)
    if not summary["production_state_unchanged"]:
        raise DeliveryError("Protected state changed unexpectedly")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--send", action="store_true")
    args = parser.parse_args()
    try:
        report = run_canary(send=args.send)
        print(json.dumps(report, indent=2))
    except Exception as exc:
        # Never emit provider/request exception strings (possibly token-bearing).
        raise SystemExit("Canary failed safely: " + type(exc).__name__)


if __name__ == "__main__":
    main()
