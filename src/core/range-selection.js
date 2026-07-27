export function advanceBookmarkRange({ startId, endId }, selectedId, orderedIds) {
  const selectedIndex = orderedIds.indexOf(selectedId);
  const startIndex = orderedIds.indexOf(startId);
  if (selectedIndex < 0) {
    return { startId, endId };
  }
  if (!startId || endId) {
    return { startId: selectedId, endId: '' };
  }
  if (selectedIndex < startIndex) {
    return { startId: selectedId, endId: '' };
  }
  return { startId, endId: selectedId };
}

export function bookmarkRangeBounds(startId, endId, orderedIds) {
  const startIndex = orderedIds.indexOf(startId);
  const endIndex = orderedIds.indexOf(endId);
  if (startIndex < 0) {
    return { startIndex: -1, endIndex: -1 };
  }
  return {
    startIndex,
    endIndex: endIndex < 0 ? startIndex : endIndex,
  };
}
