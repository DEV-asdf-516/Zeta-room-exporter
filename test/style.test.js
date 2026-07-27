import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await javascriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryPath);
    }
  }
  return files;
}

function skipQuoted(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
    } else if (source[index] === quote) {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return index;
}

function skipTrivia(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
    } else if (source.startsWith('//', index)) {
      index = source.indexOf('\n', index + 2);
      if (index < 0) {
        return source.length;
      }
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      return end < 0 ? source.length : skipTrivia(source, end + 2);
    } else {
      break;
    }
  }
  return index;
}

function closingParenthesis(source, start) {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    if (source[index] === '"' || source[index] === "'" || source[index] === '`') {
      index = skipQuoted(source, index);
      continue;
    }
    if (source.startsWith('//', index) || source.startsWith('/*', index)) {
      index = skipTrivia(source, index);
      continue;
    }
    if (source[index] === '(') {
      depth += 1;
    } else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
    index += 1;
  }
  return -1;
}

function unbracedIfLines(source) {
  const lines = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] === '"' || source[index] === "'" || source[index] === '`') {
      index = skipQuoted(source, index);
      continue;
    }
    if (source.startsWith('//', index) || source.startsWith('/*', index)) {
      index = skipTrivia(source, index);
      continue;
    }
    const isIf = source.startsWith('if', index)
      && !/[\w$]/.test(source[index - 1] || '')
      && !/[\w$]/.test(source[index + 2] || '');
    if (isIf) {
      const conditionStart = skipTrivia(source, index + 2);
      if (source[conditionStart] === '(') {
        const conditionEnd = closingParenthesis(source, conditionStart);
        const bodyStart = skipTrivia(source, conditionEnd + 1);
        if (conditionEnd < 0 || source[bodyStart] !== '{') {
          lines.push(source.slice(0, index).split('\n').length);
        }
        index = Math.max(index + 2, conditionEnd + 1);
        continue;
      }
    }
    index += 1;
  }
  return lines;
}

test('all if statements use braces', async () => {
  const files = [
    ...await javascriptFiles(path.join(projectRoot, 'src')),
    ...await javascriptFiles(path.join(projectRoot, 'test')),
  ];
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const line of unbracedIfLines(source)) {
      violations.push(`${path.relative(projectRoot, file)}:${line}`);
    }
  }
  assert.deepEqual(violations, [], `if 문에 중괄호가 필요합니다:\n${violations.join('\n')}`);
});
