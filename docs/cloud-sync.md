# Experimental Google account and thread sync

Settings → Labs → **Google account & thread sync** is optional and off by default. Sign in with the same Google account on each computer to sync saved teaching and practice threads through Convex Auth v2, the Convex database, and Convex file storage.

Threads include native messages, side questions, plans, usage, processed images, saved background results, and referenced files uploaded into LearnHarness's managed attachments directory. Arbitrary files elsewhere on the computer and plugin workspaces are not uploaded. References to external local files still require those files on the other computer. Plugins needed to display or continue a thread must be installed there.

The knowledge graph, application preferences, provider credentials, and installed plugins stay local. This is an account connection for a trusted local/shared LearnHarness server; it does not add a login gate, separate simultaneous browser users, or make the server suitable for public hosting.

## Configure Convex and Google

1. Install dependencies with `npm install`. Run `npx convex dev` to select or create your Convex project and development deployment. The first deployment may report that the Google component needs its environment variables; configure those below and run it again. The CLI writes `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_*` to the git-ignored `.env.local`; LearnHarness does not read those (it reads `LH_CONVEX_URL`, step 7). Its `convex/_generated/` output is git-ignored because the functions and the app build without it.
2. In Google Cloud Console, configure the OAuth consent screen and create a **Web application** OAuth client. During testing, add the Google accounts that will use the experiment as test users.
3. Add this authorized redirect URI to that Google client, substituting your Convex deployment's site host: `https://YOUR-DEPLOYMENT.convex.site/oauth/google/callback`. The callback is on `.convex.site`, not `.convex.cloud`.
4. Set `AUTH_GOOGLE_CLIENT_ID` and `AUTH_GOOGLE_CLIENT_SECRET` in the Convex dashboard's environment variables. These credentials belong on Convex, not in frontend code or the settings file.
5. Set `AUTH_REDIRECT_ORIGINS` on Convex to the comma-separated exact LearnHarness return origins. The defaults are `http://localhost:3000,http://127.0.0.1:3211`. Add your browser app's origin if different. Keep `http://127.0.0.1:3211` for the packaged desktop application.
6. Run `npx convex dev --once` to deploy the auth components, user schema, and thread functions. For production, configure the production deployment's variables and Google redirect URI, then run `npx convex deploy`.
7. Set `LH_CONVEX_URL=https://YOUR-DEPLOYMENT.convex.cloud` in each computer's `.env.local` or launcher environment, then restart LearnHarness. Packaged desktop launchers need this environment variable passed to the app. No Convex administrator/deploy key is needed at runtime.
8. Enable the feature in **Settings → Labs**, then choose **Sign in with Google**. Complete Google sign-in in your system browser and return to LearnHarness. The app switches to the account library automatically.

The desktop app keeps its existing randomly selected app port. A temporary listener bound only to `127.0.0.1:3211` handles its one-use OAuth return and closes after completion, cancellation, or ten minutes. If that port is occupied, free it and retry, or set `LH_CLOUD_CALLBACK_PORT` and add the corresponding exact loopback origin to `AUTH_REDIRECT_ORIGINS` on Convex. The browser development flow at `localhost:3000` uses the Next.js callback route.

## Sync behavior

The first Google connection on each computer copies its existing local threads into that account's cache and uploads them. The signed-out local library remains intact. Later account connections do not import that original library into a different account. Account caches are partitioned by both Convex deployment and verified user identity.

Sync checks every ten seconds while LearnHarness's server is running and enabled. **Sync now** requests an immediate pass. A local save does not wait for the network. Offline edits and deletion timestamps persist on disk and are reconciled after reconnection or restart. Active turns, side answers, compaction, and extraction defer sync for their thread. Agent execution stays on its originating computer; only settled saved state travels between computers.

If computers change the same thread, **the most recently updated version wins**, including renames and deletions. An independent persisted timestamp records every thread/result change; it does not rely on the existing conversation activity timestamp. Update times come from the computer making the edit, so keep system clocks synchronized. Ties retain the committed cloud version. Revision checks prevent a request based on an older cloud version from overwriting a newer one; it reconciles again on the next pass. The losing version does not become a conflict copy.

Each portable thread snapshot is limited to 128 MiB. Larger threads remain saved locally and report a sync error. Thread payloads and managed attachments use Convex file storage; the database holds owner-indexed metadata, update times, revisions, and deletion tombstones. Every cloud operation resolves the authenticated session owner. Payloads carry integrity hashes, and imports validate supported versions, thread/job identities, attachment paths, and completed background work.

Signing out or disabling the experiment stops sync and returns to the signed-out local library. Account caches and unsynced changes stay on disk for that account's next connection. Wait for active work to finish before switching. When offline, local disconnect still works; remote revocation may wait for session expiry. Cloud data is not deleted by sign-out.

The private `learnharness-cloud-credentials.json` file lives beside `LH_AUTH_FILE`, uses restrictive permissions, and is excluded from Git, learner file tools, and desktop build payloads. Access and refresh tokens are never returned in Labs status or callback pages. OAuth uses a one-use local attempt plus the Convex state/code verification. Old and superseded storage payloads are currently retained, including failed-upload leftovers; account deletion and storage garbage collection are not implemented in this experiment.

Implementation follows the official [Convex Auth v2 documentation](https://docs.convex.dev/auth/convex-auth) and [Google OAuth setup](https://docs.convex.dev/auth/convex-auth/methods/oauth).
