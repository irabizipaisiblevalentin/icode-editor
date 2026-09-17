'use strict';

/*
 * Downloads the native iCode coding-agent CLI for a target platform and places
 * it inside this extension at `bin/icode` (or `bin/icode.exe`).
 *
 * The built-in `icode-ai` extension launches this binary as a local server so
 * that the AI chat works out of the box, without a separate install.
 *
 * Usage:
 *   node script/fetch-binary.cjs [--version 1.1.2] [--target linux-x64]
 *
 * When --target is omitted it is derived from the host platform/arch. CI must
 * pass --target explicitly because some runners are the opposite architecture
 * to the build they produce (e.g. cross-building a macOS arm64 app on x64).
 */

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCOPE = '@vln.codes__';

const PLATFORM_KEYS = {
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64': 'windows-x64',
  'win32-arm64': 'windows-arm64',
};

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) {
    return process.argv[i + 1];
  }
  const prefixed = process.argv.find((a) => a.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : undefined;
}

async function resolveVersion(pkg) {
  const pinned = argValue('--version') || process.env.ICODE_CLI_VERSION;
  if (pinned) {
    return pinned;
  }
  const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Could not resolve the latest version of ${pkg} (HTTP ${res.status}). Set ICODE_CLI_VERSION to pin a version.`);
  }
  const data = await res.json();
  if (!data.version) {
    throw new Error(`No version found for ${pkg}. Set ICODE_CLI_VERSION to pin a version.`);
  }
  return data.version;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Failed to download ${url} (HTTP ${res.status})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buffer);
}

async function main() {
  const target = argValue('--target') || process.env.ICODE_CLI_TARGET || `${process.platform}-${process.arch}`;
  const platformKey = PLATFORM_KEYS[target];
  if (!platformKey) {
    throw new Error(`iCode does not ship an agent for ${target}. Supported: ${Object.keys(PLATFORM_KEYS).join(', ')}`);
  }

  const pkg = `${SCOPE}/icode-${platformKey}`;
  const short = `icode-${platformKey}`;
  const version = await resolveVersion(pkg);
  const exeName = platformKey.startsWith('windows-') ? 'icode.exe' : 'icode';
  const tarballUrl = `https://registry.npmjs.org/${pkg}/-/${short}-${version}.tgz`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icode-agent-'));
  try {
    console.log(`[icode-ai] fetching ${pkg}@${version}`);
    const tarball = path.join(tmp, 'agent.tgz');
    await download(tarballUrl, tarball);

    cp.execFileSync('tar', ['-xzf', tarball, '-C', tmp], { stdio: 'inherit' });

    const source = path.join(tmp, 'package', 'bin', exeName);
    if (!fs.existsSync(source)) {
      throw new Error(`Expected binary at ${source} inside ${tarballUrl}`);
    }

    const destDir = path.join(__dirname, '..', 'bin');
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, exeName);
    fs.copyFileSync(source, dest);
    if (exeName !== 'icode.exe') {
      fs.chmodSync(dest, 0o755);
    }

    console.log(`[icode-ai] bundled agent (${target}) -> ${path.relative(process.cwd(), dest)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[icode-ai] failed to bundle agent: ${err.message}`);
  process.exit(1);
});
