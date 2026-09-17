'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CONTROL_URL = process.env.ICODE_CONTROL_URL || 'https://icode-s05p.onrender.com';
const TRIAL_DAYS = 21;

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
      try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000 }).trim(); } catch (e) { return ''; }
    };
    const ioreg = run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    parts = [
      run('sysctl', ['-n', 'hw.model']),
      (ioreg.match(/IOPlatformSerialNumber" = "([^"]+)"/) || [])[1] || '',
      (ioreg.match(/IOPlatformUUID" = "([^"]+)"/) || [])[1] || '',
    ];
  } else if (process.platform === 'win32') {
    try {
      parts = [execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID'], { encoding: 'utf8', timeout: 2000 }).trim()];
    } catch (e) { parts = []; }
  }
  const joined = parts.join('|').trim();
  if (!joined) return '';
  return crypto.createHash('sha256').update(joined).digest('hex').slice(0, 32);
}

class LicenseGate {
  constructor(context) {
    this.context = context;
    this.storagePath = path.join(context.globalStorageUri.fsPath, 'license.json');
    this.heartbeatTimer = undefined;
    this.lastBeat = Date.now();
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

  async run() {
    const stored = this.load();

    if (!stored) {
      await this.firstRun();
      return;
    }

    if (stored.expires_at && new Date(stored.expires_at) < new Date()) {
      await this.promptForPasscode('Your trial has ended. To keep using iCode, pay 1,000 RWF and get a Passcode.');
      return;
    }

    const status = await this.checkStatus();
    if (!status) {
      const hoursSinceValidation = (Date.now() - new Date(stored.validated_at).getTime()) / (1000 * 60 * 60);
      if (hoursSinceValidation < 24) {
        this.startHeartbeat();
        return;
      }
      await this.promptForPasscode('Could not verify the Passcode. Please check your internet connection.');
      return;
    }

    if (status.blocked) {
      await this.promptForPasscode(status.message || 'Your access to iCode has been revoked.');
      return;
    }
    if (status.passcode_blocked) {
      await this.promptForPasscode(status.message || 'Your access to iCode has been revoked. Please contact the iCode admin.');
      return;
    }
    if (status.passcode_expired) {
      await this.promptForPasscode(status.message || 'Your trial has ended. To keep using iCode, pay 1,000 RWF and get a Passcode.');
      return;
    }
    if (!status.ok || !status.passcode_valid) {
      await this.promptForPasscode(status.message || 'Your Passcode is no longer valid. Please contact support.');
      return;
    }

    if (status.expires_at && new Date(status.expires_at) < new Date()) {
      await this.promptForPasscode('Your trial has ended. To keep using iCode, pay 1,000 RWF and get a Passcode.');
      return;
    }

    if (stored.passcode === 'TRIAL') {
      const daysLeft = status.expires_at
        ? Math.max(0, Math.ceil((new Date(status.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
        : TRIAL_DAYS;
      const action = await vscode.window.showInformationMessage(
        `Welcome back to iCode! You have ${daysLeft} day(s) of trial remaining. To keep using iCode after the trial, pay 1,000 RWF and enter your Payment Passcode.`,
        'Enter Passcode'
      );
      if (action === 'Enter Passcode') {
        await this.promptForPasscodeInput();
      }
    }

    this.startHeartbeat();
  }

  async firstRun() {
    const trial = await this.startTrial();
    if (!trial) {
      vscode.window.showErrorMessage('iCode: Could not reach the iCode server. Check your internet connection.');
      return;
    }
    if (trial.trial_active && trial.expires_at) {
      this.save({
        machine_id: this.getMachineId(),
        passcode: 'TRIAL',
        passcode_id: null,
        expires_at: trial.expires_at,
        validated_at: new Date().toISOString(),
      });
      const days = trial.remaining_days || TRIAL_DAYS;
      const until = new Date(trial.expires_at).toLocaleDateString();
      const action = await vscode.window.showInformationMessage(
        `Welcome to iCode! You have a free ${days}-day trial. To keep using iCode after the trial, pay 1,000 RWF and enter your Payment Passcode. Trial ends: ${until}.`,
        'Enter Passcode'
      );
      if (action === 'Enter Passcode') {
        await this.promptForPasscodeInput();
      }
      this.startHeartbeat();
      return;
    }
    await this.promptForPasscode(trial.message || 'Your trial has ended. To keep using iCode, pay 1,000 RWF and get a Passcode.');
  }

  async promptForPasscode(message) {
    const action = await vscode.window.showWarningMessage(
      'iCode: ' + message,
      'Pay for a Passcode',
      'Enter Passcode'
    );
    if (action === 'Pay for a Passcode') {
      vscode.window.showInformationMessage(
        'iCode: Pay 1,000 RWF and fill in the Google Form to get a new Passcode, as the iCode control server says. You will receive a Passcode by email.'
      );
      return;
    }
    if (action === 'Enter Passcode') {
      await this.promptForPasscodeInput();
      return;
    }
  }

  async promptForPasscodeInput() {
    const code = await vscode.window.showInputBox({
      prompt: 'Enter your iCode Payment Passcode',
      placeHolder: 'Your Passcode',
      ignoreFocusOut: true,
    });
    if (!code || !code.trim()) return;
    const result = await this.validatePasscode(code.trim().toUpperCase());
    if (!result) {
      vscode.window.showErrorMessage('iCode: Could not reach the iCode server. Check your internet connection.');
      return;
    }
    if (result.ok) {
      this.save({
        machine_id: this.getMachineId(),
        passcode: code.trim().toUpperCase(),
        passcode_id: result.passcode_id || null,
        expires_at: result.expires_at || null,
        validated_at: new Date().toISOString(),
      });
      vscode.window.showInformationMessage('iCode: Passcode accepted.');
      this.startHeartbeat();
      return;
    }
    vscode.window.showErrorMessage('iCode: ' + (result.message || 'Invalid Passcode.'));
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

module.exports = { LicenseGate };