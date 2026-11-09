import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock

from persist_watcher_state import publish, authorize_action


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.previous=os.getcwd(); os.chdir(self.temp.name); self.addCleanup(os.chdir,self.previous)
        Path("pending_fast.json").write_text('{}')
        Path("state_fast.json").write_text('{"ids":["latest"]}')

    def runner(self, pushes=(0,), conflict=False, staged=""):
        calls=[]; remaining=list(pushes)
        def run(*args):
            calls.append(args)
            code=0; stdout=""
            if args==("diff","--cached","--name-only"): stdout=staged
            elif args==("diff","--cached","--quiet"): code=1
            elif args==("rebase","origin/main") and conflict: code=1
            elif args[:2]==("push","origin"): code=remaining.pop(0)
            return subprocess.CompletedProcess(args,code,stdout,"")
        return run,calls

    def test_cross_tier_push_race_retries_non_force(self):
        run,calls=self.runner(pushes=(1,0))
        publish("fast",run=run,sleep=lambda _:None)
        self.assertEqual(calls.count(("fetch","--no-tags","origin","main")),2)
        self.assertEqual(calls.count(("push","origin","HEAD:main")),2)
        self.assertEqual(next(c for c in calls if c[0]=="add"),("add","--","state_fast.json","pending_fast.json"))
        self.assertFalse(any("--force" in arg for call in calls for arg in call))

    def test_followup_only_stages_its_pending_file(self):
        run,calls=self.runner()
        publish("fast",followup=True,run=run)
        self.assertEqual(next(c for c in calls if c[0]=="add"),("add","--","pending_fast.json"))

    def test_conflict_aborts_without_remote_push(self):
        run,calls=self.runner(conflict=True)
        with self.assertRaisesRegex(RuntimeError,"remote state preserved"):
            publish("fast",run=run)
        self.assertIn(("rebase","--abort"),calls)
        self.assertFalse(any(c[0]=="push" for c in calls))

    def test_exhausted_retries_fail_and_never_force(self):
        run,calls=self.runner(pushes=(1,1,1))
        with self.assertRaisesRegex(RuntimeError,"three non-force"):
            publish("fast",run=run,sleep=lambda _:None)
        self.assertEqual(calls.count(("push","origin","HEAD:main")),3)

    def test_refuses_unrelated_staged_files(self):
        run,calls=self.runner(staged="private.txt\n")
        with self.assertRaisesRegex(RuntimeError,"Index not clean"):
            publish("fast",run=run)
        self.assertFalse(any(c[0]=="commit" for c in calls))

    def test_cli_refuses_local_and_feature_branch_production_pushes(self):
        for env in ({},{"GITHUB_ACTIONS":"true","GITHUB_REF":"refs/heads/codex/telegram-job-descriptions"}):
            with self.assertRaises(RuntimeError): authorize_action(env)
        authorize_action({"GITHUB_ACTIONS":"true","GITHUB_REF":"refs/heads/main"})

    def test_real_git_stale_slow_checkout_preserves_new_fast_state(self):
        def command(*args,cwd=None):
            return subprocess.run(["git",*args],cwd=cwd,check=True,capture_output=True,
                                  text=True,encoding="utf-8",timeout=20)
        base=Path.cwd(); remote=base/"remote.git"; seed=base/"seed"; fast=base/"fast"; slow=base/"slow"
        command("init","--bare",str(remote))
        command("init","-b","main",str(seed))
        command("config","user.name","test",cwd=seed); command("config","user.email","test@example.invalid",cwd=seed)
        for tier in ("fast","slow"):
            (seed/f"state_{tier}.json").write_text(json.dumps({tier:["baseline"]}))
        command("add",".",cwd=seed); command("commit","-m","baseline",cwd=seed)
        command("remote","add","origin",str(remote),cwd=seed); command("push","-u","origin","main",cwd=seed)
        command("clone","--branch","main",str(remote),str(fast))
        command("clone","--branch","main",str(remote),str(slow))
        os.chdir(fast)
        Path("state_fast.json").write_text(json.dumps({"fast":["new fast ID"]}))
        publish("fast")
        os.chdir(slow)
        Path("state_slow.json").write_text(json.dumps({"slow":["new slow ID"]}))
        publish("slow")
        latest_fast=json.loads(command("--git-dir",str(remote),"show","main:state_fast.json").stdout)
        latest_slow=json.loads(command("--git-dir",str(remote),"show","main:state_slow.json").stdout)
        self.assertEqual(latest_fast,{"fast":["new fast ID"]})
        self.assertEqual(latest_slow,{"slow":["new slow ID"]})
        os.chdir(base)


if __name__ == "__main__":
    unittest.main()
