const button = document.querySelector('#exportButton');
const status = document.querySelector('#status');
const formatPicker = document.querySelector('#formatPicker');
const formatTrigger = document.querySelector('#formatTrigger');
const formatMenu = document.querySelector('#formatMenu');
const formatLabel = document.querySelector('#formatLabel');
let selectedFormat = 'json';

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function closeFormatMenu() {
  formatMenu.hidden = true;
  formatTrigger.setAttribute('aria-expanded', 'false');
}

function setFormat(format) {
  selectedFormat = format;
  const option = formatMenu.querySelector(`[data-format="${format}"]`);
  formatLabel.textContent = option.textContent;
  formatMenu.querySelectorAll('[data-format]').forEach((item) => {
    item.setAttribute('aria-selected', String(item === option));
  });
}

chrome.storage.local.get({ exportFormat: 'json' }).then(({ exportFormat }) => {
  if (exportFormat === 'json' || exportFormat === 'txt') setFormat(exportFormat);
});

formatTrigger.addEventListener('click', () => {
  const willOpen = formatMenu.hidden;
  formatMenu.hidden = !willOpen;
  formatTrigger.setAttribute('aria-expanded', String(willOpen));
});

formatMenu.addEventListener('click', (event) => {
  const option = event.target.closest('[data-format]');
  if (!option) return;
  setFormat(option.dataset.format);
  chrome.storage.local.set({ exportFormat: selectedFormat });
  closeFormatMenu();
});

document.addEventListener('click', (event) => {
  if (!formatPicker.contains(event.target)) closeFormatMenu();
});

button.addEventListener('click', async () => {
  button.disabled = true;
  setStatus('대화를 가져오는 중…');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'EXPORT_CURRENT_ROOM',
      format: selectedFormat,
    });

    if (!response?.ok) {
      throw new Error(response?.error || '내보내기에 실패했습니다.');
    }

    setStatus(`${response.messageCount}개 메시지를 ${response.format.toUpperCase()} 파일로 저장했습니다.`);
  } catch (error) {
    setStatus(error.message || '내보내기에 실패했습니다.', true);
  } finally {
    button.disabled = false;
  }
});
