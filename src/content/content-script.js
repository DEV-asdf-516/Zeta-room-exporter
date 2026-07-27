let lastContextMessageId = null;
let toastTimer;

document.addEventListener('contextmenu', (event) => {
  lastContextMessageId = globalThis.ZetaMessageContext.findMessageId(event.composedPath());
}, true);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GET_CONTEXT_MESSAGE') {
    sendResponse({ messageId: lastContextMessageId });
    return;
  }
  if (message?.type === 'SHOW_BOOKMARK_RESULT') {
    showToast(message.message, Boolean(message.isError));
  }
});

function showToast(message, isError) {
  document.querySelector('#zeta-exporter-toast')?.remove();
  clearTimeout(toastTimer);
  const toast = document.createElement('div');
  toast.id = 'zeta-exporter-toast';
  toast.textContent = message;
  Object.assign(toast.style, {
    position: 'fixed',
    right: '20px',
    bottom: '20px',
    zIndex: '2147483647',
    maxWidth: '320px',
    padding: '11px 14px',
    borderRadius: '8px',
    color: '#fff',
    background: isError ? '#b91c1c' : '#1d4ed8',
    boxShadow: '0 8px 24px rgb(15 23 42 / 24%)',
    font: '14px/1.45 system-ui, sans-serif',
  });
  document.documentElement.append(toast);
  toastTimer = setTimeout(() => toast.remove(), 4000);
}
