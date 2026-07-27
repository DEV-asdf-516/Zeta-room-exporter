import { advanceBookmarkRange, bookmarkRangeBounds } from '../core/range-selection.js';

const button = document.querySelector('#exportButton');
const status = document.querySelector('#status');
const jobActions = document.querySelector('#jobActions');
const diagnosticButton = document.querySelector('#diagnosticButton');
const deleteButton = document.querySelector('#deleteButton');
const allRangeButton = document.querySelector('#allRangeButton');
const bookmarkRangeButton = document.querySelector('#bookmarkRangeButton');
const bookmarkRangePanel = document.querySelector('#bookmarkRangePanel');
const bookmarkList = document.querySelector('#bookmarkList');
const rangeInstruction = document.querySelector('#rangeInstruction');
const resetRangeButton = document.querySelector('#resetRangeButton');
const applyRangeButton = document.querySelector('#applyRangeButton');

function dropdown(name) {
  return {
    picker: document.querySelector(`#${name}Picker`),
    trigger: document.querySelector(`#${name}Trigger`),
    menu: document.querySelector(`#${name}Menu`),
    label: document.querySelector(`#${name}Label`),
  };
}

const formatDropdown = dropdown('format');
const rangeDropdown = dropdown('range');
const dropdowns = [formatDropdown, rangeDropdown];

let selectedFormat = 'json';
let selectedRange = 'all';
let selectedStartBookmark = '';
let selectedEndBookmark = '';
let pendingRange = 'all';
let pendingStartBookmark = '';
let pendingEndBookmark = '';
let bookmarks = [];
let bookmarksLoaded = false;
let currentJob = null;
let active = false;
let currentRoomId = null;

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function closeDropdown(item) {
  item.menu.hidden = true;
  item.trigger.setAttribute('aria-expanded', 'false');
}

function closeAllDropdowns(except) {
  dropdowns.forEach((item) => {
    if (item !== except) {
      closeDropdown(item);
    }
  });
}

function selectDropdownValue(item, value) {
  const option = [...item.menu.querySelectorAll('[data-value]')]
    .find((candidate) => candidate.dataset.value === value);
  item.menu.querySelectorAll('[data-value]').forEach((candidate) => {
    candidate.setAttribute('aria-selected', String(candidate === option));
  });
  if (option) {
    item.label.textContent = option.textContent;
  }
  closeDropdown(item);
}

function setFormat(format) {
  selectedFormat = format;
  selectDropdownValue(formatDropdown, format);
}

function bookmarkName(bookmark) {
  if (!bookmark) {
    return '북마크';
  }
  return bookmark.title
    ? `${bookmark.title} (${bookmark.dateLabel})`
    : bookmark.dateLabel;
}

function updateRangeLabel() {
  if (selectedRange === 'all') {
    rangeDropdown.label.textContent = '전체 대화';
    return;
  }
  const start = bookmarks.find((item) => item.id === selectedStartBookmark);
  const end = bookmarks.find((item) => item.id === selectedEndBookmark);
  rangeDropdown.label.textContent = start && end
    ? `${bookmarkName(start)} → ${bookmarkName(end)}`
    : '저장된 북마크 범위';
}

function setPendingMode(mode) {
  pendingRange = mode;
  allRangeButton.setAttribute('aria-pressed', String(mode === 'all'));
  bookmarkRangeButton.setAttribute('aria-pressed', String(mode === 'bookmarks'));
  bookmarkRangePanel.hidden = mode !== 'bookmarks';
  applyRangeButton.disabled = mode === 'bookmarks'
    && (!pendingStartBookmark || !pendingEndBookmark);
}

function renderBookmarkSelection() {
  const orderedIds = bookmarks.map((item) => item.id);
  const bounds = bookmarkRangeBounds(
    pendingStartBookmark,
    pendingEndBookmark,
    orderedIds,
  );
  const startIndex = bounds.startIndex;
  const endIndex = pendingEndBookmark ? bounds.endIndex : -1;
  const rangeStart = bounds.startIndex;
  const rangeEnd = bounds.endIndex;

  bookmarkList.querySelectorAll('.bookmark-option').forEach((option) => {
    const index = Number(option.dataset.index);
    const isStart = index === startIndex;
    const isEnd = index === endIndex;
    const inRange = rangeStart >= 0 && index >= rangeStart && index <= rangeEnd;
    option.classList.toggle('in-range', inRange);
    option.classList.toggle('endpoint', isStart || isEnd);
    option.setAttribute('aria-selected', String(isStart || isEnd));
    option.querySelector('.bookmark-badge').textContent = isStart && isEnd
      ? '시작·끝'
      : isStart ? '시작' : isEnd ? '끝' : '';
  });

  if (!pendingStartBookmark) {
    rangeInstruction.textContent = '1단계 · 시작 지점을 선택하세요.';
  } else if (!pendingEndBookmark) {
    rangeInstruction.textContent = '2단계 · 끝 지점을 선택하세요.';
  } else {
    rangeInstruction.textContent = '선택된 구간입니다. 다시 누르면 새로 선택합니다.';
  }
  applyRangeButton.disabled = pendingRange === 'bookmarks'
    && (!pendingStartBookmark || !pendingEndBookmark);
}

function createBookmarkOptions() {
  bookmarkList.replaceChildren();
  if (!bookmarks.length) {
    const empty = document.createElement('p');
    empty.className = 'range-instruction';
    empty.textContent = '사용할 수 있는 북마크가 없습니다.';
    bookmarkList.append(empty);
    return;
  }
  bookmarks.forEach((bookmark, index) => {
    const option = document.createElement('button');
    option.className = 'bookmark-option';
    option.type = 'button';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    option.tabIndex = index === 0 ? 0 : -1;
    option.dataset.index = String(index);
    option.dataset.value = bookmark.id;

    const title = document.createElement('span');
    title.className = 'bookmark-title';
    title.textContent = bookmark.title || '북마크';
    const preview = document.createElement('span');
    preview.className = 'bookmark-preview';
    preview.textContent = `${bookmark.dateLabel} · ${bookmark.previewText || '내용 미리보기 없음'}`;
    const badge = document.createElement('span');
    badge.className = 'bookmark-badge';
    option.append(title, preview, badge);
    bookmarkList.append(option);
  });
  renderBookmarkSelection();
}

async function loadBookmarks() {
  if (bookmarksLoaded) {
    return;
  }
  rangeInstruction.textContent = '북마크를 불러오는 중…';
  applyRangeButton.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'GET_BOOKMARKS' });
  if (!response?.ok) {
    throw new Error(response?.error || '북마크를 불러오지 못했습니다.');
  }
  bookmarks = response.bookmarks;
  bookmarksLoaded = true;
  createBookmarkOptions();
  updateRangeLabel();
}

async function openRangePicker() {
  if (rangeDropdown.trigger.disabled) {
    return;
  }
  if (!rangeDropdown.menu.hidden) {
    closeDropdown(rangeDropdown);
    return;
  }
  closeAllDropdowns(rangeDropdown);
  pendingRange = selectedRange;
  pendingStartBookmark = selectedStartBookmark;
  pendingEndBookmark = selectedEndBookmark;
  setPendingMode(pendingRange);
  rangeDropdown.menu.hidden = false;
  rangeDropdown.trigger.setAttribute('aria-expanded', 'true');
  if (pendingRange === 'bookmarks') {
    try {
      await loadBookmarks();
      renderBookmarkSelection();
    } catch (error) {
      setStatus(error.message, true);
    }
  }
}

function setControlsDisabled(disabled) {
  formatDropdown.trigger.disabled = disabled;
  rangeDropdown.trigger.disabled = disabled;
  if (disabled) {
    closeAllDropdowns();
  }
}

function renderJob(job, isActive = active) {
  currentJob = job || null;
  active = isActive;
  jobActions.hidden = isActive || !job
    || !['paused', 'failed', 'collecting', 'assembling'].includes(job.state);
  diagnosticButton.hidden = !job || !['paused', 'failed'].includes(job.state);
  if (!job) {
    button.disabled = false;
    button.textContent = '현재 Room 내보내기';
    setControlsDisabled(false);
    return;
  }

  setFormat(job.format);
  selectedRange = job.rangeType || 'all';
  updateRangeLabel();
  const progress = `${job.messageCount.toLocaleString()}개 메시지 · ${job.pageCount.toLocaleString()}페이지`;
  if (isActive) {
    button.disabled = true;
    button.textContent = job.state === 'assembling' ? '파일 생성 중…' : '수집 중…';
    setStatus(job.state === 'assembling' ? `${progress} · 파일 생성 중` : `${progress} 수집됨`);
    setControlsDisabled(true);
  } else if (['paused', 'collecting', 'assembling'].includes(job.state)) {
    button.disabled = false;
    button.textContent = '이어받기';
    setStatus(`${progress} · 저장된 지점부터 이어받을 수 있습니다.`);
    setControlsDisabled(true);
  } else {
    button.disabled = true;
    button.textContent = '내보내기 실패';
    setStatus(`${progress} · 작업이 안전하게 중단되었습니다.`, true);
    setControlsDisabled(true);
  }
}

formatDropdown.trigger.addEventListener('click', () => {
  if (formatDropdown.trigger.disabled) {
    return;
  }
  const willOpen = formatDropdown.menu.hidden;
  closeAllDropdowns(formatDropdown);
  formatDropdown.menu.hidden = !willOpen;
  formatDropdown.trigger.setAttribute('aria-expanded', String(willOpen));
});

formatDropdown.menu.addEventListener('click', async (event) => {
  const option = event.target.closest('[data-value]');
  if (!option) {
    return;
  }
  setFormat(option.dataset.value);
  await chrome.storage.local.set({ exportFormat: selectedFormat });
});

rangeDropdown.trigger.addEventListener('click', openRangePicker);

allRangeButton.addEventListener('click', () => setPendingMode('all'));
bookmarkRangeButton.addEventListener('click', async () => {
  setPendingMode('bookmarks');
  try {
    await loadBookmarks();
    renderBookmarkSelection();
  } catch (error) {
    setStatus(error.message, true);
  }
});

bookmarkList.addEventListener('click', (event) => {
  const option = event.target.closest('.bookmark-option');
  if (!option) {
    return;
  }
  const next = advanceBookmarkRange(
    { startId: pendingStartBookmark, endId: pendingEndBookmark },
    option.dataset.value,
    bookmarks.map((item) => item.id),
  );
  pendingStartBookmark = next.startId;
  pendingEndBookmark = next.endId;
  bookmarkList.querySelectorAll('.bookmark-option').forEach((item) => {
    item.tabIndex = item === option ? 0 : -1;
  });
  renderBookmarkSelection();
});

bookmarkList.addEventListener('keydown', (event) => {
  const option = event.target.closest('.bookmark-option');
  if (!option || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    return;
  }
  const options = [...bookmarkList.querySelectorAll('.bookmark-option')];
  const currentIndex = options.indexOf(option);
  const nextIndex = event.key === 'Home' ? 0
    : event.key === 'End' ? options.length - 1
      : event.key === 'ArrowDown' ? Math.min(options.length - 1, currentIndex + 1)
        : Math.max(0, currentIndex - 1);
  event.preventDefault();
  option.tabIndex = -1;
  if (options[nextIndex]) {
    options[nextIndex].tabIndex = 0;
  }
  options[nextIndex]?.focus();
});

resetRangeButton.addEventListener('click', () => {
  pendingStartBookmark = '';
  pendingEndBookmark = '';
  if (pendingRange === 'bookmarks') {
    renderBookmarkSelection();
  }
});

applyRangeButton.addEventListener('click', () => {
  if (pendingRange === 'bookmarks' && (!pendingStartBookmark || !pendingEndBookmark)) {
    return;
  }
  selectedRange = pendingRange;
  selectedStartBookmark = pendingRange === 'bookmarks' ? pendingStartBookmark : '';
  selectedEndBookmark = pendingRange === 'bookmarks' ? pendingEndBookmark : '';
  updateRangeLabel();
  closeDropdown(rangeDropdown);
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.dropdown')) {
    closeAllDropdowns();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }
  const openDropdown = dropdowns.find((item) => !item.menu.hidden);
  if (!openDropdown) {
    return;
  }
  closeDropdown(openDropdown);
  openDropdown.trigger.focus();
});

chrome.storage.local.get({ exportFormat: 'json' }).then(({ exportFormat }) => {
  if (exportFormat === 'json' || exportFormat === 'txt') {
    setFormat(exportFormat);
  }
});

button.addEventListener('click', async () => {
  button.disabled = true;
  setControlsDisabled(true);
  setStatus(currentJob ? '저장된 작업을 이어받는 중…' : '내보내기를 시작하는 중…');
  const range = currentJob || selectedRange === 'all'
    ? { type: 'all' }
    : {
      type: 'bookmarks',
      startBookmarkId: selectedStartBookmark,
      endBookmarkId: selectedEndBookmark,
    };
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'START_EXPORT',
      format: selectedFormat,
      range,
      jobId: currentJob?.jobId,
    });
    if (!response?.ok) {
      throw new Error(response?.error || '내보내기에 실패했습니다.');
    }
    currentJob = null;
    active = false;
    jobActions.hidden = true;
    setStatus(`${response.messageCount.toLocaleString()}개 메시지를 ${response.fileCount}개 파일로 저장했습니다.`);
    renderJob(null, false);
  } catch (error) {
    const context = await chrome.runtime.sendMessage({ type: 'GET_EXPORT_CONTEXT' }).catch(() => null);
    if (context?.ok) {
      renderJob(context.job, context.active);
    } else {
      button.disabled = false;
    }
    setStatus(error.message || '내보내기에 실패했습니다.', true);
  }
});

diagnosticButton.addEventListener('click', async () => {
  if (!currentJob) {
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: 'DOWNLOAD_DIAGNOSTICS', jobId: currentJob.jobId,
  });
  if (!response?.ok) {
    setStatus(response?.error || '진단 로그 저장에 실패했습니다.', true);
  }
});

deleteButton.addEventListener('click', async () => {
  if (!currentJob) {
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: 'DELETE_EXPORT_JOB', jobId: currentJob.jobId,
  });
  if (!response?.ok) {
    setStatus(response?.error || '작업 삭제에 실패했습니다.', true);
    return;
  }
  currentJob = null;
  active = false;
  jobActions.hidden = true;
  setStatus('저장된 작업을 삭제했습니다.');
  renderJob(null, false);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.roomId && currentRoomId && message.roomId !== currentRoomId) {
    return;
  }
  if (message.type === 'EXPORT_PROGRESS' && message.job) {
    renderJob(message.job, true);
  }
  if (message.type === 'EXPORT_RETRY') {
    const reason = message.status ? `HTTP ${message.status}` : '네트워크 오류';
    setStatus(`Zeta 서버 재시도 중 (${reason}) · ${Math.ceil(message.waitMs / 1000)}초 후 재개`);
  }
  if (message.type === 'EXPORT_FAILED') {
    renderJob(message.job, false);
    setStatus(message.error || '내보내기에 실패했습니다.', true);
  }
  if (message.type === 'EXPORT_COMPLETED') {
    currentJob = null;
    active = false;
    renderJob(null, false);
    jobActions.hidden = true;
    setStatus(`${message.messageCount.toLocaleString()}개 메시지를 ${message.fileCount}개 파일로 저장했습니다.`);
  }
});

(async () => {
  try {
    const context = await chrome.runtime.sendMessage({ type: 'GET_EXPORT_CONTEXT' });
    if (!context?.ok) {
      throw new Error(context?.error || '현재 작업 상태를 확인하지 못했습니다.');
    }
    currentRoomId = context.roomId;
    renderJob(context.job, context.active);
    if (!context.job && context.storageWarning) {
      setStatus(context.storageWarning, true);
    }
  } catch (error) {
    setStatus(error.message, true);
    button.disabled = true;
  }
})();
