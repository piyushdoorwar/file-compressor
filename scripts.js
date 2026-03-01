/* ============================================================
   FilePress - Application Logic
   Browser-based DEFLATE via CompressionStream + pure-JS ZIP builder.
   ============================================================ */

(function () {
  'use strict';

  const state = {
    files: [],
    nextId: 1,
    mode: 'balanced',
    algorithm: 'deflate',
    compressedBlob: null,
    compressedFileName: 'archive.zip',
    isCompressing: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);

  const el = {
    dropZone: $('#dropZone'),
    browseBtn: $('#browseBtn'),
    browseFolderBtn: $('#browseFolderBtn'),
    clearBtn: $('#clearBtn'),
    infoBtn: $('#infoBtn'),
    infoModal: $('#infoModal'),
    closeInfoBtn: $('#closeInfoBtn'),
    fileInput: $('#fileInput'),
    folderInput: $('#folderInput'),
    totalSize: $('#totalSize'),
    fileCount: $('#fileCount'),
    estOutput: $('#estOutput'),
    generateBtn: $('#generateBtn'),
    idleState: $('#idleState'),
    activeState: $('#activeState'),
    doneState: $('#doneState'),
    progStatus: $('#progStatus'),
    progPct: $('#progPct'),
    progFill: $('#progFill'),
    progFile: $('#progFile'),
    doneOriginal: $('#doneOriginal'),
    doneCompressed: $('#doneCompressed'),
    doneSaved: $('#doneSaved'),
    downloadBtn: $('#downloadBtn'),
    algorithmSelect: $('#algorithmSelect'),
    presetBtns: $$('.preset-btn'),
    statusBadge: $('#statusBadge'),
    fileCounter: $('#fileCounter'),
    fileTableBody: $('#fileTableBody'),
  };

  function formatSize(bytes) {
    if (bytes === 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = bytes / Math.pow(1024, index);

    return value.toFixed(index === 0 ? 0 : 2) + ' ' + units[index];
  }

  function escapeHTML(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getRelativeName(file) {
    return (file.webkitRelativePath || file.name).replace(/\\/g, '/');
  }

  function fileIdentity(file) {
    return [getRelativeName(file), file.size, file.lastModified].join('|');
  }

  function setStatusBadge(label, stateName) {
    el.statusBadge.textContent = label;
    el.statusBadge.dataset.state = stateName;
  }

  function openInfoModal() {
    el.infoModal.classList.add('active');
    el.infoModal.setAttribute('aria-hidden', 'false');
  }

  function closeInfoModal() {
    el.infoModal.classList.remove('active');
    el.infoModal.setAttribute('aria-hidden', 'true');
  }

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);

    for (let i = 0; i < 256; i++) {
      let crc = i;

      for (let j = 0; j < 8; j++) {
        crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
      }

      table[i] = crc;
    }

    return table;
  })();

  function crc32(buffer) {
    let crc = 0xFFFFFFFF;

    for (let i = 0; i < buffer.length; i++) {
      crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
    }

    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function toDOSTime(date) {
    return (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  }

  function toDOSDate(date) {
    return ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  }

  const HAS_COMPRESSION_STREAM = typeof CompressionStream !== 'undefined';

  async function deflateRaw(data, onProgress) {
    if (!HAS_COMPRESSION_STREAM) return null;

    const stream = new CompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const chunks = [];

    const drain = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    })();

    const chunkSize = 65536;

    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const sliceEnd = Math.min(offset + chunkSize, data.length);
      await writer.write(data.subarray(offset, sliceEnd));

      if (onProgress) {
        onProgress(Math.round((sliceEnd / data.length) * 100));
      }
    }

    await writer.close();
    await drain;

    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(size);
    let cursor = 0;

    for (const chunk of chunks) {
      output.set(chunk, cursor);
      cursor += chunk.length;
    }

    return output;
  }

  function writeU16(value, buffer, offset) {
    const normalized = value & 0xFFFF;
    buffer[offset] = normalized;
    buffer[offset + 1] = normalized >> 8;
  }

  function writeU32(value, buffer, offset) {
    const normalized = value >>> 0;
    buffer[offset] = normalized;
    buffer[offset + 1] = normalized >> 8;
    buffer[offset + 2] = normalized >> 16;
    buffer[offset + 3] = normalized >> 24;
  }

  function buildMultiZip(entries) {
    const encoder = new TextEncoder();
    const now = new Date();
    const dosTime = toDOSTime(now);
    const dosDate = toDOSDate(now);
    let localSize = 0;
    let centralDirectorySize = 0;

    const prepared = entries.map((entry) => {
      const nameBytes = encoder.encode(entry.name);
      localSize += 30 + nameBytes.length + entry.compData.length;
      centralDirectorySize += 46 + nameBytes.length;

      return {
        ...entry,
        nameBytes,
        crc: crc32(entry.rawData),
      };
    });

    const totalSize = localSize + centralDirectorySize + 22;
    const buffer = new Uint8Array(totalSize);
    const offsets = [];
    let offset = 0;

    for (const entry of prepared) {
      offsets.push(offset);
      writeU32(0x04034B50, buffer, offset); offset += 4;
      writeU16(20, buffer, offset); offset += 2;
      writeU16(0, buffer, offset); offset += 2;
      writeU16(entry.method, buffer, offset); offset += 2;
      writeU16(dosTime, buffer, offset); offset += 2;
      writeU16(dosDate, buffer, offset); offset += 2;
      writeU32(entry.crc, buffer, offset); offset += 4;
      writeU32(entry.compData.length, buffer, offset); offset += 4;
      writeU32(entry.rawData.length, buffer, offset); offset += 4;
      writeU16(entry.nameBytes.length, buffer, offset); offset += 2;
      writeU16(0, buffer, offset); offset += 2;
      buffer.set(entry.nameBytes, offset); offset += entry.nameBytes.length;
      buffer.set(entry.compData, offset); offset += entry.compData.length;
    }

    const centralDirectoryOffset = offset;

    for (let i = 0; i < prepared.length; i++) {
      const entry = prepared[i];
      writeU32(0x02014B50, buffer, offset); offset += 4;
      writeU16(20, buffer, offset); offset += 2;
      writeU16(20, buffer, offset); offset += 2;
      writeU16(0, buffer, offset); offset += 2;
      writeU16(entry.method, buffer, offset); offset += 2;
      writeU16(dosTime, buffer, offset); offset += 2;
      writeU16(dosDate, buffer, offset); offset += 2;
      writeU32(entry.crc, buffer, offset); offset += 4;
      writeU32(entry.compData.length, buffer, offset); offset += 4;
      writeU32(entry.rawData.length, buffer, offset); offset += 4;
      writeU16(entry.nameBytes.length, buffer, offset); offset += 2;
      writeU16(0, buffer, offset); offset += 2;
      writeU16(0, buffer, offset); offset += 2;
      writeU16(0, buffer, offset); offset += 2;
      writeU16(0, buffer, offset); offset += 2;
      writeU32(0, buffer, offset); offset += 4;
      writeU32(offsets[i], buffer, offset); offset += 4;
      buffer.set(entry.nameBytes, offset); offset += entry.nameBytes.length;
    }

    const centralDirectoryLength = offset - centralDirectoryOffset;

    writeU32(0x06054B50, buffer, offset); offset += 4;
    writeU16(0, buffer, offset); offset += 2;
    writeU16(0, buffer, offset); offset += 2;
    writeU16(prepared.length, buffer, offset); offset += 2;
    writeU16(prepared.length, buffer, offset); offset += 2;
    writeU32(centralDirectoryLength, buffer, offset); offset += 4;
    writeU32(centralDirectoryOffset, buffer, offset); offset += 4;
    writeU16(0, buffer, offset);

    return new Blob([buffer], { type: 'application/zip' });
  }

  const EXT_COMPRESSED = new Set([
    'zip', 'rar', '7z', 'gz', 'bz2', 'xz', 'zst', 'lz', 'lzma', 'br',
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic',
    'mp3', 'aac', 'ogg', 'opus', 'flac', 'm4a',
    'mp4', 'mkv', 'avi', 'webm', 'mov', 'wmv', 'flv',
    'woff', 'woff2', 'jar', 'apk', 'dmg', 'iso',
  ]);

  const EXT_TEXT = new Set([
    'txt', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
    'json', 'xml', 'svg', 'csv', 'tsv', 'md', 'yml', 'yaml', 'toml', 'ini',
    'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'go', 'rs',
    'swift', 'kt', 'kts', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'psm1',
    'sql', 'graphql', 'proto', 'log', 'cfg', 'conf', 'env',
  ]);

  const EXT_SEMI = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'epub']);
  const EXT_RAW_IMG = new Set(['bmp', 'tiff', 'tif', 'ppm', 'pgm', 'raw', 'dng']);

  function estimateOneFile(file, mode, algorithm) {
    if (algorithm === 'store' || mode === 'fastest') {
      return file.size;
    }

    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let ratio;

    if (EXT_COMPRESSED.has(ext)) ratio = mode === 'maximum' ? 0.97 : 0.98;
    else if (EXT_TEXT.has(ext)) ratio = mode === 'maximum' ? 0.26 : 0.32;
    else if (EXT_RAW_IMG.has(ext)) ratio = mode === 'maximum' ? 0.14 : 0.19;
    else if (ext === 'wav') ratio = mode === 'maximum' ? 0.54 : 0.59;
    else if (EXT_SEMI.has(ext)) ratio = mode === 'maximum' ? 0.87 : 0.92;
    else ratio = mode === 'maximum' ? 0.52 : 0.58;

    return Math.max(Math.round(file.size * ratio), 1);
  }

  function estimateTotal() {
    return state.files.reduce(
      (sum, entry) => sum + estimateOneFile(entry.file, state.mode, state.algorithm),
      0,
    );
  }

  function totalRawSize() {
    return state.files.reduce((sum, entry) => sum + entry.file.size, 0);
  }

  const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tiff', 'tif']);
  const CODE_EXT = new Set(['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'rb', 'php', 'go', 'rs', 'swift', 'kt', 'html', 'htm', 'css', 'json', 'xml', 'yml', 'yaml', 'sh', 'sql']);
  const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'txt', 'md', 'csv']);
  const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'gz', 'bz2', 'xz', 'tar', 'iso']);
  const MEDIA_EXT = new Set(['mp3', 'mp4', 'wav', 'ogg', 'flac', 'aac', 'mkv', 'avi', 'webm', 'mov']);

  function extClass(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (IMG_EXT.has(ext)) return 'img';
    if (CODE_EXT.has(ext)) return 'code';
    if (DOC_EXT.has(ext)) return 'doc';
    if (ARCHIVE_EXT.has(ext)) return 'archive';
    if (MEDIA_EXT.has(ext)) return 'media';
    return 'other';
  }

  function extLabel(name) {
    return (name.split('.').pop() || '?').toUpperCase().slice(0, 4);
  }

  function refreshStats() {
    const rawTotal = totalRawSize();
    const estimated = state.files.length ? estimateTotal() : 0;
    const countLabel = state.files.length + ' item' + (state.files.length === 1 ? '' : 's');

    el.totalSize.textContent = formatSize(rawTotal);
    el.fileCount.textContent = countLabel;
    el.estOutput.textContent = state.files.length ? '~' + formatSize(estimated) : '~0 B';
    el.fileCounter.textContent = countLabel + ' listed';
    el.generateBtn.disabled = state.isCompressing || state.files.length === 0;
    el.clearBtn.disabled = state.isCompressing || state.files.length === 0;
  }

  function renderFileTable() {
    if (state.files.length === 0) {
      if (!state.isCompressing) {
        setStatusBadge('Idle', 'idle');
      }
      el.fileTableBody.innerHTML = '<tr class="empty-row"><td colspan="3" class="empty-cell">No files selected. Use browse, folder import, or drag and drop.</td></tr>';
      refreshStats();
      return;
    }

    el.fileTableBody.innerHTML = '';

    for (const entry of state.files) {
      const row = document.createElement('tr');
      const displayName = getRelativeName(entry.file);

      row.innerHTML = `
        <td>
          <div class="file-path-cell">
            <div class="file-ext-icon ${extClass(entry.file.name)}">${escapeHTML(extLabel(entry.file.name))}</div>
            <span class="file-name-text" title="${escapeHTML(displayName)}">${escapeHTML(displayName)}</span>
          </div>
        </td>
        <td class="file-size-cell">${formatSize(entry.file.size)}</td>
        <td>
          <button class="remove-btn" data-id="${entry.id}" type="button" aria-label="Remove file" title="Remove file">
            <svg class="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 7h16"></path>
              <path d="M10 11v5"></path>
              <path d="M14 11v5"></path>
              <path d="M6 7l1 11a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-11"></path>
              <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"></path>
            </svg>
            <span class="sr-only">Remove</span>
          </button>
        </td>
      `;

      el.fileTableBody.appendChild(row);
    }

    el.fileTableBody.querySelectorAll('.remove-btn').forEach((button) => {
      button.addEventListener('click', () => {
        const id = Number(button.dataset.id);
        state.files = state.files.filter((entry) => entry.id !== id);
        state.compressedBlob = null;
        showProgressState('idle');
        setStatusBadge('Ready', 'idle');
        renderFileTable();
      });
    });

    refreshStats();
  }

  function addFiles(fileList) {
    const existing = new Set(state.files.map((entry) => fileIdentity(entry.file)));
    let added = false;

    for (const file of fileList) {
      const key = fileIdentity(file);

      if (existing.has(key)) continue;

      existing.add(key);
      state.files.push({ id: state.nextId++, file });
      added = true;
    }

    if (added) {
      state.compressedBlob = null;
      state.compressedFileName = 'archive.zip';
      showProgressState('idle');
      setStatusBadge('Ready', 'idle');
    }

    renderFileTable();
  }

  function clearQueue() {
    if (state.isCompressing) return;

    state.files = [];
    state.compressedBlob = null;
    state.compressedFileName = 'archive.zip';
    showProgressState('idle');
    setStatusBadge('Idle', 'idle');
    renderFileTable();
  }

  function showProgressState(which) {
    el.idleState.classList.toggle('hidden', which !== 'idle');
    el.activeState.classList.toggle('hidden', which !== 'active');
    el.doneState.classList.toggle('hidden', which !== 'done');
  }

  function setPreset(mode, options = {}) {
    const { syncAlgorithm = true } = options;

    state.mode = mode;

    el.presetBtns.forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === mode);
    });

    if (syncAlgorithm) {
      if (mode === 'fastest') {
        state.algorithm = 'store';
        el.algorithmSelect.value = 'store';
      } else if (state.algorithm === 'store') {
        state.algorithm = 'deflate';
        el.algorithmSelect.value = 'deflate';
      }
    }

    refreshStats();
  }

  async function compressAll() {
    if (state.files.length === 0 || state.isCompressing) return;

    state.isCompressing = true;
    state.compressedBlob = null;
    refreshStats();
    showProgressState('active');
    setStatusBadge('Archiving', 'active');

    el.progFill.style.width = '0%';
    el.progPct.textContent = '0%';
    el.progStatus.textContent = 'Archiving...';
    el.progFile.textContent = 'Preparing queue';

    const entries = [];
    const total = state.files.length;
    const useDeflate = state.algorithm === 'deflate' && state.mode !== 'fastest' && HAS_COMPRESSION_STREAM;

    try {
      for (let i = 0; i < total; i++) {
        const file = state.files[i].file;
        const relativeName = getRelativeName(file);
        const baseProgress = (i / total) * 100;
        const sliceWeight = 100 / total;

        el.progFile.textContent = relativeName + ' (' + (i + 1) + '/' + total + ')';
        el.progStatus.textContent = 'Reading ' + file.name + '...';

        const raw = new Uint8Array(await file.arrayBuffer());
        let compData;
        let method;

        if (useDeflate) {
          if (state.mode === 'maximum') {
            el.progStatus.textContent = 'Analyzing ' + file.name + '...';
            await sleep(120);
          }

          el.progStatus.textContent = 'Compressing ' + file.name + '...';

          const deflated = await deflateRaw(raw, (percent) => {
            const overall = baseProgress + (percent / 100) * sliceWeight * 0.9;
            const rounded = Math.round(overall);
            el.progFill.style.width = rounded + '%';
            el.progPct.textContent = rounded + '%';
          });

          if (deflated && deflated.length < raw.length) {
            compData = deflated;
            method = 8;
          } else {
            compData = raw;
            method = 0;
          }
        } else {
          compData = raw;
          method = 0;
        }

        entries.push({
          name: relativeName,
          rawData: raw,
          compData,
          method,
        });

        const overallDone = Math.round(((i + 1) / total) * 100);
        el.progFill.style.width = overallDone + '%';
        el.progPct.textContent = overallDone + '%';
      }

      el.progStatus.textContent = 'Packaging ZIP...';
      el.progFile.textContent = 'Finalizing archive';
      await sleep(100);

      const blob = buildMultiZip(entries);
      const rawTotal = totalRawSize();
      const saved = rawTotal - blob.size;
      const savedPct = rawTotal > 0 ? ((saved / rawTotal) * 100).toFixed(1) : '0.0';
      const primaryName = state.files.length === 1
        ? state.files[0].file.name.replace(/\.[^/.]+$/, '')
        : 'archive';

      state.compressedBlob = blob;
      state.compressedFileName = primaryName + '.zip';

      showProgressState('done');
      setStatusBadge('Complete', 'done');
      el.doneOriginal.textContent = formatSize(rawTotal);
      el.doneCompressed.textContent = formatSize(blob.size);
      el.doneSaved.textContent = saved > 0
        ? 'Saved ' + formatSize(saved) + ' (' + savedPct + '%)'
        : 'Input files were already close to optimal';
    } catch (error) {
      console.error('Compression failed:', error);
      showProgressState('idle');
      setStatusBadge(state.files.length ? 'Ready' : 'Idle', 'idle');
    } finally {
      state.isCompressing = false;
      refreshStats();
    }
  }

  function downloadZip() {
    if (!state.compressedBlob) return;

    const url = URL.createObjectURL(state.compressedBlob);
    const link = document.createElement('a');

    link.href = url;
    link.download = state.compressedFileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function bindEvents() {
    el.browseBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      el.fileInput.click();
    });

    el.browseFolderBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      el.folderInput.click();
    });

    el.clearBtn.addEventListener('click', clearQueue);
    el.infoBtn.addEventListener('click', openInfoModal);
    el.closeInfoBtn.addEventListener('click', closeInfoModal);
    el.infoModal.addEventListener('click', (event) => {
      if (event.target === el.infoModal) {
        closeInfoModal();
      }
    });

    el.fileInput.addEventListener('change', (event) => {
      if (event.target.files && event.target.files.length) {
        addFiles(event.target.files);
      }

      event.target.value = '';
    });

    el.folderInput.addEventListener('change', (event) => {
      if (event.target.files && event.target.files.length) {
        addFiles(event.target.files);
      }

      event.target.value = '';
    });

    el.dropZone.addEventListener('click', () => {
      el.fileInput.click();
    });

    el.dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      el.dropZone.classList.add('drag-over');
    });

    el.dropZone.addEventListener('dragleave', () => {
      el.dropZone.classList.remove('drag-over');
    });

    el.dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      el.dropZone.classList.remove('drag-over');

      if (event.dataTransfer.files && event.dataTransfer.files.length) {
        addFiles(event.dataTransfer.files);
      }
    });

    el.algorithmSelect.addEventListener('change', () => {
      state.algorithm = el.algorithmSelect.value;

      if (state.mode === 'fastest' && state.algorithm === 'deflate') {
        setPreset('balanced', { syncAlgorithm: false });
      } else {
        refreshStats();
      }
    });

    el.presetBtns.forEach((button) => {
      button.addEventListener('click', () => {
        setPreset(button.dataset.mode);
      });
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && el.infoModal.classList.contains('active')) {
        closeInfoModal();
      }
    });

    el.generateBtn.addEventListener('click', compressAll);
    el.downloadBtn.addEventListener('click', downloadZip);
  }

  function init() {
    bindEvents();
    setPreset('balanced');
    showProgressState('idle');
    setStatusBadge('Idle', 'idle');
    renderFileTable();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
