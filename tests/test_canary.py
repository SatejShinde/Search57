import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

import canary_delivery as canary
import description_delivery as delivery
from telegram_jobs import decode, job_key, messages
from telegram_export import inspect_export


ENV = dict(GITHUB_ACTIONS="true", GITHUB_EVENT_NAME="workflow_dispatch", SEARCH57_CANARY_SEND="true",
           GITHUB_RUN_ATTEMPT="1", GITHUB_REF="refs/heads/codex/telegram-job-descriptions", GITHUB_RUN_ID="123456",
           TELEGRAM_BOT_TOKEN="mock-only-token", TELEGRAM_CHAT_ID="mock-only-chat")


class CanaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root/"canary_job.json").write_bytes((canary.ROOT/"canary_job.json").read_bytes())
        for name in canary.PROTECTED:
            (self.root/name).write_text('{"production":"DO NOT TOUCH"}')
        patcher = patch.object(canary, "ROOT", self.root); patcher.start(); self.addCleanup(patcher.stop)
        patcher = patch.object(delivery.time, "sleep"); patcher.start(); self.addCleanup(patcher.stop)
        # Synthetic text is used ONLY inside mocked unit tests, never the live
        # canary. The real runner's pinned retriever has no synthetic fallback.
        self.detail = dict(text="MOCKED UNIT TEST ONLY — firmware responsibilities. "*200,
                           status="available", note="mocked fixture")
        self.retrieve = Mock(return_value=self.detail)
        self.sent = []
        def transport(token, chat, text, *, deadline, receipt):
            self.sent.append(text)
            message_id = len(self.sent)+100
            receipt(message_id, text)
            return message_id
        self.transport = Mock(side_effect=transport)

    def test_exactly_one_real_job_identity_and_full_multipart_pipeline(self):
        before=canary.protected_hashes()
        report=canary.run_canary(send=True, env=ENV, retrieve_fn=self.retrieve, transport=self.transport)
        self.assertTrue(report["success"])
        self.assertEqual(self.retrieve.call_count,1)
        self.assertEqual(self.retrieve.call_args.args[0]["job"]["ats_id"], "JR2023492")
        self.assertGreater(report["description_parts"],1)
        self.assertEqual(report["expected_messages"],len(self.sent))
        self.assertEqual(before,canary.protected_hashes())
        self.assertTrue(all("CANARY TEST" in wire and decode(wire)[0]["canary"] for wire in self.sent))
        checkpoint=json.loads((self.root/".runtime/canary/123456/checkpoint.json").read_text())
        self.assertTrue(checkpoint["complete"])
        self.assertFalse(checkpoint["pending"])
        self.assertEqual(len(checkpoint["acknowledged"]),len(self.sent))
        self.assertTrue(report["completed_checkpoint_no_replay"])

    def test_live_requires_manual_send_true_first_attempt_review_branch(self):
        for field,value in [("GITHUB_ACTIONS","false"),("GITHUB_EVENT_NAME","push"),
                            ("SEARCH57_CANARY_SEND","false"),("GITHUB_RUN_ATTEMPT","2"),
                            ("GITHUB_REF","refs/heads/main"),("TELEGRAM_BOT_TOKEN","")]:
            with self.assertRaises(delivery.DeliveryError):
                canary.run_canary(send=True,env={**ENV,field:value},retrieve_fn=self.retrieve,transport=self.transport)
        self.retrieve.assert_not_called(); self.transport.assert_not_called()

    def test_preview_never_sends_or_touches_production(self):
        before=canary.protected_hashes()
        report=canary.run_canary(send=False,env=ENV,retrieve_fn=self.retrieve,transport=self.transport)
        self.assertEqual(report["confirmed_messages"],0)
        self.transport.assert_not_called()
        self.assertEqual(before,canary.protected_hashes())

    def test_unavailable_retrieval_aborts_before_any_send(self):
        self.retrieve.return_value=dict(text="",status="unavailable",note="")
        with self.assertRaises(delivery.DeliveryError):
            canary.run_canary(send=True,env=ENV,retrieve_fn=self.retrieve,transport=self.transport)
        self.transport.assert_not_called()

    def test_delivery_failure_never_reports_complete(self):
        self.transport.side_effect=delivery.DeliveryError("mock failure")
        with self.assertRaises(delivery.DeliveryError):
            canary.run_canary(send=True,env=ENV,retrieve_fn=self.retrieve,transport=self.transport)
        report=json.loads((self.root/".runtime/canary/123456/report.json").read_text())
        self.assertFalse(report["checkpoint_complete"])
        self.assertTrue(report["production_state_unchanged"])

    def test_api_echo_mismatch_is_failure(self):
        def transport(token,chat,text,*,deadline,receipt):
            receipt(1,text[:-1]); return 1
        with self.assertRaises(delivery.DeliveryError):
            canary.run_canary(send=True,env=ENV,retrieve_fn=self.retrieve,transport=transport)

    def test_parser_excludes_canary_unless_explicitly_requested(self):
        report=canary.run_canary(send=True,env=ENV,retrieve_fn=self.retrieve,transport=self.transport)
        export=self.root/".runtime/canary/123456/telegram-api-receipts.json"
        rows, errors=inspect_export(export)
        self.assertFalse(rows); self.assertFalse(errors)
        rows, errors=inspect_export(export,report["job_key"],include_canary=True)
        self.assertEqual(rows[0]["description"],self.detail["text"])
        self.assertIn("CANARY TEST",rows[0]["note"])

    def test_canary_identity_is_scoped_away_from_production(self):
        record=dict(company="NVIDIA",platform="workday",requisition_id="JR2023492",url="https://example.com/job")
        self.assertNotEqual(job_key(record),job_key({**record,"canary":True,"canary_id":"123456"}))


if __name__ == "__main__":
    unittest.main()
