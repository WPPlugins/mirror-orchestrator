# Setup Guide

This guide walks through configuring the **WPPlugins** GitHub App and orchestrator repository secrets so the mirror runs autonomously on GitHub Actions.

## 1. Create a GitHub App on the `WPPlugins` Organization

1. Go to **GitHub → Organizations → WPPlugins → Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Set the **GitHub App name** (e.g. `WPPlugins Mirror Bot`) and a homepage URL (e.g. `https://github.com/WPPlugins`).
3. Disable **Webhook → Active** (this orchestrator runs on a cron schedule and `workflow_dispatch`, so no webhook endpoint is needed).
4. Grant the minimum required **Repository permissions**:
   - **Administration:** `Read & write` (required to create new plugin repositories under `WPPlugins`).
   - **Contents:** `Read & write` (required to push `main` and version tags).
   - **Metadata:** `Read-only` (required by GitHub Apps).
5. Under **Where can this GitHub App be installed?**, select **Only on this account**.
6. Click **Create GitHub App**.

## 2. Generate a Private Key & Note the App ID

1. On the newly created GitHub App's settings page, note the **App ID** (numeric).
2. Scroll to **Private keys** and click **Generate a private key**.
3. Save the downloaded `.pem` file securely.

## 3. Install the App on All `WPPlugins` Repositories

1. In the GitHub App sidebar, click **Install App**.
2. Select the **WPPlugins** organization.
3. Choose **All repositories** (so newly created plugin mirrors are automatically accessible to the installation token).
4. Confirm installation.

## 4. Configure Repository Secrets in the Orchestrator Repo

In your orchestrator repository (**Settings → Secrets and variables → Actions → New repository secret**), add:

| Secret Name | Value |
| :--- | :--- |
| `APP_ID` | The numeric GitHub App ID from Step 2. |
| `APP_PRIVATE_KEY` | The full contents of the `.pem` private key file (PKCS#1 or PKCS#8). |
| `TARGET_ORG` | Target GitHub organization name (defaults to `WPPlugins` if omitted). |

## 5. Seed the Backfill Queue (Optional)

To start catching up older plugins from the WordPress.org Plugin Directory in safe batches:

```bash
deno task backfill --pages 5
git add state/backfill-queue.json state/cursor.json
git commit -m "chore: seed initial backfill queue"
git push
```

## 6. Test with a Dry Run

Trigger **Actions → Mirror WordPress.org Plugins → Run workflow** with:
- `slugs`: `akismet`
- `dry_run`: `true`

Verify that discovery and SVN export complete cleanly before running live syncs.
