#!/usr/bin/env node
import { existsSync, readdirSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync, execSync } from 'node:child_process';

const ROOT_DIR = process.cwd();
const PATCHES_DIR = resolve(ROOT_DIR, 'patches');
const GIT_DIR = resolve(ROOT_DIR, '.git');
const REBASE_APPLY_DIR = resolve(GIT_DIR, 'rebase-apply');

function runGit(args, { capture = false, ignoreError = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: ROOT_DIR,
    encoding: 'utf-8',
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  });

  if (!ignoreError && result.status !== 0) {
    if (capture && result.stderr) {
      console.error(result.stderr.trim());
    }
    const err = new Error(`git ${args.join(' ')} failed with code ${result.status}`);
    err.status = result.status;
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    throw err;
  }

  return result;
}

function getGitOutput(args, ignoreError = false) {
  const res = runGit(args, { capture: true, ignoreError });
  return res.stdout ? res.stdout.trim() : '';
}

function getPatches() {
  if (!existsSync(PATCHES_DIR)) return [];
  return readdirSync(PATCHES_DIR)
    .filter((f) => f.endsWith('.patch'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map((f) => join(PATCHES_DIR, f));
}

function isAmInProgress() {
  return existsSync(REBASE_APPLY_DIR);
}

function getCurrentBranch() {
  return getGitOutput(['branch', '--show-current'], true) || 'HEAD';
}

function getDefaultBaseRemote() {
  const remotes = getGitOutput(['remote'], true).split(/\r?\n/).filter(Boolean);
  if (remotes.includes('upstream')) return 'upstream';
  if (remotes.includes('origin')) return 'origin';
  return 'origin';
}

function cleanPatchesDir() {
  if (!existsSync(PATCHES_DIR)) {
    mkdirSync(PATCHES_DIR, { recursive: true });
    return;
  }
  for (const file of readdirSync(PATCHES_DIR)) {
    if (file.endsWith('.patch')) {
      rmSync(join(PATCHES_DIR, file), { force: true });
    }
  }
}

function cmdExport(baseArg) {
  const remote = getDefaultBaseRemote();
  const base = baseArg || `${remote}/main`;

  console.log(`\n📦 [patch-sync] Exporting patches relative to ${base}...`);

  // Verify base ref exists
  try {
    getGitOutput(['rev-parse', '--verify', base]);
  } catch {
    console.error(`❌ Base reference '${base}' does not exist.`);
    console.error(`💡 Try fetching first: git fetch ${remote}`);
    process.exit(1);
  }

  // Count commits ahead
  const count = getGitOutput(['rev-list', '--count', `${base}..HEAD`]);
  if (!count || parseInt(count, 10) === 0) {
    console.warn(`⚠️ No commits found between ${base} and HEAD. Nothing to export.`);
    return;
  }

  console.log(`Found ${count} commit(s) ahead of ${base}.`);

  cleanPatchesDir();

  try {
    runGit(['format-patch', `${base}..HEAD`, '-o', 'patches']);
  } catch (err) {
    console.error(`❌ Failed to export patches:`, err.message);
    process.exit(1);
  }

  const generated = getPatches();
  console.log(`\n✅ Successfully exported ${generated.length} patch(es) to 'patches/':`);
  for (const patch of generated) {
    console.log(`   - ${patch.replace(ROOT_DIR, '').replace(/^[\\/]/, '')}`);
  }
  console.log('\n💡 Commit these patch files to git so your fork preserves your custom modifications.');
}

function cmdApply() {
  const patches = getPatches();
  if (patches.length === 0) {
    console.error(`❌ No .patch files found in '${PATCHES_DIR}'.`);
    process.exit(1);
  }

  console.log(`\n🛠️  [patch-sync] Applying ${patches.length} patch(es) with 3-way merge...`);

  if (isAmInProgress()) {
    console.warn(`⚠️ A patch application (git am) is already in progress.`);
    console.warn(`   Run 'npm run patch:status' to inspect, or 'npm run patch:abort' to cancel.`);
    process.exit(1);
  }

  try {
    runGit(['am', '--3way', ...patches]);
    console.log(`\n✅ All ${patches.length} patch(es) applied cleanly!`);
  } catch {
    console.error(`\n⚠️  Conflict occurred while applying patches.`);
    printConflictHelp();
    process.exit(1);
  }
}

function cmdContinue() {
  if (!isAmInProgress()) {
    console.log(`ℹ️  No 'git am' session in progress.`);
    return;
  }

  console.log(`\n▶️  [patch-sync] Continuing git am...`);
  try {
    runGit(['am', '--continue']);
    if (!isAmInProgress()) {
      console.log(`\n✅ All remaining patches applied successfully!`);
    } else {
      console.log(`\nNext patch applied.`);
    }
  } catch {
    console.error(`\n⚠️  Another conflict needs resolution.`);
    printConflictHelp();
    process.exit(1);
  }
}

function cmdAbort() {
  if (!isAmInProgress()) {
    console.log(`ℹ️  No 'git am' session in progress to abort.`);
    return;
  }

  console.log(`\n🛑 [patch-sync] Aborting git am and restoring previous state...`);
  try {
    runGit(['am', '--abort']);
    console.log(`✅ Git am session aborted cleanly.`);
  } catch (err) {
    console.error(`❌ Error aborting git am:`, err.message);
    process.exit(1);
  }
}

function cmdStatus() {
  console.log(`\n🔍 [patch-sync] Status:`);
  console.log(`   Current branch: ${getCurrentBranch()}`);
  const patches = getPatches();
  console.log(`   Stored patches in 'patches/': ${patches.length}`);

  if (isAmInProgress()) {
    console.log(`\n⚠️  GIT AM IS CURRENTLY IN PROGRESS (Conflict Resolution Mode)`);
    try {
      const nextFile = join(REBASE_APPLY_DIR, 'next');
      const lastFile = join(REBASE_APPLY_DIR, 'last');
      if (existsSync(nextFile) && existsSync(lastFile)) {
        const next = readFileSync(nextFile, 'utf-8').trim();
        const last = readFileSync(lastFile, 'utf-8').trim();
        console.log(`   Progress: patch ${next} of ${last}`);
      }
    } catch {
      // ignore
    }

    const unmerged = getGitOutput(['diff', '--name-only', '--diff-filter=U'], true);
    if (unmerged) {
      console.log(`\n   Conflicting files:`);
      unmerged.split(/\r?\n/).forEach((f) => console.log(`     ❌ ${f}`));
    }
    printConflictHelp();
  } else {
    console.log(`   No git am session active.`);
    const remote = getDefaultBaseRemote();
    const ahead = getGitOutput(['rev-list', '--count', `${remote}/main..HEAD`], true);
    if (ahead) {
      console.log(`   Commits ahead of ${remote}/main: ${ahead}`);
    }
  }
}

function cmdSync(options = {}) {
  const remote = options.remote || getDefaultBaseRemote();
  const upstreamBranch = options.baseBranch || 'main';
  const targetBranch = options.targetBranch;

  console.log(`\n🔄 [patch-sync] Syncing with ${remote}/${upstreamBranch}...`);

  if (isAmInProgress()) {
    console.error(`❌ A git am session is already in progress. Please resolve or abort first.`);
    process.exit(1);
  }

  // Check working tree clean
  const dirty = getGitOutput(['status', '--porcelain', '-uno'], true);
  if (dirty) {
    console.error(`❌ Working directory has unstaged/staged tracked changes:`);
    console.error(dirty);
    console.error(`💡 Please commit or stash your changes before syncing.`);
    process.exit(1);
  }

  // 1. Fetch upstream
  console.log(`📡 Fetching ${remote}...`);
  runGit(['fetch', remote]);

  // 2. Patches available?
  const patches = getPatches();
  if (patches.length === 0) {
    console.warn(`⚠️ No patches found in 'patches/'. Run 'npm run patch:export' first if you have custom commits.`);
    return;
  }

  // 3. Checkout or update target branch
  const current = getCurrentBranch();
  const syncBranchName = targetBranch || current;

  console.log(`🌿 Preparing branch '${syncBranchName}' based on ${remote}/${upstreamBranch}...`);
  if (current !== syncBranchName) {
    runGit(['checkout', syncBranchName]);
  }

  // Reset target branch to upstream
  runGit(['reset', '--hard', `${remote}/${upstreamBranch}`]);

  // 4. Apply patches
  cmdApply();
}

function printConflictHelp() {
  console.log(`
┌─────────────────────────────────────────────────────────────┐
│ 💡 Conflict Resolution Steps:                               │
│                                                             │
│ 1. Open conflicting files in your editor.                   │
│ 2. Resolve the conflict markers (<<<<<<<, =======, >>>>>>>) │
│ 3. Stage the resolved files: git add <file>                 │
│ 4. Run: npm run patch:continue                              │
│                                                             │
│ To cancel and restore previous state, run:                  │
│    npm run patch:abort                                      │
└─────────────────────────────────────────────────────────────┘
`);
}

function printHelp() {
  console.log(`
learnharness Patch Sync Tool

Usage:
  node scripts/patch-sync.mjs <command> [args]

Commands:
  export [base]    Export commits ahead of base (default: upstream/main) to patches/
  sync             Fetch upstream/main, reset current branch, and re-apply all patches
  apply            Apply patches/ with git am --3way
  continue         Continue git am after resolving conflicts and running 'git add'
  abort            Cancel git am and return to state prior to apply
  status           Show current git am and patch status
  help             Show this help message

Examples:
  npm run patch:export
  npm run patch:sync
  npm run patch:continue
  npm run patch:abort
  npm run patch:status
`);
}

const args = process.argv.slice(2);
const command = args[0] || 'help';

switch (command) {
  case 'export':
    cmdExport(args[1]);
    break;
  case 'apply':
    cmdApply();
    break;
  case 'continue':
    cmdContinue();
    break;
  case 'abort':
    cmdAbort();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'sync':
    cmdSync();
    break;
  case 'help':
  case '--help':
  case '-h':
  default:
    printHelp();
    break;
}
