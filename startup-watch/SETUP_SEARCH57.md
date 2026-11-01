# Install in Search57 and schedule with cron-job.org

This package uses the existing `SatejShinde/Search57` repository and Telegram bot. The startup workflow is triggered through `workflow_dispatch`. cron-job.org supplies the daily schedule; this new workflow contains no GitHub `schedule` trigger.

The filters now prioritize demonstrated embedded firmware, sensor/electronics testing, PLC/controls, instrumentation, and low-power research. FPGA/ASIC/RTL roles remain exploratory. Only derived technical match categories and evidence summaries are included; the master resume and contact details are not part of the repository package. Scores measure keyword overlap, not hiring probability or eligibility.

## 1. Open the existing repository in VS Code

Open your cloned **Search57** folder, the one containing `check_jobs.py`, and choose **Terminal → New Terminal → PowerShell**. Confirm the checkout:

```powershell
git remote -v
git status --short
node --version
```

The origin should be `SatejShinde/Search57`. Use Node 22 or newer. The commands below stop if the checkout has uncommitted/untracked work; commit or move that work first rather than overwriting it. No GitHub CLI installation is needed.

## 2. Copy and test the new files

Run this block in that PowerShell terminal. It uses the prepared files on this computer. If you downloaded/extracted the ZIP elsewhere, set `$startupPackage` to the extracted directory containing both `startup-watch` and `.github`.

```powershell
$ErrorActionPreference = 'Stop'
$startupPackage = 'C:\Users\satej\Documents\Codex\2026-10-31\i-x20\outputs\startup-watch-package-v2'
$repoRoot = git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { throw 'Open the existing Search57 Git checkout first.' }
$repoRoot = $repoRoot.Trim()
$originUrl = git remote get-url origin
if ($LASTEXITCODE -ne 0 -or $originUrl -notmatch 'github\.com[:/]SatejShinde/Search57(?:\.git)?/?$') {
    throw 'This checkout is not SatejShinde/Search57.'
}
$pendingChanges = git status --porcelain
if ($LASTEXITCODE -ne 0 -or $pendingChanges) { throw 'Commit or move your existing changes before installing.' }
if (-not (Test-Path -LiteralPath (Join-Path $startupPackage 'startup-watch\run.mjs'))) {
    throw 'Package not found. Update $startupPackage to the extracted package folder.'
}
Set-Location -LiteralPath $repoRoot
git switch main
if ($LASTEXITCODE -ne 0) { throw 'Could not switch to main.' }
git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'Pull did not fast-forward. Resolve the branch difference first.' }
$startupDestination = Join-Path $repoRoot 'startup-watch'
$workflowDestination = Join-Path $repoRoot '.github\workflows'
New-Item -ItemType Directory -Force -Path $startupDestination, $workflowDestination | Out-Null
Get-ChildItem -LiteralPath (Join-Path $startupPackage 'startup-watch') -Force |
    Copy-Item -Destination $startupDestination -Recurse -Force
Copy-Item -LiteralPath (Join-Path $startupPackage '.github\workflows\startup-daily.yml') -Destination $workflowDestination -Force
Push-Location -LiteralPath $startupDestination
try {
    node --test
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed; do not commit yet.' }
    node run.mjs --demo --output .local/demo
    if ($LASTEXITCODE -ne 0) { throw 'Demo failed; do not commit yet.' }
} finally { Pop-Location }
git diff --stat
git status --short
```

The demo is fictional and sends nothing. It does not need any API key. Existing fast/slow workflow files are not copied or edited by this block.

## 3. Commit and push

Run after the tests pass. Only the startup folder and its workflow are staged:

```powershell
git add -- startup-watch .github/workflows/startup-daily.yml
if ($LASTEXITCODE -ne 0) { throw 'Staging failed.' }
git diff --cached --stat
git commit -m "Add resume-matched startup internship alerts via external cron"
if ($LASTEXITCODE -ne 0) { throw 'Commit failed; inspect git status.' }
git pull --rebase origin main
if ($LASTEXITCODE -ne 0) { throw 'Rebase needs attention. Resolve conflicts before pushing.' }
git push origin main
if ($LASTEXITCODE -ne 0) { throw 'Push failed. Read the Git error before retrying.' }
```

Search57's other jobs commit state frequently. If Git reports a non-fast-forward push, repeat `git pull --rebase origin main`, then `git push origin main` once the rebase succeeds. Never force-push `main` to resolve that situation.

If your Git credential is rejected specifically for updating workflow files, refresh the credential with permission to modify workflows. This is separate from the limited dispatch token described below. The existing Git sign-in flow normally handles authentication; do not place tokens in Git remote URLs.

## 4. Set the data key and activation variable

Open [Search57 Actions secrets](https://github.com/SatejShinde/Search57/settings/secrets/actions).

- Add repository secret **`MIDU_API_KEY`** using your free key from [Midu](https://midu.si/api).
- Reuse the existing repository secrets **`TELEGRAM_BOT_TOKEN`** and **`TELEGRAM_CHAT_ID`**.
- Under **Variables**, add **`STARTUP_WATCH_ENABLED`** with value **`true`** when you are ready to send. Preview runs work without this variable; send runs are skipped unless it is true.

The workflow uses its own `GITHUB_TOKEN` with `contents: write` to maintain the independent `startup-watch-state` branch. Repository/org branch rules still apply. The external cron token does not need permission to commit state.

Before activating delivery, go to **Actions → Startup prospect daily digest → Run workflow**, select `main`, leave `send` unchecked, and inspect the resulting preview artifact. This is the first credentialed Midu smoke test; a source/schema error should be resolved before enabling the scheduled sends.

## 5. Create a GitHub token for cron-job.org

In GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**:

- Name: `cron-job.org Search57 startup`
- Resource owner: **SatejShinde**
- Repository access: **Only select repositories → Search57**
- Repository permissions: **Actions → Read and write**
- Set an expiration you will remember to renew.

Copy the token directly into cron-job.org's Authorization header. Do not commit it or place it in the request URL/body. If your existing cron token already has the required access to Search57, you may reuse it. The permission above is sufficient for dispatching; it does not grant code-write permission.

Source: [GitHub dispatch API and required permissions](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#create-a-workflow-dispatch-event), [fine-grained token setup](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

## 6. Add the daily cron-job.org trigger

Sign in to [cron-job.org](https://console.cron-job.org/) and select **Create cronjob**:

| Field | Value |
| --- | --- |
| Title | `Search57 startup daily` |
| URL | `https://api.github.com/repos/SatejShinde/Search57/actions/workflows/startup-daily.yml/dispatches` |
| Execution schedule | **Every day at 08:37** |
| Advanced → Time zone | **America/Los_Angeles** |
| Advanced → Request method | **POST** |
| Requires HTTP authentication | Off; use the Authorization header below |

Under **Advanced → Headers → Add**, set:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer YOUR_GITHUB_TOKEN` |
| `Accept` | `application/vnd.github+json` |
| `Content-Type` | `application/json` |
| `X-GitHub-Api-Version` | `2026-03-10` |

For the first cron-job.org test, use this **Request body**:

```json
{"ref":"main","inputs":{"send":false}}
```

Run the service's test, then open the corresponding GitHub Actions run and inspect the preview. With the selected API version, a successful dispatch returns **HTTP 200** with workflow-run details. This means the run was accepted; it does not mean the scan or Telegram delivery finished.

After the live preview works and `STARTUP_WATCH_ENABLED=true`, change the request body to:

```json
{"ref":"main","inputs":{"send":true}}
```

Enable the cron job, enable failure/deactivation notifications, and verify **Next executions** shows the intended Pacific morning time. The named timezone follows daylight saving changes. GitHub still supplies runners, so external scheduling avoids dependence on GitHub's schedule event but does not guarantee an immediate runner start or completion time.

Sources: [cron-job.org supported headers and POST bodies](https://cron-job.org/en/faq/), [per-job timezone schema](https://docs.cron-job.org/rest-api.html#jobschedule), [GitHub dispatch status change for API 2026-03-10](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes?apiVersion=2026-03-10).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| GitHub 401 | Token invalid, expired or copied incorrectly |
| GitHub 403 | Token Actions permission, repository access, or organization policy |
| GitHub 404 | Exact owner/repository/workflow filename, token access, and file committed on `main` |
| GitHub 422 | `ref` exists; JSON/input names match `send`; workflow has `workflow_dispatch` |
| HTTP 200 but GitHub job skipped | `STARTUP_WATCH_ENABLED` must be `true` for `send:true` |
| GitHub fails on funding source | `MIDU_API_KEY`, provider response schema, or rate limits; review preview artifact/logs |
| GitHub fails on state push | Workflow token contents-write permission or branch rules; a rejected lease means history changed and should be inspected |
| GitHub succeeds but no Telegram message | There may be no new matches; inspect the digest artifact and configured chat ID |

When stopping this startup monitor, disable its cron-job.org job. Changing `STARTUP_WATCH_ENABLED` to `false` also prevents sends. Existing Search57 jobs have separate configuration.
