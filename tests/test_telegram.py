import copy
import io
import json
from pathlib import Path
import subprocess
import tempfile
import os
import sys
import unittest
from unittest.mock import patch, Mock

import requests

import check_jobs
import description_delivery as delivery
from telegram_jobs import decode, digest, frame, job_key, messages, units
from telegram_export import inspect_export, iter_messages, check_applications


RECORD = dict(company="Fixture & Co", title="Firmware <Intern> 🧪", location="Davis, CA",
              platform="workday", ats_id="R123@Davis", requisition_id="R123", url="https://fixture.wd1.myworkdayjobs.com/en-US/jobs/job/Davis/Intern_R123")


class ProtocolTests(unittest.TestCase):
    def export(self, wires, selected=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"result.json"
            # Real Desktop rich-text shape with separate text/link entities.
            path.write_text(json.dumps({"messages": [dict(id=i, text=[{"type":"plain", "text":w}])
                                                       for i,w in enumerate(wires)]}), encoding="utf-8")
            return inspect_export(path, selected)

    def test_short_combined_and_plain_html(self):
        wires = messages(RECORD, "C++ <b>not markup</b> & UART 🧪", "available")
        self.assertEqual(len(wires), 1)
        self.assertIn("Fixture & Co — Firmware <Intern>", wires[0])
        rows, errors = self.export(wires, job_key(RECORD))
        self.assertFalse(errors)
        self.assertEqual(rows[0]["description"], "C++ <b>not markup</b> & UART 🧪")
        self.assertEqual(rows[0]["delivery_status"], "complete")

    def test_long_roundtrip_out_of_order_duplicate(self):
        text = "Embedded 🧪 C++\n[Description]\n[/Search57]\n" * 2000
        wires = messages(RECORD, text, "available")
        self.assertGreater(len(wires), 2)
        self.assertTrue(all(units(w) <= 4096 for w in wires))
        rows, errors = self.export(list(reversed(wires)) + wires, job_key(RECORD))
        self.assertFalse(errors)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["description"], text)

    def test_missing_chunk_and_missing_commit(self):
        wires = messages(RECORD, "x"*9000, "available")
        for broken in (wires[:2] + wires[3:], wires[:-1], wires[1:]):
            rows, _ = self.export(broken)
            self.assertEqual(rows[0]["delivery_status"], "incomplete")

    def test_corrupt_and_conflicting_chunk(self):
        wires = messages(RECORD, "x"*9000, "available")
        meta, body = decode(wires[1])
        altered = frame(meta, "BAD"+body[3:])
        for bad in ([wires[0], altered] + wires[2:], wires + [altered]):
            rows, _ = self.export(bad)
            self.assertEqual(rows[0]["delivery_status"], "incomplete")

    def test_unavailable_and_failed(self):
        for status in ("failed", "unavailable"):
            rows, _ = self.export(messages(RECORD, "", status))
            self.assertEqual(rows[0]["description_status"], status)
            self.assertEqual(rows[0]["parts_expected"], 0)
            self.assertEqual(rows[0]["delivery_status"], "complete")

    def test_legacy_and_structured_dedupe(self):
        legacy = f"🆕 Fixture & Co: Firmware Intern\nDavis, CA\n{RECORD['url']}"
        rows, _ = self.export([legacy, legacy])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["description_status"], "legacy_unavailable")
        rows, _ = self.export([legacy] + messages(RECORD, "Full body", "available"))
        self.assertEqual(len(rows), 1)

    def test_title_url_only_legacy(self):
        rows, _ = self.export(["Firmware Intern\nhttps://www.amazon.jobs/en/jobs/12345"])
        self.assertEqual(rows[0]["ats_id"], "12345")
        self.assertEqual(rows[0]["description_status"], "legacy_unavailable")

    def test_location_variants_same_key_and_distinct_company(self):
        self.assertEqual(job_key(RECORD), job_key({**RECORD, "location":"Austin, TX", "ats_id":"R123@Austin"}))
        self.assertNotEqual(job_key(RECORD), job_key({**RECORD, "company":"Different Co"}))
        rows, _ = self.export(messages(RECORD,"Body","available") +
                              messages({**RECORD,"location":"Austin, TX","ats_id":"R123@Austin"},"Body","available"))
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]["delivery_status"],"complete")

    def test_revisions_never_mix(self):
        a = messages(RECORD, "a"*9000, "available")
        b = messages(RECORD, "b"*9000, "available")
        rows, _ = self.export(a[:2] + a[-1:] + b[:1] + b[2:])
        self.assertEqual(rows[0]["delivery_status"], "incomplete")

    def test_complete_revision_retained_but_partial_retry_reported(self):
        good=messages(RECORD,"Complete older body","available")
        newer=messages(RECORD,"New revision "*1000,"available")
        rows, _=self.export(good+newer[1:2],job_key(RECORD))
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]["description"],"Complete older body")
        self.assertIn("1 incomplete transfer",rows[0]["note"])

    def test_index_omits_bodies(self):
        rows, _ = self.export(messages(RECORD, "PRIVATE BODY", "available"))
        self.assertNotIn("description", rows[0])
        self.assertNotIn("PRIVATE BODY", json.dumps(rows))

    def test_metadata_delimiters_and_multiline_title_are_data(self):
        record={**RECORD,"title":"Intern\n[Description]\n[Record]\n[/Search57]"}
        rows, errors=self.export(messages(record,"Body","available"))
        self.assertFalse(errors)
        self.assertEqual(rows[0]["title"],record["title"])
        self.assertEqual(rows[0]["delivery_status"],"complete")

    def test_streaming_all_chats_and_large_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"result.json"
            data = {"about":"messages: [not structural]"*5000, "chats":{"list":[{"messages":[{"id":1,"text":"x"*100000}]},{"messages":[{"id":2,"text":"ok"}]}]}}
            path.write_text(json.dumps(data), encoding="utf-8")
            self.assertEqual([m["id"] for m in iter_messages(path)], [1,2])


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(delivery.time,"sleep")
        patcher.start(); self.addCleanup(patcher.stop)
    def entry(self):
        return {"record":RECORD, "company":{"platform":"workday", "name":"Fixture & Co", "url":"https://fixture.wd1.myworkdayjobs.com/jobs"},
                "job":{}, "alert_sent":True, "acks":{}, "attempts":0}

    def test_partial_delivery_resume_no_false_success(self):
        key = job_key(RECORD); queue = {key:self.entry()}; checkpoints=[]; sent=[]
        def send(text, deadline):
            sent.append(text)
            if len(sent) == 3:
                raise delivery.DeliveryError("synthetic failure")
            return len(sent)
        detail = lambda *args: dict(text="x"*9000,status="available",note="fixture")
        with patch.object(delivery.time, "sleep"):
            delivery.deliver(queue, {}, lambda q: checkpoints.append(copy.deepcopy(q)), send, detail)
            self.assertIn(key, queue)
            self.assertEqual(len(queue[key]["acks"]), 2)
            first = sent[:2]; sent.clear()
            delivery.deliver(queue, {}, lambda q: None, lambda t,d: sent.append(t) or 99, detail)
        self.assertFalse(queue)
        self.assertTrue(all(t not in first for t in sent))

    def test_retrieval_failure_still_sends_status(self):
        key=job_key(RECORD); entry=self.entry(); entry["alert_sent"]=False; queue={key:entry}; sent=[]
        detail=lambda *a: dict(text="",status="failed",note="timeout")
        delivery.deliver(queue, {}, lambda q:None, lambda t,d:sent.append(t) or 1, detail)
        self.assertFalse(queue)
        self.assertTrue(sent[0].startswith("🆕"))
        self.assertEqual(decode(sent[1])[0]["status"], "failed")

    def test_request_exception_does_not_block_other_jobs(self):
        a=self.entry(); b=self.entry(); b["record"]={**RECORD,"requisition_id":"R456"}
        queue={job_key(RECORD):a,job_key(b["record"]):b}
        def retrieve(e,*args):
            if e is a: raise RuntimeError("failure")
            return dict(text="",status="unavailable",note="")
        delivery.deliver(queue, {}, lambda q:None, lambda *a:1, retrieve)
        self.assertEqual(len(queue),1)

    def test_rate_limit_transient_timeout_and_plain_text(self):
        response=lambda code,body:Mock(ok=code==200,status_code=code,json=lambda:body)
        post=Mock(side_effect=[response(429,{"error_code":429,"parameters":{"retry_after":2}}),
                               response(500,{}),response(200,{"ok":True,"result":{"message_id":77}})])
        self.assertEqual(delivery.send_plain("secret","chat","a < b & c",post=post,sleep=lambda _:None),77)
        self.assertNotIn("parse_mode",post.call_args.kwargs["json"])
        post=Mock(side_effect=requests.Timeout("secret-url"))
        with self.assertRaises(delivery.DeliveryError) as caught:
            delivery.send_plain("secret","chat","body",post=post,sleep=lambda _:None)
        self.assertNotIn("secret",str(caught.exception))
        self.assertEqual(post.call_count,3)

    def test_bounded_worker_timeout_preserves_listing(self):
        with patch.object(delivery.subprocess,"run",side_effect=subprocess.TimeoutExpired("worker",1)):
            self.assertEqual(delivery.bounded_retrieve({},"summary",1)["status"],"partial")
            self.assertEqual(delivery.bounded_retrieve({},"",1)["status"],"failed")

    def test_listing_reuse_no_network_or_fetch(self):
        entry=self.entry(); entry["job"]={**RECORD, "ats_type":"workday", "company":RECORD["company"]}
        with patch.dict(check_jobs.PLATFORM_BUILDERS, {"workday":Mock(side_effect=AssertionError("No network"))}):
            result=delivery.retrieve({**entry,"listing":"verified full listing body"})
        self.assertEqual(result["text"],"verified full listing body")

    def test_targeted_one_job_and_cap_status(self):
        entry=self.entry(); entry["job"]={**RECORD,"ats_type":"workday"}
        from ats_scrapers.scrapers.base import BaseScraper
        class Scraper(BaseScraper):
            async def afetch(self): raise AssertionError("No catalogs")
            def get_description(self,job):
                self.called=job.ats_id; return "x"*25000
        scraper=Scraper("fixture",include_descriptions=False)
        with patch.dict(check_jobs.PLATFORM_BUILDERS,{"workday":lambda c:scraper}):
            result=delivery.retrieve(entry)
        self.assertEqual(scraper.called,RECORD["ats_id"])
        self.assertEqual(result["status"],"partial")

    def test_no_descriptions_in_persistent_queue(self):
        from types import SimpleNamespace
        job=SimpleNamespace(**{**RECORD,"description":"PRIVATE FULL BODY","raw":{"description":"PRIVATE FULL BODY"}})
        queue={}; cache={}
        key=delivery.enqueue(queue,{"name":"Fixture & Co","platform":"workday"},job,job.url,cache)
        self.assertNotIn("PRIVATE FULL BODY",json.dumps(queue))
        self.assertEqual(cache[key],"PRIVATE FULL BODY")

    def test_apple_and_oracle_summaries_trigger_single_detail(self):
        from ats_scrapers.scrapers.base import BaseScraper
        from ats_scrapers.scrapers import apple
        entry=self.entry(); entry["job"]={**RECORD,"ats_type":"oracle"}
        class Scraper(BaseScraper):
            async def afetch(self): raise AssertionError("No catalog")
            def get_description(self,job):
                if job.description: raise AssertionError("Summary must be cleared")
                return "Full responsibilities and qualifications"
        with patch.dict(check_jobs.PLATFORM_BUILDERS,{"oracle":lambda c:Scraper("fixture",include_descriptions=False)}):
            entry["company"]["platform"]="oracle"
            self.assertEqual(delivery.retrieve({**entry,"listing":"Short summary"})["status"],"available")
        entry["company"]["platform"]="apple"; entry["job"]["ats_type"]="apple"
        async def enrich(jobs,*args):
            self.assertEqual(len(jobs),1); jobs[0].description="Full Apple description"
        with patch.object(apple,"_enrich_apple_details",enrich):
            self.assertEqual(delivery.retrieve({**entry,"listing":"Short Apple summary"})["text"],"Full Apple description")

    def test_html_normalization_and_upstream_cap_not_hidden(self):
        result=delivery.result("<p>Responsibilities &amp; skills</p><ul><li>C++</li></ul>","listing","greenhouse")
        self.assertIn("Responsibilities & skills",result["text"])
        self.assertNotIn("<p>",result["text"])
        result=delivery.result("<div>"+"x"*24989+"</div>","listing","greenhouse")
        self.assertEqual(result["status"],"partial")

    def test_all_existing_providers_have_targeted_path(self):
        from ats_scrapers.models import Job
        from ats_scrapers.scrapers.base import BaseScraper
        for company in check_jobs.COMPANIES:
            scraper=check_jobs.PLATFORM_BUILDERS[company["platform"]](company)
            self.assertFalse(scraper.include_descriptions)
            self.assertTrue(callable(scraper.get_description))
            self.assertTrue(type(scraper).get_description is not BaseScraper.get_description or
                            company["platform"] in {"amazon","apple","greenhouse"})

    def test_amazon_location_url_uses_requisition(self):
        from types import SimpleNamespace
        self.assertEqual(check_jobs.canonical_url("amazon",SimpleNamespace(ats_id="123@loc2",requisition_id="123")),
                         "https://www.amazon.jobs/en/jobs/123")

    def test_tracker_read_only_calls(self):
        from types import SimpleNamespace
        rows=[{**RECORD}]
        tracker=SimpleNamespace(read_database=Mock(return_value=["history"]),
                                check_job=Mock(return_value={"decision":"skip_duplicate"}))
        with patch.dict(sys.modules,{"application_tracker":tracker}):
            check_applications(rows,"db.csv")
        self.assertEqual(rows[0]["application_decision"],"skip_duplicate")
        tracker.read_database.assert_called_once_with("db.csv")
        tracker.check_job.assert_called_once()

    def test_scan_notifications_unchanged_and_no_detail_calls(self):
        from types import SimpleNamespace
        company={"name":"Fixture", "platform":"workday", "tier":"fast"}
        jobs=[SimpleNamespace(title=t,location=l,ats_id=str(i),url="https://example.com/jobs/"+str(i),description=None)
              for i,(t,l) in enumerate([("Firmware Intern","CA"),("PhD Research Intern","CA"),
                                       ("Marketing Co-op","MA"),("Senior Engineer","CA"),("Intern","Bangalore, IN")])]
        builder=Mock(return_value=SimpleNamespace(fetch=Mock(return_value=jobs)))
        for enabled in (False,True):
            with tempfile.TemporaryDirectory() as directory:
                previous=os.getcwd()
                try:
                    os.chdir(directory)
                    with patch.dict(os.environ,{"TELEGRAM_BOT_TOKEN":"fixture","TELEGRAM_CHAT_ID":"fixture",
                                               "SEARCH57_DESCRIPTIONS_ENABLED":"true" if enabled else "false"}), \
                         patch.object(sys,"argv",["check_jobs.py","--tier","fast"]), \
                         patch.object(check_jobs,"COMPANIES",[company]), \
                         patch.dict(check_jobs.PLATFORM_BUILDERS,{"workday":builder}), \
                         patch.object(check_jobs,"send_plain",return_value=1) as plain, \
                         patch.object(check_jobs,"send_telegram") as legacy, \
                         patch.object(delivery,"bounded_retrieve",side_effect=AssertionError("No detail in scan")):
                        check_jobs.main()
                        sender=plain if enabled else legacy
                        self.assertEqual(sender.call_count,3)
                        self.assertEqual(json.loads(Path("state_fast.json").read_text())["Fixture"],["0","1","2"])
                        if enabled:
                            check_jobs.main()
                            self.assertEqual(sender.call_count,3)
                finally: os.chdir(previous)


class SelectionRegressionTests(unittest.TestCase):
    def test_selection_and_builders_identical_to_original(self):
        # Frozen original source from the baseline commit, not a mirror of the
        # implementation: changes to ANY filter/config/builder fail this test.
        fixture=Path(__file__).parent/"fixtures/original_selection.json"
        baseline=json.loads(fixture.read_text())
        import ast
        tree=ast.parse(Path(check_jobs.__file__).read_text(encoding="utf-8"))
        selected={}
        names=set(baseline)
        for node in tree.body:
            name=(node.name if isinstance(node,ast.FunctionDef) else
                  node.targets[0].id if isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Name) else
                  node.target.id if isinstance(node,ast.AnnAssign) and isinstance(node.target,ast.Name) else "")
            if name in names: selected[name]=ast.dump(node,include_attributes=False)
        self.assertEqual(selected,baseline)

    def test_representative_original_filters(self):
        cases=[("Firmware Intern","Davis, CA",True),("Research PhD Intern","US, CA",True),
               ("Business Co-op","Boston, MA",True),("International Sales","Davis, CA",False),
               ("Intern","Bangalore, IN",False),("Intern","Remote - India",False),
               ("Intern","Remote",True),("Coop","USA",True),("Intern",None,False)]
        for title,loc,want in cases:
            self.assertEqual(bool(check_jobs.KEYWORDS.search(title) and check_jobs.is_us_location(loc)),want)


if __name__ == "__main__":
    unittest.main()
