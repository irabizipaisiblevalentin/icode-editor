(function () {
  'use strict';

  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const newChatBtn = document.getElementById('new-chat');

  let currentAssistantEl = null;
  let currentAssistantText = '';

  const vscode = acquireVsCodeApi();

  // --- Send ---

  function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autoResize();
    vscode.postMessage({ type: 'send', text });
    appendUserMessage(text);
    startAssistantBlock();
  }

  sendBtn.addEventListener('click', sendMessage);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  newChatBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'newChat' });
  });

  // --- Auto-resize textarea ---

  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  input.addEventListener('input', autoResize);

  // --- Message rendering ---

  function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function appendUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'message user';
    el.innerHTML = `
      <div class="message-role">You</div>
      <div class="message-content">${escapeHtml(text)}</div>
    `;
    messages.appendChild(el);
    scrollToBottom();
  }

  function startAssistantBlock() {
    currentAssistantText = '';
    currentAssistantEl = document.createElement('div');
    currentAssistantEl.className = 'message assistant';
    currentAssistantEl.innerHTML = `
      <div class="message-role">iCode AI</div>
      <div class="message-content"><span class="thinking">Thinking...</span></div>
    `;
    messages.appendChild(currentAssistantEl);
    scrollToBottom();
  }

  function updateAssistantContent(text, done) {
    if (!currentAssistantEl) return;
    currentAssistantText = text;
    const contentEl = currentAssistantEl.querySelector('.message-content');
    if (!contentEl) return;

    if (text) {
      contentEl.innerHTML = renderMarkdown(text);
      if (!done) {
        const cursor = document.createElement('span');
        cursor.className = 'cursor';
        contentEl.appendChild(cursor);
      }
    } else if (done) {
      // Empty done — remove thinking indicator if nothing was streamed
      contentEl.innerHTML = '<span class="thinking" style="opacity:0.5">Done.</span>';
    }
    scrollToBottom();
  }

  function appendToolCall(name, detail) {
    if (!currentAssistantEl) return;
    const contentEl = currentAssistantEl.querySelector('.message-content');
    if (!contentEl) return;

    // Remove thinking indicator
    const thinking = contentEl.querySelector('.thinking');
    if (thinking) thinking.remove();

    const toolEl = document.createElement('div');
    toolEl.className = 'tool-call';
    toolEl.innerHTML = `
      <span class="tool-name">${escapeHtml(name)}</span>
      ${detail ? `<div class="tool-detail">${escapeHtml(detail)}</div>` : ''}
    `;
    contentEl.appendChild(toolEl);
    scrollToBottom();
  }

  // --- Simple markdown renderer ---

  function renderMarkdown(text) {
    let html = escapeHtml(text);

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      return `<pre><code class="lang-${lang}">${code}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // --- Messages from extension host ---

  window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
      case 'userMessage':
        // Already rendered locally
        break;

      case 'assistantChunk':
        if (msg.done) {
          updateAssistantContent(currentAssistantText, true);
          currentAssistantEl = null;
          currentAssistantText = '';
        } else {
          updateAssistantContent(currentAssistantText + msg.text, false);
        }
        break;

      case 'toolCall':
        appendToolCall(msg.name, msg.detail);
        break;

      case 'error':
        startAssistantBlock();
        updateAssistantContent('Error: ' + msg.text, true);
        currentAssistantEl = null;
        currentAssistantText = '';
        break;

      case 'clear':
        messages.innerHTML = '';
        currentAssistantEl = null;
        currentAssistantText = '';
        break;
    }
  });

  // Focus input on load
  input.focus();
})();
