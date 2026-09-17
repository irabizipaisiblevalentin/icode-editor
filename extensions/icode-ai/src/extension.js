'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const { LicenseGate } = require('./license');

let server = undefined;

function getBundledCliPath(context) {
  const binName = process.platform === 'win32' ? 'icode.exe' : 'icode';
  if (fs.existsSync(path.join(context.extensionPath, 'bin', binName))) {
    return path.join(context.extensionPath, 'bin', binName);
  }
  return binName; // fallback to PATH
}

function startServer(context) {
  if (server) return Promise.resolve(server);

  const cliPath = getBundledCliPath(context);
  const port = 4096;
  const password = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const workspaceFolder = vscode.workspace.workspaceFolders
    && vscode.workspace.workspaceFolders[0] ? vscode.workspace.workspaceFolders[0].uri.fsPath : process.cwd();

  return new Promise((resolve, reject) => {
    const child = cp.spawn(cliPath, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: workspaceFolder,
      env: Object.assign({}, process.env, {
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_SERVER_PASSWORD: password,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('iCode AI server did not start (binary not found?). Install icode CLI.' + (output ? '\n' + output : '')));
    }, 30000);

    function handleData() {
      const m = output.match(/(https?:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timeout);
        server = { url: m[1], password, process: child };
        resolve(server);
      }
    }

    child.stdout && child.stdout.on('data', (d) => { output += d.toString(); handleData(); });
    child.stderr && child.stderr.on('data', (d) => { output += d.toString(); handleData(); });
    child.on('error', (err) => { clearTimeout(timeout); reject(err); });
    child.on('exit', (code) => { if (!server) { clearTimeout(timeout); reject(new Error('iCode AI server exited with code ' + code)); } });
  });
}

function stopServer() {
  if (!server) return;
  try { server.process.kill(); } catch (e) { /* ignore */ }
  server = undefined;
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

class ChatViewProvider {
  static viewType = 'icode-ai.chat';

  constructor(extensionUri, context, gate) {
    this.extensionUri = extensionUri;
    this.context = context;
    this.gate = gate;
    this.view = undefined;
    this.sessionId = undefined;
    this.abortController = undefined;
    this.licensed = false;
  }

  resolveWebviewView(webviewView, _context, _token) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'send') this.handleSend(msg.text);
      if (msg.type === 'newChat') {
        this.sessionId = undefined;
        this.post({ type: 'clear' });
      }
      if (msg.type === 'abort') this.handleAbort();
      if (msg.type === 'checkLicense') this.refreshLicense();
      if (msg.type === 'signinGoogle') this.handleGoogleSignIn();
      if (msg.type === 'enterPasscode') this.handlePasscode(msg.code);
    });

    this.refreshLicense();
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  async refreshLicense() {
    const state = await this.gate.getState();
    this.licensed = !!state.licensed;
    this.post({ type: 'license', licensed: this.licensed, state });
  }

  async handleGoogleSignIn() {
    this.post({ type: 'licenseStatus', message: 'Opening your browser for Google sign-in…' });
    const result = await this.gate.beginGoogleSignIn((step) => {
      this.post({ type: 'licenseStatus', message: step });
    });
    this.post({ type: 'licenseStatus', message: result.message });
    if (result.licensed) {
      this.licensed = true;
      const state = await this.gate.getState();
      this.post({ type: 'license', licensed: true, state });
    } else {
      this.refreshLicense();
    }
  }

  async handlePasscode(code) {
    this.post({ type: 'licenseStatus', message: 'Checking your Passcode…' });
    const result = await this.gate.enterPasscode(code);
    this.post({ type: 'licenseStatus', message: result.message });
    if (result.ok) {
      this.licensed = true;
      const state = await this.gate.getState();
      this.post({ type: 'license', licensed: true, state });
    }
  }

  async getServer() {
    if (!this.licensed) {
      vscode.window.showInformationMessage('iCode AI: Please sign in or enter a Passcode to use the AI.');
      this.refreshLicense();
      return undefined;
    }
    try {
      return await startServer(this.context);
    } catch (e) {
      vscode.window.showErrorMessage('iCode AI: ' + e.message);
      return undefined;
    }
  }

  authHeaders(password) {
    return { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') };
  }

  async ensureSession(url, password) {
    if (this.sessionId) return this.sessionId;
    const res = await fetch(url + '/session', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, this.authHeaders(password)),
      body: JSON.stringify({ title: 'iCode Chat' }),
    });
    if (!res.ok) throw new Error('Failed to create session: ' + res.status);
    const data = await res.json();
    this.sessionId = (data && (data.id || (data.info && data.info.id))) || undefined;
    if (!this.sessionId) throw new Error('No session id returned');
    return this.sessionId;
  }

  async handleSend(text) {
    if (!this.licensed) {
      this.post({ type: 'error', text: 'License required. Sign in with Google or enter a Passcode to use iCode AI.' });
      this.refreshLicense();
      return;
    }
    const srv = await this.getServer();
    if (!srv) return;

    try {
      const sessionId = await this.ensureSession(srv.url, srv.password);
      this.post({ type: 'userMessage', text });
      this.listenEvents(srv.url, srv.password);

      const res = await fetch(srv.url + '/session/' + sessionId + '/prompt_async', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, this.authHeaders(srv.password)),
        body: JSON.stringify({ parts: [{ type: 'text', text }] }),
      });
      if (!res.ok && res.status !== 204) throw new Error('Prompt failed: ' + res.status);
    } catch (e) {
      this.post({ type: 'error', text: e.message });
    }
  }

  async handleAbort() {
    const srv = await this.getServer();
    if (!srv || !this.sessionId) return;
    try {
      await fetch(srv.url + '/session/' + this.sessionId + '/abort', {
        method: 'POST',
        headers: this.authHeaders(srv.password),
      });
    } catch (e) { /* ignore */ }
  }

  async listenEvents(url, password) {
    if (this.abortController) this.abortController.abort();
    this.abortController = new AbortController();

    try {
      const res = await fetch(url + '/event', {
        headers: this.authHeaders(password),
        signal: this.abortController.signal,
      });
      if (!res.ok || !res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              this.processEvent(event);
            } catch (e) { /* ignore parse errors */ }
          }
        }
      }
    } catch (e) { /* aborted or disconnected */ }
  }

  processEvent(event) {
    const type = event.type || '';
    const props = event.properties || event;

    if (type === 'message.created' || type === 'message.updated' || type === 'part.created' || type === 'part.updated') {
      if (props.role === 'user') return;
      const text = props.content || props.text || props.parts;
      if (text) {
        const chunk = Array.isArray(text) ? JSON.stringify(text) : String(text);
        this.post({ type: 'assistantChunk', text: chunk, done: false });
      }
    }

    if (type === 'session.status' || type === 'session.updated' || type === 'session.idle') {
      const status = props.status || props.messageStatus;
      if (status === 'idle' || status === 'completed' || props.status === 'idle') {
        this.post({ type: 'assistantChunk', text: '', done: true });
      }
    }

    if (type && type.includes('permission')) {
      const desc = props.description || props.message || '';
      vscode.window.showInformationMessage('iCode AI: ' + desc, 'OK').then(() => {});
    }
  }

  isWebviewAsset(className) {
    return className === 'chat' || className === 'chat.css' || className === 'chat.js';
  }

  getHtml(webview) {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*;">
  <link rel="stylesheet" href="${styleUri}">
  <title>iCode AI</title>
</head>
<body>
  <div id="app">
    <div id="toolbar">
      <span class="title">iCode AI</span>
      <button id="new-chat" title="New Chat">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z"/></svg>
      </button>
    </div>
    <div id="messages"></div>
    <div id="license-screen" class="hidden">
      <div class="license-card">
        <h2>iCode AI</h2>
        <p id="license-message">You need a license to use iCode AI.</p>
        <p class="license-sub">Sign in with Google for a free 21-day trial, or enter a payment Passcode.</p>
        <div id="passcode-wrap" class="hidden">
          <input id="passcode-input" type="text" placeholder="Your Payment Passcode" autocapitalize="characters" autocomplete="off" spellcheck="false">
          <button id="passcode-submit">Activate</button>
        </div>
        <button id="google-btn" class="primary">Sign in with Google</button>
        <button id="passcode-btn">I have a Passcode</button>
        <p class="license-status" id="license-status"></p>
      </div>
    </div>
    <div id="input-area">
      <textarea id="input" placeholder="Ask iCode AI to edit code, refactor, explain..." rows="1"></textarea>
      <button id="send" title="Send (Enter)">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 2.25a.755.755 0 011-.71l11.25 5.25a.755.755 0 010 1.36L2.5 13.46a.75.75 0 01-1-.71V9.06a.75.75 0 01.68-.74l4.07-.34a.25.25 0 00.21-.18l.47-1.85a.25.25 0 00-.24-.31H2.25a.75.75 0 01-.75-.75V2.25z"/></svg>
      </button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function activate(context) {
  const gate = new LicenseGate(context);
  const provider = new ChatViewProvider(context.extensionUri, context, gate);

  context.subscriptions.push(vscode.commands.registerCommand('icode-ai.payment', async () => {
    const state = await gate.getState();
    if (!state.licensed) {
      await vscode.commands.executeCommand(ChatViewProvider.viewType + '.focus');
    }
  }));
  setImmediate(() => {
    gate.run();
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  context.subscriptions.push(vscode.commands.registerCommand('icode-ai.newChat', () => {
    vscode.commands.executeCommand('workbench.view.extension.icode-ai');
    vscode.commands.executeCommand(ChatViewProvider.viewType + '.focus');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('icode-ai.focus', () => {
    vscode.commands.executeCommand('workbench.view.extension.icode-ai');
    vscode.commands.executeCommand(ChatViewProvider.viewType + '.focus');
  }));
  context.subscriptions.push({ dispose: () => stopServer() });
}

function deactivate() {
  stopServer();
}

module.exports = { activate, deactivate };