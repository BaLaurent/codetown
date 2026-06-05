#!/usr/bin/env node
/**
 * CodeTown Hotel Setup Script
 *
 * Universal setup for BOTH Claude Code AND Cursor.
 * Configures hooks for whichever tool(s) are present.
 * Run this in your project root: npx codetown-hotel setup
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODETOWN_ROOT = path.resolve(__dirname, '..');
const TARGET_DIR = process.cwd();
const SERVER_PORT = 5174;
const CLIENT_PORT = 5173;

// Hook paths (absolute - works for both tools)
const FILE_HOOK = path.join(CODETOWN_ROOT, 'hooks', 'file-activity-hook.sh');
const THINKING_HOOK = path.join(CODETOWN_ROOT, 'hooks', 'thinking-hook.sh');
const PERMISSION_HOOK = path.join(CODETOWN_ROOT, 'hooks', 'permission-hook.sh');
const SESSION_HOOK = path.join(CODETOWN_ROOT, 'hooks', 'session-start-hook.sh');
const GIT_POST_COMMIT_HOOK = path.join(CODETOWN_ROOT, 'hooks', 'git-post-commit.sh');

// Claude settings to merge
const hooksConfig = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Read",
        hooks: [{ type: "command", command: `${FILE_HOOK} read-start` }]
      },
      {
        matcher: "Edit|Write|MultiEdit",
        hooks: [{ type: "command", command: `${FILE_HOOK} write-start` }]
      },
      {
        matcher: ".*",
        hooks: [{ type: "command", command: `${THINKING_HOOK} thinking-end` }]
      },
      {
        // Blocking: lets the user answer an AskUserQuestion from the hotel.
        // Fail-open (defers to the native prompt) when the hotel isn't watching.
        matcher: "AskUserQuestion",
        hooks: [{ type: "command", command: `${PERMISSION_HOOK}` }]
      }
    ],
    PostToolUse: [
      {
        matcher: "Read",
        hooks: [{ type: "command", command: `${FILE_HOOK} read-end` }]
      },
      {
        matcher: "Edit|Write|MultiEdit",
        hooks: [{ type: "command", command: `${FILE_HOOK} write-end` }]
      },
      {
        matcher: ".*",
        hooks: [{ type: "command", command: `${THINKING_HOOK} thinking-start` }]
      }
    ],
    Notification: [
      {
        matcher: ".*",
        hooks: [{ type: "command", command: `${THINKING_HOOK} thinking-end` }]
      }
    ],
    PermissionRequest: [
      {
        // Fires only when Claude WOULD actually prompt for permission (so auto/
        // bypass mode and pre-allowed tools are untouched). Lets the user
        // Allow/Deny from the hotel; fail-open to the native dialog otherwise.
        matcher: ".*",
        hooks: [{ type: "command", command: `${PERMISSION_HOOK}` }]
      }
    ],
    SessionStart: [
      {
        // Boots the hotel the instant a session opens, so the server is already
        // up before the first tool call (the PreToolUse hooks remain the lazy
        // fallback). Without this a freshly-opened session shows no server until
        // the agent's first Read/Edit/Bash — and a session opened before the
        // hooks were wired never starts one at all. No matcher: fire on every
        // session source (startup, resume, clear).
        hooks: [{ type: "command", command: `${SESSION_HOOK}` }]
      }
    ]
  }
};

// Permissions to add (allows hooks to run without prompting)
const permissionsConfig = {
  permissions: {
    allow: [
      `Bash(${FILE_HOOK} read:*)`,
      `Bash(${FILE_HOOK} write:*)`,
      `Bash(${THINKING_HOOK} thinking-start:*)`,
      `Bash(${THINKING_HOOK} thinking-end:*)`,
      `Bash(${PERMISSION_HOOK}:*)`,
      `Bash(${SESSION_HOOK}:*)`
    ]
  }
};

// Cursor hooks configuration (.cursor/hooks.json) is generated from the
// versioned template (.cursor/hooks.json.template), the single source of truth
// for the hook structure. The generated file holds machine-specific absolute
// paths so it is git-ignored. We substitute __CODETOWN_ROOT__ inside the parsed
// object (not the raw text) so JSON.stringify on write escapes path separators
// correctly, including Windows backslashes.
const cursorTemplatePath = path.join(CODETOWN_ROOT, '.cursor', 'hooks.json.template');
const cursorHooksConfig = JSON.parse(fs.readFileSync(cursorTemplatePath, 'utf8'));
for (const eventHooks of Object.values(cursorHooksConfig.hooks)) {
  for (const entry of eventHooks) {
    entry.command = entry.command.split('__CODETOWN_ROOT__').join(CODETOWN_ROOT);
  }
}

// Check if a port is in use
function isPortInUse(port) {
  return new Promise((resolve) => {
    exec(`lsof -i :${port} -t`, (err, stdout) => {
      resolve(stdout.trim().length > 0);
    });
  });
}

// Open URL in default browser
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' :
              process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} ${url}`);
}

// Start the dev server
function startServer() {
  return new Promise((resolve, reject) => {
    console.log('🚀 Starting CodeTown server...\n');

    const child = spawn('npm', ['run', 'dev'], {
      cwd: CODETOWN_ROOT,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, PROJECT_ROOT: TARGET_DIR }
    });

    // Wait a bit for server to start, then resolve
    setTimeout(() => resolve(child), 3000);

    child.on('error', reject);
  });
}

// Main "run" command - does everything automatically
async function run() {
  console.log('🏨 CodeTown Hotel\n');
  console.log(`Project: ${TARGET_DIR}\n`);

  // Step 1: Setup hooks if not already configured (global config now)
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const needsSetup = !fs.existsSync(settingsPath) ||
    !fs.readFileSync(settingsPath, 'utf8').includes('file-activity-hook');

  if (needsSetup) {
    console.log('📝 Setting up hooks...');
    setupHooks();
    console.log('');
  } else {
    console.log('✓ Hooks already configured\n');
  }

  // Step 2: Check if server is already running
  const serverRunning = await isPortInUse(SERVER_PORT);
  const clientRunning = await isPortInUse(CLIENT_PORT);

  if (serverRunning && clientRunning) {
    console.log('✓ Server already running\n');
    console.log('🌐 Opening http://localhost:5173/hotel\n');
    openBrowser('http://localhost:5173/hotel');
    console.log('Start Claude Code or Cursor in your project to see agents! 🎮');
    return;
  }

  // Step 3: Start server
  console.log('Starting visualization server...\n');
  await startServer();

  // Step 4: Open browser
  console.log('\n🌐 Opening http://localhost:5173/hotel\n');
  setTimeout(() => openBrowser('http://localhost:5173/hotel'), 2000);

  console.log('Start Claude Code or Cursor in your project to see agents! 🎮\n');
}

// True if a hook entry belongs to CodeTown (so we can replace it idempotently).
function isCodetownHook(entry) {
  const s = JSON.stringify(entry);
  return s.includes('file-activity-hook') || s.includes('thinking-hook') || s.includes('permission-hook') || s.includes('session-start-hook');
}

// Setup Claude Code hooks GLOBALLY (~/.claude/settings.json).
// Global hooks mean every project Claude Code runs in automatically appears as a
// building in the town — one canonical hook-script source, no per-project drift.
// Merges additively: existing (non-CodeTown) hooks and permissions are preserved.
function setupClaudeHooks() {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      // Back up before touching the user's global config.
      fs.copyFileSync(settingsPath, settingsPath + '.codetown-bak');
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      // Ignore parse errors, start fresh
    }
  }

  // Append CodeTown hook entries to each event array, dropping any prior CodeTown
  // entries first so re-running setup is idempotent and never duplicates.
  settings.hooks = settings.hooks || {};
  for (const [event, entries] of Object.entries(hooksConfig.hooks)) {
    const kept = (settings.hooks[event] || []).filter(e => !isCodetownHook(e));
    settings.hooks[event] = [...kept, ...entries];
  }

  // Merge permissions
  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];
  settings.permissions.allow = settings.permissions.allow.filter(
    p => !p.includes('file-activity-hook') && !p.includes('thinking-hook') && !p.includes('permission-hook') && !p.includes('session-start-hook')
  );
  settings.permissions.allow.push(...permissionsConfig.permissions.allow);

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log('✓ Configured ~/.claude/settings.json (Claude Code, global)');
}

// Setup Cursor hooks
function setupCursorHooks() {
  const cursorDir = path.join(TARGET_DIR, '.cursor');
  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }

  const hooksPath = path.join(cursorDir, 'hooks.json');
  fs.writeFileSync(hooksPath, JSON.stringify(cursorHooksConfig, null, 2));
  console.log('✓ Configured .cursor/hooks.json (Cursor)');
}

// Setup git post-commit hook for layout refresh
function setupGitHook() {
  const gitDir = path.join(TARGET_DIR, '.git');
  if (!fs.existsSync(gitDir)) {
    console.log('⚠ No .git directory found - skipping git hook');
    return;
  }

  const hooksDir = path.join(gitDir, 'hooks');
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const postCommitPath = path.join(hooksDir, 'post-commit');

  // Check if post-commit hook already exists
  if (fs.existsSync(postCommitPath)) {
    const existing = fs.readFileSync(postCommitPath, 'utf8');
    // Check if our hook is already integrated
    if (existing.includes('codetown') || existing.includes('git-post-commit.sh')) {
      console.log('✓ Git post-commit hook already configured');
      return;
    }
    // Append to existing hook
    const updated = existing + `\n\n# CodeTown Hotel - refresh layout on commit\n${GIT_POST_COMMIT_HOOK}\n`;
    fs.writeFileSync(postCommitPath, updated);
    console.log('✓ Added CodeTown to existing git post-commit hook');
  } else {
    // Create new hook
    const hookContent = `#!/bin/bash
# Git post-commit hook
# Auto-generated by CodeTown Hotel setup

# CodeTown Hotel - refresh layout on commit
${GIT_POST_COMMIT_HOOK}
`;
    fs.writeFileSync(postCommitPath, hookContent);
    fs.chmodSync(postCommitPath, '755');
    console.log('✓ Created git post-commit hook (layout refreshes on commit)');
  }
}

// Setup hooks for ALL detected tools
function setupHooks() {
  // Always setup Claude Code (it's our primary target)
  setupClaudeHooks();

  // Also setup Cursor (universal support)
  setupCursorHooks();

  // Setup git hook for layout refresh on commits
  setupGitHook();

  // Make hooks executable
  try {
    fs.chmodSync(FILE_HOOK, '755');
    fs.chmodSync(THINKING_HOOK, '755');
    fs.chmodSync(PERMISSION_HOOK, '755');
    fs.chmodSync(SESSION_HOOK, '755');
    fs.chmodSync(GIT_POST_COMMIT_HOOK, '755');
  } catch (e) {
    // Ignore chmod errors
  }
}

function setup() {
  console.log('🏨 CodeTown Hotel Setup\n');
  console.log(`CodeTown installed at: ${CODETOWN_ROOT}`);
  console.log(`Target project: ${TARGET_DIR}\n`);

  setupHooks();

  console.log('\nSetup complete! To start visualization:\n');
  console.log(`  cd ${TARGET_DIR}`);
  console.log('  codetown-hotel\n');
}

// CLI
const command = process.argv[2];

if (command === 'setup') {
  setup();
} else if (command === 'start') {
  // Legacy start command
  run();
} else if (!command) {
  // Default: run everything
  run();
} else {
  console.log('CodeTown Hotel - Visualize Claude Code agents\n');
  console.log('Usage:');
  console.log('  codetown-hotel         - Setup hooks, start server, open browser');
  console.log('  codetown-hotel setup   - Only configure hooks for current project');
  console.log('');
}
