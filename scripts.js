(function () {
  'use strict';

  const ALGO = {
    store: { ext: '.zip', zipMethod: 0, zipVersion: 20 },
    deflate: { ext: '.zip', zipMethod: 8, zipVersion: 20 },
    zstd: { ext: '.zip', zipMethod: 93, zipVersion: 63 },
    lzma: { ext: '.zip', zipMethod: 14, zipVersion: 63 },
  };
  const MODE_ALGO_MAP = {
    fastest: 'store',
    balanced: 'deflate',
    maximum: 'zstd',
  };

  const state = {
    files: [],
    nextId: 1,
    mode: 'balanced',
    algorithm: 'deflate',
    compressedBlob: null,
    compressedFileName: 'archive.zip',
    isCompressing: false,
    zstdReady: null,
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

  const HAS_CS = typeof CompressionStream !== 'undefined';
  const EXT_COMPRESSED = new Set(['zip', 'rar', '7z', 'gz', 'bz2', 'xz', 'zst', 'lz', 'lzma', 'br', 'lz4', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'mp3', 'aac', 'ogg', 'opus', 'flac', 'm4a', 'mp4', 'mkv', 'avi', 'webm', 'mov', 'wmv', 'flv', 'woff', 'woff2', 'jar', 'apk', 'dmg', 'iso']);
  const EXT_TEXT = new Set(['txt', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'xml', 'svg', 'csv', 'tsv', 'md', 'yml', 'yaml', 'toml', 'ini', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'go', 'rs', 'swift', 'kt', 'kts', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'psm1', 'sql', 'graphql', 'proto', 'log', 'cfg', 'conf', 'env']);
  const EXT_SEMI = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'epub']);
  const EXT_RAW_IMG = new Set(['bmp', 'tiff', 'tif', 'ppm', 'pgm', 'raw', 'dng']);
  const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tiff', 'tif']);
  const CODE_EXT = new Set(['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'rb', 'php', 'go', 'rs', 'swift', 'kt', 'html', 'htm', 'css', 'json', 'xml', 'yml', 'yaml', 'sh', 'sql']);
  const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'txt', 'md', 'csv']);
  const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'gz', 'bz2', 'xz', 'tar', 'iso', 'zst', 'lz4', 'lzma']);
  const MEDIA_EXT = new Set(['mp3', 'mp4', 'wav', 'ogg', 'flac', 'aac', 'mkv', 'avi', 'webm', 'mov']);
  const CRC32 = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let crc = i;
      for (let j = 0; j < 8; j++) crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
      table[i] = crc;
    }
    return table;
  })();

  function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 2) + ' ' + units[index];
  }

  function escapeHTML(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getRelativeName(file) {
    return (file.__relativePath || file.webkitRelativePath || file.name).replace(/\\/g, '/');
  }

  function fileIdentity(file) {
    return [getRelativeName(file), file.size, file.lastModified].join('|');
  }

  function totalRawSize() {
    return state.files.reduce((sum, entry) => sum + entry.file.size, 0);
  }

  function setStatusBadge(label, view) {
    el.statusBadge.textContent = label;
    el.statusBadge.dataset.state = view;
  }

  function setProgress(percent, status, file) {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    el.progFill.style.width = value + '%';
    el.progPct.textContent = value + '%';
    if (typeof status === 'string') el.progStatus.textContent = status;
    if (typeof file === 'string') el.progFile.textContent = file;
  }

  function openInfoModal() {
    el.infoModal.classList.add('active');
    el.infoModal.setAttribute('aria-hidden', 'false');
  }

  function closeInfoModal() {
    el.infoModal.classList.remove('active');
    el.infoModal.setAttribute('aria-hidden', 'true');
  }

  function crc32(buffer) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buffer.length; i++) crc = CRC32[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function toDOSTime(date) {
    return (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  }

  function toDOSDate(date) {
    return ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  }

  async function streamCompress(format, data, onProgress) {
    if (!HAS_CS) throw new Error(format + ' compression is not supported in this browser.');
    const stream = new CompressionStream(format);
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const chunks = [];
    const drain = (async () => {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(part.value);
      }
    })();
    const chunkSize = 65536;
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, data.length);
      await writer.write(data.subarray(offset, end));
      if (onProgress) onProgress((end / data.length) * 100);
    }
    await writer.close();
    await drain;
    return concatChunks(chunks);
  }

  function concatChunks(chunks) {
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function normalizeBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (Array.isArray(value)) return Uint8Array.from(value, (v) => ((v % 256) + 256) % 256);
    if (value && value.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength || value.length || 0);
    throw new Error('Unsupported binary payload returned by compressor.');
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

  function tarWriteText(buffer, offset, length, text) {
    const bytes = new TextEncoder().encode(text);
    buffer.set(bytes.subarray(0, Math.min(length, bytes.length)), offset);
  }

  function tarWriteOctal(buffer, offset, length, value) {
    tarWriteText(buffer, offset, length, Math.max(0, value).toString(8).padStart(length - 2, '0') + '\0 ');
  }

  function splitTarPath(path) {
    const clean = path.replace(/^\/+/, '');
    if (clean.length <= 100) return { name: clean, prefix: '' };
    for (let split = clean.lastIndexOf('/'); split > 0; split = clean.lastIndexOf('/', split - 1)) {
      const prefix = clean.slice(0, split);
      const name = clean.slice(split + 1);
      if (prefix.length <= 155 && name.length <= 100) return { name, prefix };
    }
    return { name: clean.slice(-100), prefix: clean.slice(0, 155) };
  }

  function tarChecksum(header) {
    let sum = 0;
    for (let i = 0; i < header.length; i++) sum += header[i];
    return sum;
  }

  function buildTar(entries) {
    const blocks = [];
    const mtime = Math.floor(Date.now() / 1000);
    for (const entry of entries) {
      const header = new Uint8Array(512);
      const parts = splitTarPath(entry.name);
      tarWriteText(header, 0, 100, parts.name);
      tarWriteOctal(header, 100, 8, 420);
      tarWriteOctal(header, 108, 8, 0);
      tarWriteOctal(header, 116, 8, 0);
      tarWriteOctal(header, 124, 12, entry.rawData.length);
      tarWriteOctal(header, 136, 12, mtime);
      for (let i = 148; i < 156; i++) header[i] = 32;
      header[156] = 48;
      tarWriteText(header, 257, 6, 'ustar');
      header[263] = 48;
      header[264] = 48;
      tarWriteText(header, 265, 32, 'FilePress');
      tarWriteText(header, 297, 32, 'FilePress');
      tarWriteText(header, 345, 155, parts.prefix);
      tarWriteOctal(header, 148, 8, tarChecksum(header));
      blocks.push(header, entry.rawData);
      const padding = entry.rawData.length % 512;
      if (padding) blocks.push(new Uint8Array(512 - padding));
    }
    blocks.push(new Uint8Array(1024));
    return concatChunks(blocks);
  }

  function buildZip(entries) {
    const encoder = new TextEncoder();
    const now = new Date();
    const time = toDOSTime(now);
    const date = toDOSDate(now);
    let localSize = 0;
    let dirSize = 0;
    const prepared = entries.map((entry) => {
      const nameBytes = encoder.encode(entry.name);
      localSize += 30 + nameBytes.length + entry.compData.length;
      dirSize += 46 + nameBytes.length;
      return { ...entry, nameBytes, crc: crc32(entry.rawData), versionNeeded: entry.versionNeeded || 20 };
    });
    const buffer = new Uint8Array(localSize + dirSize + 22);
    const offsets = [];
    let offset = 0;
    for (const entry of prepared) {
      offsets.push(offset);
      writeU32(0x04034B50, buffer, offset); offset += 4;
      writeU16(entry.versionNeeded, buffer, offset); offset += 2;
      writeU16(0, buffer, offset); offset += 2;
      writeU16(entry.method, buffer, offset); offset += 2;
      writeU16(time, buffer, offset); offset += 2;
      writeU16(date, buffer, offset); offset += 2;
      writeU32(entry.crc, buffer, offset); offset += 4;
      writeU32(entry.compData.length, buffer, offset); offset += 4;
      writeU32(entry.rawData.length, buffer, offset); offset += 4;
      writeU16(entry.nameBytes.length, buffer, offset); offset += 2;
      writeU16(0, buffer, offset); offset += 2;
      buffer.set(entry.nameBytes, offset); offset += entry.nameBytes.length;
      buffer.set(entry.compData, offset); offset += entry.compData.length;
    }
    const dirOffset = offset;
    for (let i = 0; i < prepared.length; i++) {
      const entry = prepared[i];
      writeU32(0x02014B50, buffer, offset); offset += 4;
      writeU16(entry.versionNeeded, buffer, offset); offset += 2;
      writeU16(entry.versionNeeded, buffer, offset); offset += 2;
      writeU16(0, buffer, offset); offset += 2;
      writeU16(entry.method, buffer, offset); offset += 2;
      writeU16(time, buffer, offset); offset += 2;
      writeU16(date, buffer, offset); offset += 2;
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
    const dirLength = offset - dirOffset;
    writeU32(0x06054B50, buffer, offset); offset += 4;
    writeU16(0, buffer, offset); offset += 2;
    writeU16(0, buffer, offset); offset += 2;
    writeU16(prepared.length, buffer, offset); offset += 2;
    writeU16(prepared.length, buffer, offset); offset += 2;
    writeU32(dirLength, buffer, offset); offset += 4;
    writeU32(dirOffset, buffer, offset); offset += 4;
    writeU16(0, buffer, offset);
    return new Blob([buffer], { type: 'application/zip' });
  }

  function lzwCompress(data) {
    if (!data.length) return new Uint8Array(0);
    const dict = new Map();
    for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
    let nextCode = 256;
    let phrase = String.fromCharCode(data[0]);
    const codes = [];
    for (let i = 1; i < data.length; i++) {
      const current = String.fromCharCode(data[i]);
      const combo = phrase + current;
      if (dict.has(combo)) {
        phrase = combo;
      } else {
        codes.push(dict.get(phrase));
        if (nextCode < 65535) dict.set(combo, nextCode++);
        phrase = current;
      }
    }
    codes.push(dict.get(phrase));
    const out = new Uint8Array(codes.length * 2);
    for (let i = 0; i < codes.length; i++) {
      out[i * 2] = codes[i] & 0xFF;
      out[i * 2 + 1] = codes[i] >> 8;
    }
    return out;
  }

  function modeText() {
    if (state.mode === 'fastest') return 0.95;
    if (state.mode === 'maximum') return 0.9;
    return 1;
  }

  function estimateOneFile(file) {
    if (state.algorithm === 'store') return file.size;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let ratio = 0.58;
    if (EXT_COMPRESSED.has(ext)) ratio = 0.98;
    else if (EXT_TEXT.has(ext)) ratio = 0.32;
    else if (EXT_RAW_IMG.has(ext)) ratio = 0.19;
    else if (ext === 'wav') ratio = 0.59;
    else if (EXT_SEMI.has(ext)) ratio = 0.92;
    if (state.algorithm === 'lzma') ratio *= state.mode === 'maximum' ? 0.7 : state.mode === 'fastest' ? 0.9 : 0.8;
    else if (state.algorithm === 'zstd') ratio *= state.mode === 'maximum' ? 0.78 : state.mode === 'fastest' ? 0.95 : 0.86;
    else ratio *= modeText();
    return Math.max(Math.round(file.size * Math.min(ratio, 0.995)), 1);
  }

  function estimateTotal() {
    return state.files.reduce((sum, entry) => sum + estimateOneFile(entry.file), 0);
  }

  function modeForAlgorithm(algorithm) {
    if (algorithm === 'store') return 'fastest';
    if (algorithm === 'deflate') return 'balanced';
    return 'maximum';
  }

  function syncPresetButtons() {
    el.presetBtns.forEach((button) => button.classList.toggle('active', button.dataset.mode === state.mode));
  }

  function setAlgorithm(algorithm) {
    const nextAlgorithm = ALGO[algorithm] ? algorithm : 'deflate';
    const nextMode = modeForAlgorithm(nextAlgorithm);
    const changed = state.algorithm !== nextAlgorithm || state.mode !== nextMode;
    state.algorithm = nextAlgorithm;
    state.mode = nextMode;
    el.algorithmSelect.value = state.algorithm;
    syncPresetButtons();
    if (changed) invalidateArchiveResult();
    refreshStats();
  }

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

  function getOutputName() {
    const base = state.files.length === 1 ? state.files[0].file.name.replace(/\.[^/.]+$/, '') : 'archive';
    return base + ALGO[state.algorithm].ext;
  }

  function refreshStats() {
    const count = state.files.length + ' item' + (state.files.length === 1 ? '' : 's');
    el.totalSize.textContent = formatSize(totalRawSize());
    el.fileCount.textContent = count;
    el.estOutput.textContent = state.files.length ? '~' + formatSize(estimateTotal()) : '~0 B';
    el.fileCounter.textContent = count + ' listed';
    el.generateBtn.disabled = state.isCompressing || state.files.length === 0;
    el.clearBtn.disabled = state.isCompressing || state.files.length === 0;
  }

  function showProgressState(which) {
    el.idleState.classList.toggle('hidden', which !== 'idle');
    el.activeState.classList.toggle('hidden', which !== 'active');
    el.doneState.classList.toggle('hidden', which !== 'done');
  }

  function invalidateArchiveResult() {
    state.compressedBlob = null;
    state.compressedFileName = getOutputName();
    if (!state.isCompressing) {
      showProgressState('idle');
      setStatusBadge(state.files.length ? 'Ready' : 'Idle', 'idle');
    }
  }

  function renderFileTable() {
    if (state.files.length === 0) {
      if (!state.isCompressing) setStatusBadge('Idle', 'idle');
      el.fileTableBody.innerHTML = '<tr class="empty-row"><td colspan="3" class="empty-cell">No files selected. Use browse, folder import, or drag and drop.</td></tr>';
      refreshStats();
      return;
    }
    el.fileTableBody.innerHTML = '';
    for (const entry of state.files) {
      const row = document.createElement('tr');
      const name = getRelativeName(entry.file);
      row.innerHTML = `
        <td><div class="file-path-cell"><div class="file-ext-icon ${extClass(entry.file.name)}">${escapeHTML(extLabel(entry.file.name))}</div><span class="file-name-text" title="${escapeHTML(name)}">${escapeHTML(name)}</span></div></td>
        <td class="file-size-cell">${formatSize(entry.file.size)}</td>
        <td><button class="remove-btn" data-id="${entry.id}" type="button" aria-label="Remove file" title="Remove file"><svg class="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16"></path><path d="M10 11v5"></path><path d="M14 11v5"></path><path d="M6 7l1 11a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-11"></path><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"></path></svg><span class="sr-only">Remove</span></button></td>
      `;
      el.fileTableBody.appendChild(row);
    }
    el.fileTableBody.querySelectorAll('.remove-btn').forEach((button) => {
      button.addEventListener('click', () => {
        const id = Number(button.dataset.id);
        state.files = state.files.filter((entry) => entry.id !== id);
        invalidateArchiveResult();
        renderFileTable();
      });
    });
    refreshStats();
  }

  function addFiles(list) {
    const seen = new Set(state.files.map((entry) => fileIdentity(entry.file)));
    let added = false;
    for (const file of list) {
      const key = fileIdentity(file);
      if (seen.has(key)) continue;
      seen.add(key);
      state.files.push({ id: state.nextId++, file });
      added = true;
    }
    if (added) {
      invalidateArchiveResult();
    }
    renderFileTable();
  }

  async function collectDirectoryFiles(directoryHandle, prefix) {
    const files = [];
    for await (const entry of directoryHandle.values()) {
      const relativePath = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.kind === 'file') {
        const file = await entry.getFile();
        file.__relativePath = relativePath;
        files.push(file);
      } else if (entry.kind === 'directory') {
        files.push(...await collectDirectoryFiles(entry, relativePath));
      }
    }
    return files;
  }

  function configureFolderInput() {
    if (!el.folderInput) return;
    el.folderInput.setAttribute('webkitdirectory', '');
    el.folderInput.setAttribute('directory', '');
    el.folderInput.setAttribute('mozdirectory', '');
    el.folderInput.multiple = true;
    try {
      el.folderInput.webkitdirectory = true;
    } catch (error) {
      // Ignore non-standard property assignment failures.
    }
  }

  function clearQueue() {
    if (state.isCompressing) return;
    state.files = [];
    invalidateArchiveResult();
    renderFileTable();
  }

  function setPreset(mode) {
    const nextMode = MODE_ALGO_MAP[mode] ? mode : 'balanced';
    const nextAlgorithm = MODE_ALGO_MAP[nextMode];
    const changed = state.mode !== nextMode || state.algorithm !== nextAlgorithm;
    state.mode = nextMode;
    state.algorithm = nextAlgorithm;
    el.algorithmSelect.value = state.algorithm;
    syncPresetButtons();
    if (changed) invalidateArchiveResult();
    refreshStats();
  }

  async function readEntries() {
    const items = [];
    const total = state.files.length;
    for (let i = 0; i < total; i++) {
      const file = state.files[i].file;
      const name = getRelativeName(file);
      setProgress((i / total) * 42, 'Reading ' + file.name + '...', name + ' (' + (i + 1) + '/' + total + ')');
      const rawData = new Uint8Array(await file.arrayBuffer());
      items.push({ file, name, rawData });
      setProgress(((i + 1) / total) * 42, 'Reading ' + file.name + '...', name + ' (' + (i + 1) + '/' + total + ')');
    }
    return items;
  }

  async function buildZipBlob(entries) {
    const zipEntries = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const base = 42 + (i / entries.length) * 45;
      let compData = entry.rawData;
      let method = 0;
      let versionNeeded = ALGO.store.zipVersion;
      if (state.algorithm === 'deflate') {
        if (state.mode === 'maximum') {
          setProgress(base, 'Analyzing ' + entry.file.name + '...', entry.name);
          await sleep(80);
        }
        const deflated = await streamCompress('deflate-raw', entry.rawData, (percent) => {
          setProgress(base + (percent / 100) * (45 / entries.length), 'Compressing ' + entry.file.name + '...', entry.name);
        }).catch(() => null);
        if (deflated && deflated.length < entry.rawData.length) {
          compData = deflated;
          method = ALGO.deflate.zipMethod;
          versionNeeded = ALGO.deflate.zipVersion;
        }
      } else if (state.algorithm === 'zstd') {
        setProgress(base, 'Compressing ' + entry.file.name + '...', entry.name);
        const zstd = await zstdModule();
        const zstdData = normalizeBytes(new zstd.Streaming().compress(entry.rawData, zstdLevel()));
        if (zstdData && zstdData.length < entry.rawData.length) {
          compData = zstdData;
          method = ALGO.zstd.zipMethod;
          versionNeeded = ALGO.zstd.zipVersion;
        }
      } else if (state.algorithm === 'lzma') {
        setProgress(base, 'Compressing ' + entry.file.name + '...', entry.name);
        const lzmaData = await new Promise((resolve, reject) => {
          if (!globalThis.LZMA || !globalThis.LZMA.compress) {
            reject(new Error('The LZMA runtime did not load.'));
            return;
          }
          globalThis.LZMA.compress(entry.rawData, lzmaPreset(), (result, error) => {
            if (error) {
              reject(error);
            } else {
              resolve(normalizeBytes(result));
            }
          }, (progress) => {
            const value = progress > 1 ? progress : progress * 100;
            setProgress(base + (value / 100) * (45 / entries.length), 'Compressing ' + entry.file.name + '...', entry.name);
          });
        });
        if (lzmaData && lzmaData.length < entry.rawData.length) {
          compData = lzmaData;
          method = ALGO.lzma.zipMethod;
          versionNeeded = ALGO.lzma.zipVersion;
        }
      }
      zipEntries.push({ name: entry.name, rawData: entry.rawData, compData, method, versionNeeded });
      setProgress(42 + ((i + 1) / entries.length) * 45, method ? 'Compressing ZIP entries...' : 'Packing ZIP entries...', entry.name);
    }
    setProgress(92, 'Packaging ZIP...', 'Finalizing archive');
    await sleep(40);
    return buildZip(zipEntries);
  }

  async function zstdModule() {
    if (!state.zstdReady) {
      state.zstdReady = new Promise((resolve, reject) => {
        try {
          if (!globalThis.ZstdCodecBundle || !globalThis.ZstdCodecBundle.ZstdCodec) throw new Error('The Zstandard bundle did not load.');
          globalThis.ZstdCodecBundle.ZstdCodec.run((zstd) => resolve(zstd));
        } catch (error) {
          reject(error);
        }
      });
    }
    return state.zstdReady;
  }

  function lzmaPreset() {
    return state.mode === 'fastest' ? 1 : state.mode === 'maximum' ? 9 : 6;
  }

  function zstdLevel() {
    return state.mode === 'fastest' ? 1 : state.mode === 'maximum' ? 10 : 3;
  }

  async function compressTar(tarBytes) {
    if (state.algorithm === 'gzip') {
      setProgress(58, 'Compressing with Gzip...', 'Streaming TAR payload');
      return streamCompress('gzip', tarBytes, (percent) => setProgress(58 + (percent * 0.37), 'Compressing with Gzip...', 'Streaming TAR payload'));
    }
    if (state.algorithm === 'lz4') {
      setProgress(60, 'Compressing with LZ4...', 'Encoding TAR payload');
      if (!globalThis.LZ4Bundle || !globalThis.LZ4Bundle.compress) throw new Error('The LZ4 bundle did not load.');
      return normalizeBytes(globalThis.LZ4Bundle.compress(tarBytes));
    }
    if (state.algorithm === 'lzw') {
      setProgress(60, 'Compressing with LZW...', 'Encoding TAR payload');
      return lzwCompress(tarBytes);
    }
    if (state.algorithm === 'lzma') {
      setProgress(58, 'Compressing with LZMA...', 'Encoding TAR payload');
      if (!globalThis.LZMA || !globalThis.LZMA.compress) throw new Error('The LZMA runtime did not load.');
      return new Promise((resolve, reject) => {
        globalThis.LZMA.compress(tarBytes, lzmaPreset(), (result, error) => {
          if (error) {
            reject(error);
          } else {
            resolve(normalizeBytes(result));
          }
        }, (progress) => {
          const value = progress > 1 ? progress : progress * 100;
          setProgress(58 + (value * 0.37), 'Compressing with LZMA...', 'Encoding TAR payload');
        });
      });
    }
    if (state.algorithm === 'zstd') {
      setProgress(58, 'Compressing with Zstd...', 'Encoding TAR payload');
      const zstd = await zstdModule();
      return normalizeBytes(new zstd.Streaming().compress(tarBytes, zstdLevel()));
    }
    throw new Error('Unsupported TAR algorithm.');
  }

  async function buildTarBlob(entries) {
    setProgress(48, 'Building TAR payload...', 'Packing file structure');
    const tarBytes = buildTar(entries);
    setProgress(56, 'TAR payload ready', 'Applying selected algorithm');
    return new Blob([await compressTar(tarBytes)], { type: 'application/octet-stream' });
  }

  async function compressAll() {
    if (state.files.length === 0 || state.isCompressing) return;
    state.isCompressing = true;
    state.compressedBlob = null;
    refreshStats();
    showProgressState('active');
    setStatusBadge('Archiving', 'active');
    setProgress(0, 'Preparing archive...', 'Reading queue');
    try {
      const entries = await readEntries();
      const blob = await buildZipBlob(entries);
      const rawTotal = totalRawSize();
      const saved = rawTotal - blob.size;
      const savedPct = rawTotal > 0 ? ((saved / rawTotal) * 100).toFixed(1) : '0.0';
      setProgress(100, 'Archive ready', 'Finished');
      state.compressedBlob = blob;
      state.compressedFileName = getOutputName();
      showProgressState('done');
      setStatusBadge('Complete', 'done');
      el.doneOriginal.textContent = formatSize(rawTotal);
      el.doneCompressed.textContent = formatSize(blob.size);
      el.doneSaved.textContent = saved > 0 ? 'Saved ' + formatSize(saved) + ' (' + savedPct + '%)' : 'This algorithm produced little or no size reduction';
    } catch (error) {
      console.error('Compression failed:', error);
      showProgressState('idle');
      setStatusBadge(state.files.length ? 'Ready' : 'Idle', 'idle');
      setProgress(0, 'Compression failed', error.message || 'Unable to build archive');
    } finally {
      state.isCompressing = false;
      refreshStats();
    }
  }

  function downloadArchive() {
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
    el.browseFolderBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (typeof window.showDirectoryPicker === 'function') {
        try {
          const directoryHandle = await window.showDirectoryPicker({ mode: 'read' });
          const files = await collectDirectoryFiles(directoryHandle, '');
          if (files.length) addFiles(files);
          return;
        } catch (error) {
          if (error && error.name === 'AbortError') return;
          console.warn('Directory picker failed, falling back to file input.', error);
        }
      }
      configureFolderInput();
      el.folderInput.click();
    });
    el.clearBtn.addEventListener('click', clearQueue);
    el.infoBtn.addEventListener('click', openInfoModal);
    el.closeInfoBtn.addEventListener('click', closeInfoModal);
    el.infoModal.addEventListener('click', (event) => {
      if (event.target === el.infoModal) closeInfoModal();
    });
    el.fileInput.addEventListener('change', (event) => {
      if (event.target.files && event.target.files.length) addFiles(event.target.files);
      event.target.value = '';
    });
    el.folderInput.addEventListener('change', (event) => {
      if (event.target.files && event.target.files.length) addFiles(event.target.files);
      event.target.value = '';
    });
    el.dropZone.addEventListener('click', () => el.fileInput.click());
    el.dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      el.dropZone.classList.add('drag-over');
    });
    el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('drag-over'));
    el.dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      el.dropZone.classList.remove('drag-over');
      if (event.dataTransfer.files && event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
    });
    el.algorithmSelect.addEventListener('change', () => {
      setAlgorithm(el.algorithmSelect.value);
    });
    el.presetBtns.forEach((button) => button.addEventListener('click', () => setPreset(button.dataset.mode)));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && el.infoModal.classList.contains('active')) closeInfoModal();
    });
    el.generateBtn.addEventListener('click', compressAll);
    el.downloadBtn.addEventListener('click', downloadArchive);
  }

  function init() {
    configureFolderInput();
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
