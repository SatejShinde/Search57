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

    def test_live_description_canary_is_permanently_retired(self):
        with self.assertRaisesRegex(delivery.DeliveryError,'retired'):
            canary.run_canary(send=True,env=ENV,retrieve_fn=self.retrieve,transport=self.transport)
        self.retrieve.assert_not_called();self.transport.assert_not_called()

    def test_retirement_applies_to_every_dispatch_or_branch(self):
        for overrides in ({},{'GITHUB_REF':'refs/heads/main'},{'GITHUB_RUN_ATTEMPT':'2'},{'SEARCH57_CANARY_SEND':'false'}):
            with self.assertRaisesRegex(delivery.DeliveryError,'retired'):
                canary.run_canary(send=True,env={**ENV,**overrides},retrieve_fn=self.retrieve,transport=self.transport)
        self.transport.assert_not_called()

    def test_historical_preview_never_sends_or_touches_production(self):
        before=canary.protected_hashes()
        result=canary.run_canary(send=False,env=ENV,retrieve_fn=self.retrieve,transport=self.transport)
        self.assertEqual(result['confirmed_messages'],0);self.transport.assert_not_called()
        self.assertEqual(before,canary.protected_hashes())

    def test_preview_unavailable_description_is_explicit(self):
        self.retrieve.return_value=dict(text='',status='unavailable',note='')
        with self.assertRaises(delivery.DeliveryError):canary.run_canary(send=False,env=ENV,retrieve_fn=self.retrieve,transport=self.transport)
        self.transport.assert_not_called()

    def test_historical_canary_wire_remains_offline_parseable(self):
        record=dict(company='Fixture',title='Intern',location='CA',platform='workday',ats_id='R1',url='https://example.com/job/1',canary=True,canary_id='fixture')
        wires=messages(record,'Historical fixture '*800,'available')
        path=self.root/'historical.json';path.write_text(json.dumps(dict(messages=[dict(id=i+1,text=w) for i,w in enumerate(wires)])),encoding='utf-8')
        self.assertEqual(inspect_export(path)[0],[])
        rows,errors=inspect_export(path,job_key(record),include_canary=True)
        self.assertFalse(errors);self.assertEqual(rows[0]['delivery_status'],'complete')
        self.assertEqual(rows[0]['description'],'Historical fixture '*800)

if __name__=='__main__':unittest.main()
