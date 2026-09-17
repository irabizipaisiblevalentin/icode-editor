'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONTROL_URL = process.env.ICODE_CONTROL_URL || 'https://icode-s05p.onrender.com';
const TRIAL_DAYS = 21;
const GOOGLE_STATE_POLL_MS = 2500;
const GOOGLE_STATE_MAX_WAIT_MS = 5 * 60 * 1000;

function getHardwareId() {
  let parts = [];
  if (process.platform === 'linux') {
    const read = (p) => {
      try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; }
    };
    const dmi = '/sys/class/dmi/id';
    parts = [read(`${dmi}/product_uuid`), read(`${dmi}/board_serial`), read(`${dmi}/product_name`), read('/etc/machine-id')];
  } else if (process.platform === 'darwin') {
    const run = (cmd, args) => {
      try { return require('child_process').execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000 }).trim(); } catch (e) { return ''; }
    };
    const ioreg = run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    parts = [
      run('sysctl', ['-n', 'hw.model']),
      (ioreg.match(/IOPlatformSerialNumber" = "([^"]+)"/) || [])[1] || '',
      (ioreg.match(/IOPlatformUUID" = "([^"]+)"/) || [])[1] || '',
    ];
  } else if (process.platform === 'win32') {
    try {
      parts = [require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID'], { encoding: 'utf8', timeout: 2000 }).trim()];
    } catch (e) { parts = []; }
  }
  const joined = parts.join('|').trim();
  if (!joined) return '';
  return crypto.createHash('sha256').update(joined).digest('hex').slice(0, 32);
}

// Uplifts hardware identity to match resources on this machine. The CLI and the
// Editor share the same hardware fingerprint, so a machine already licensed via
// the CLI (trial or paid Passcode) unlocks the Editor automatically.
class LicenseGate {
  constructor(context) {
    this.context = context;
    this.storagePath = path.join(context.globalStorageUri.fsPath, 'license.json');
    this.heartbeatTimer = undefined;
    this.lastBeat = Date.now();
    this.polling = false;
  }

  get stateDir() {
    return this.context.globalStorageUri.fsPath;
  }

  getMachineId() {
    const idPath = path.join(this.stateDir, 'machine-id');
    if (fs.existsSync(idPath)) {
      return fs.readFileSync(idPath, 'utf8').trim();
    }
    const id = crypto.randomUUID();
    fs.mkdirSync(path.dirname(idPath), { recursive: true });
    fs.writeFileSync(idPath, id, 'utf8');
    return id;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  save(data) {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2), 'utf8');
  }

  clear() {
    this.save({
      machine_id: this.getMachineId(),
      passcode: null,
      passcode_id: null,
      expires_at: null,
      validated_at: new Date().toISOString(),
    });
  }

  async serverPost(endpoint, body) {
    try {
      const res = await fetch(CONTROL_URL + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  async serverGet(endpoint, params) {
    try {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      const res = await fetch(CONTROL_URL + endpoint + qs, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  devicePayload() {
    return {
      machine_id: this.getMachineId(),
      hardware_id: getHardwareId(),
      platform: process.platform,
      arch: process.arch,
      version: vscode.extensions.getExtension('icode.icode-ai')
        ? vscode.extensions.getExtension('icode.icode-ai').packageJSON.version
        : '0.0.0',
    };
  }

  startTrial() {
    return this.serverPost('/v1/trial/start', this.devicePayload());
  }

  validatePasscode(code) {
    return this.serverPost('/v1/passcode/validate', Object.assign({ code }, this.devicePayload()));
  }

  checkStatus() {
    const { machine_id, hardware_id } = this.devicePayload();
    return this.serverPost('/v1/install/status', { machine_id, hardware_id });
  }

  sendHeartbeat(seconds) {
    const { machine_id, hardware_id } = this.devicePayload();
    return this.serverPost('/v1/install/heartbeat', { machine_id, hardware_id, seconds_active: seconds });
  }

  // ─── Gate state ─────────────────────────────────────────────────────

  // Returns a summary the webview can render as the hard-block screen.
  async getState() {
    const stored = this.load();
    const status = await this.checkStatus();
    const blocks = [];

    if (!status) {
      if (stored && stored.validated_at) {
        const hoursSinceValidation = (Date.now() - new Date(stored.validated_at).getTime()) / (1000 * 60 * 60);
        if (hoursSinceValidation < 24) {
          return { licensed: true, reason: 'offline_grace', message: 'Running offline. License was validated within the last 24 hours.', blocks: [] };
        }
      }
      return { licensed: false, reason: 'offline', message: 'Could not reach the iCode license server. Check your internet connection.', blocks };
    }

    if (status.blocked) {
      return { licensed: false, reason: 'blocked', message: status.message || 'Your access to iCode has been revoked.', blocks };
    }

    if (status.google_trial_active) {
      return {
        licensed: true,
        reason: 'google',
        message: 'Google trial active.',
        expires_at: status.google_expires_at,
        type: 'google',
        blocks,
      };
    }

    if (status.passcode_valid && status.ok) {
      return {
        licensed: true,
        reason: 'passcode',
        message: 'Licensed.',
        expires_at: status.expires_at,
        type: status.type,
        blocks,
      };
    }

    const expiring = stored && stored.expires_at
      ? Math.max(0, Math.ceil((new Date(stored.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : null;

    return {
      licensed: false,
      reason: 'not_licensed',
      message: status.message || 'You need a license to use iCode AI.',
      expires_at: status.expires_at,
      days_left: expiring,
      google_enabled: true,
      blocks,
    };
  }

  // Hard gate: returns true only when the machine may run the AI agent now.
  async isLicensed() {
    const state = await this.getState();
    if (state.licensed) {
      this.startHeartbeat();
      return true;
    }
    return false;
  }

  // ─── Google sign-in ─────────────────────────────────────────────────

  async beginGoogleSignIn(onStep) {
    if (this.polling) return { ok: false, message: 'A Google sign-in is already in progress.' };

    try {
      const status = await this.checkStatus();
      if (status && status.google_trial_active) {
        return { ok: true, message: 'Your Google trial is already active.', licensed: true };
      }
    } catch (e) { /* keep going to kick off sign-in */ }

    if (onStep) onStep('Signing in with Google…');
    const begin = await this.serverGet('/v1/google/begin', this.devicePayload());
    if (!begin || !begin.ok || !begin.url) {
      return { ok: false, message: (begin && begin.message) || 'Google sign-in is not available right now.' };
    }

    try {
      await vscode.env.openExternal(vscode.Uri.parse(begin.url));
    } catch (e) {
      return { ok: false, message: 'Could not open your browser for Google sign-in.' };
    }
    if (onStep) onStep('Waiting for you to sign in with Google in your browser…');

    this.polling = true;
    const deadline = Date.now() + GOOGLE_STATE_MAX_WAIT_MS;
    try {
      while (Date.now() < deadline) {
        const state = await this.getState();
        if (state.licensed) {
          return { ok: true, message: 'Licensed. Welcome back to iCode!', licensed: true };
        }
        if (state.reason === 'blocked') {
          return { ok: false, message: state.message, licensed: false };
        }
        await sleep(GOOGLE_STATE_POLL_MS);
      }
      return { ok: false, message: 'Timed out waiting for Google sign-in. Please try again.', licensed: false };
    } finally {
      this.polling = false;
    }
  }

  // ─── Passcode ───────────────────────────────────────────────────────

  async enterPasscode(code) {
    if (!code || !code.trim()) return { ok: false, message: 'Passcode must not be empty.' };
    const result = await this.validatePasscode(code.trim().toUpperCase());
    if (!result) return { ok: false, message: 'Could not reach the iCode server. Check your internet connection.' };
    if (result.ok) {
      this.save({
        machine_id: this.getMachineId(),
        passcode: code.trim().toUpperCase(),
        passcode_id: result.passcode_id || null,
        expires_at: result.expires_at || null,
        validated_at: new Date().toISOString(),
      });
      this.startHeartbeat();
      return { ok: true, message: 'Passcode accepted.' };
    }
    return { ok: false, message: result.message || 'Invalid Passcode.' };
  }

  // ─── Startup (used by the extension) ────────────────────────────────

  async run() {
    const state = await this.getState();
    if (state.licensed) {
      this.startHeartbeat();
      return;
    }
    // Not licensed: the webview shows the license screen. Keep a one-time
    // informational notification but do not attempt to start the agent.
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.lastBeat = Date.now();
    this.heartbeatTimer = setInterval(async () => {
      const now = Date.now();
      const seconds = (now - this.lastBeat) / 1000;
      this.lastBeat = now;
      const res = await this.sendHeartbeat(seconds);
      if (res && res.blocked) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        vscode.window.showErrorMessage('iCode: Your session has been blocked.');
      }
    }, 30000);
    this.context.subscriptions.push({ dispose: () => clearInterval(this.heartbeatTimer) });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { LicenseGate, TRIAL_DAYS };