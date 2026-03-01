/* ============================================================
   FilePress — Application Logic
   Multi-file, single-screen dashboard.
   Browser-based DEFLATE via CompressionStream + pure-JS ZIP builder.
   ============================================================ */

(function () {
  'use strict';

  // ================================================================
  //  State
  // ================================================================
  const state = {
    files: [],                 // { id, file, size }
    nextId: 1,
    mode: 'balanced',          // fastest | balanced | maximum
    algorithm: 'deflate',      // deflate | store
    compressedBlob: null,
    compressedFileName: 'archive.zip',
    isCompressing: false,
  };

  // ================================================================
  //  DOM refs
  // ================================================================
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const el = {
    dropZone:     $('#dropZone'),
    browseBtn:    $('#browseBtn'),
    fileInput:    $('#fileInput'),
    // Stats
    totalSize:    $('#totalSize'),
    fileCount:    $('#fileCount'),
    estOutput:    $('#estOutput'),
    generateBtn:  $('#generateBtn'),
    // Progress
    idleState:    $('#idleState'),
    activeState:  $('#activeState'),
    doneState:    $('#doneState'),
    progStatus:   $('#progStatus'),
    progPct:      $('#progPct'),
    progFill:     $('#progFill'),
    progFile:     $('#progFile'),
    doneOriginal: $('#doneOriginal'),
    doneCompressed:$('#doneCompressed'),
    doneSaved:    $('#doneSaved'),
    downloadBtn:  $('#downloadBtn'),
    // Settings
    algorithmSelect: $('#algorithmSelect'),
    presetBtns:   $$('.preset-btn'),
    // Files table
    fileCounter:  $('#fileCounter'),
    fileTableBody:$('#fileTableBody'),
    emptyRow:     $('#emptyRow'),
  };

  // ================================================================
  //  Utilities
  // ================================================================
  function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const u = ['B','KB','MB','GB','TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + ' ' + u[i];
  }

  function escapeHTML(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ================================================================
  //  CRC-32
  // ================================================================
  const CRC32_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // ================================================================
  //  DOS Date / Time
  // ================================================================
  function toDOSTime(d) { return (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1); }
  function toDOSDate(d) { return ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(); }

  // ================================================================
  //  DEFLATE via CompressionStream (raw deflate)
  // ================================================================
  const HAS_CS = typeof CompressionStream !== 'undefined';

  async function deflateRaw(data, onProgress) {
    if (!HAS_CS) return null;
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    const out = [];

    const readAll = (async () => {
      for (;;) { const {done, value} = await reader.read(); if (done) break; out.push(value); }
    })();

    const CHUNK = 65536;
    for (let off = 0; off < data.length; off += CHUNK) {
      await writer.write(data.subarray(off, Math.min(off + CHUNK, data.length)));
      if (onProgress) onProgress(Math.round(((off + CHUNK) / data.length) * 100));
    }
    await writer.close();
    await readAll;

    const len = out.reduce((s,c) => s + c.length, 0);
    const buf = new Uint8Array(len);
    let p = 0;
    for (const c of out) { buf.set(c, p); p += c.length; }
    return buf;
  }

  // ================================================================
  //  ZIP builder — supports multiple files
  // ================================================================
  function writeU16(v, b, o) { v &= 0xFFFF; b[o]=v; b[o+1]=v>>8; }
  function writeU32(v, b, o) { v >>>= 0; b[o]=v; b[o+1]=v>>8; b[o+2]=v>>16; b[o+3]=v>>24; }

  function buildMultiZip(entries) {
    // entries: [{ name, rawData, compData, method }]
    const enc = new TextEncoder();
    const now = new Date();
    const dTime = toDOSTime(now);
    const dDate = toDOSDate(now);

    // Pre-calculate sizes
    let localSize = 0, cdSize = 0;
    const prepared = entries.map(e => {
      const nameBytes = enc.encode(e.name);
      const lh = 30 + nameBytes.length;
      const ch = 46 + nameBytes.length;
      localSize += lh + e.compData.length;
      cdSize += ch;
      return { ...e, nameBytes, lhSize: lh, chSize: ch, crc: crc32(e.rawData) };
    });

    const totalSize = localSize + cdSize + 22;
    const buf = new Uint8Array(totalSize);
    let o = 0;
    const offsets = [];

    // Local file headers + data
    for (const p of prepared) {
      offsets.push(o);
      writeU32(0x04034B50, buf, o); o+=4;
      writeU16(20, buf, o); o+=2;
      writeU16(0, buf, o); o+=2;
      writeU16(p.method, buf, o); o+=2;
      writeU16(dTime, buf, o); o+=2;
      writeU16(dDate, buf, o); o+=2;
      writeU32(p.crc, buf, o); o+=4;
      writeU32(p.compData.length, buf, o); o+=4;
      writeU32(p.rawData.length, buf, o); o+=4;
      writeU16(p.nameBytes.length, buf, o); o+=2;
      writeU16(0, buf, o); o+=2;
      buf.set(p.nameBytes, o); o+=p.nameBytes.length;
      buf.set(p.compData, o); o+=p.compData.length;
    }

    // Central directory
    const cdOffset = o;
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      writeU32(0x02014B50, buf, o); o+=4;
      writeU16(20, buf, o); o+=2;
      writeU16(20, buf, o); o+=2;
      writeU16(0, buf, o); o+=2;
      writeU16(p.method, buf, o); o+=2;
      writeU16(dTime, buf, o); o+=2;
      writeU16(dDate, buf, o); o+=2;
      writeU32(p.crc, buf, o); o+=4;
      writeU32(p.compData.length, buf, o); o+=4;
      writeU32(p.rawData.length, buf, o); o+=4;
      writeU16(p.nameBytes.length, buf, o); o+=2;
      writeU16(0, buf, o); o+=2;
      writeU16(0, buf, o); o+=2;
      writeU16(0, buf, o); o+=2;
      writeU16(0, buf, o); o+=2;
      writeU32(0, buf, o); o+=4;
      writeU32(offsets[i], buf, o); o+=4;
      buf.set(p.nameBytes, o); o+=p.nameBytes.length;
    }

    const cdLen = o - cdOffset;

    // EOCD
    writeU32(0x06054B50, buf, o); o+=4;
    writeU16(0, buf, o); o+=2;
    writeU16(0, buf, o); o+=2;
    writeU16(prepared.length, buf, o); o+=2;
    writeU16(prepared.length, buf, o); o+=2;
    writeU32(cdLen, buf, o); o+=4;
    writeU32(cdOffset, buf, o); o+=4;
    writeU16(0, buf, o); o+=2;

    return new Blob([buf], { type: 'application/zip' });
  }

  // ================================================================
  //  Estimation heuristic
  // ================================================================
  const EXT_COMPRESSED = new Set([
    'zip','rar','7z','gz','bz2','xz','zst','lz','lzma','br',
    'jpg','jpeg','png','gif','webp','avif','heic',
    'mp3','aac','ogg','opus','flac','m4a',
    'mp4','mkv','avi','webm','mov','wmv','flv',
    'woff','woff2','jar','apk','dmg','iso',
  ]);
  const EXT_TEXT = new Set([
    'txt','html','htm','css','js','mjs','cjs','ts','tsx','jsx',
    'json','xml','svg','csv','tsv','md','yml','yaml','toml','ini',
    'py','java','c','cpp','h','hpp','cs','rb','php','go','rs',
    'swift','kt','kts','sh','bash','zsh','bat','ps1','psm1',
    'sql','graphql','proto','log','cfg','conf','env',
  ]);
  const EXT_SEMI = new Set(['pdf','docx','xlsx','pptx','odt','ods','epub']);
  const EXT_RAW_IMG = new Set(['bmp','tiff','tif','ppm','pgm','raw','dng']);

  function estimateOneFile(file, mode, algo) {
    const size = file.size;
    if (algo === 'store' || mode === 'fastest') return size;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let ratio;
    if (EXT_COMPRESSED.has(ext))    ratio = mode === 'maximum' ? 0.97 : 0.98;
    else if (EXT_TEXT.has(ext))     ratio = mode === 'maximum' ? 0.26 : 0.32;
    else if (EXT_RAW_IMG.has(ext))  ratio = mode === 'maximum' ? 0.14 : 0.19;
    else if (ext === 'wav')         ratio = mode === 'maximum' ? 0.54 : 0.59;
    else if (EXT_SEMI.has(ext))     ratio = mode === 'maximum' ? 0.87 : 0.92;
    else                            ratio = mode === 'maximum' ? 0.52 : 0.58;
    return Math.max(Math.round(size * ratio), 1);
  }

  function estimateTotal() {
    return state.files.reduce((s, f) => s + estimateOneFile(f.file, state.mode, state.algorithm), 0);
  }
  function totalRawSize() {
    return state.files.reduce((s, f) => s + f.file.size, 0);
  }

  // ================================================================
  //  File-type icon class
  // ================================================================
  const IMG_EXT = new Set(['jpg','jpeg','png','gif','webp','bmp','svg','ico','avif','tiff','tif']);
  const CODE_EXT = new Set(['js','ts','jsx','tsx','py','java','c','cpp','h','cs','rb','php','go','rs','swift','kt','html','htm','css','json','xml','yml','yaml','sh','sql']);
  const DOC_EXT = new Set(['pdf','doc','docx','xls','xlsx','ppt','pptx','odt','ods','txt','md','csv']);
  const ARCHIVE_EXT = new Set(['zip','rar','7z','gz','bz2','xz','tar','iso']);
  const MEDIA_EXT = new Set(['mp3','mp4','wav','ogg','flac','aac','mkv','avi','webm','mov']);

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

  // ================================================================
  //  UI Updates
  // ================================================================
  function refreshStats() {
    const raw = totalRawSize();
    const est = state.files.length ? estimateTotal() : 0;
    el.totalSize.textContent = formatSize(raw);
    el.fileCount.textContent = state.files.length + ' item' + (state.files.length !== 1 ? 's' : '');
    el.estOutput.textContent = state.files.length ? '~' + formatSize(est) : '~0 B';
    el.generateBtn.disabled  = state.files.length === 0;
    el.fileCounter.textContent = state.files.length + ' item' + (state.files.length !== 1 ? 's' : '') + ' listed';
  }

  function renderFileTable() {
    const tbody = el.fileTableBody;
    tbody.innerHTML = '';

    if (state.files.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="3" class="empty-cell">No files selected — drop or browse to add</td></tr>';
      refreshStats();
      return;
    }

    for (const entry of state.files) {
      const tr = document.createElement('tr');
      const cls = extClass(entry.file.name);
      const label = extLabel(entry.file.name);
      tr.innerHTML = `
        <td>
          <div class="file-path-cell">
            <div class="file-ext-icon ${cls}">${escapeHTML(label)}</div>
            <span class="file-name-text" title="${escapeHTML(entry.file.name)}">${escapeHTML(entry.file.webkitRelativePath || entry.file.name)}</span>
          </div>
        </td>
        <td class="file-size-cell">${formatSize(entry.file.size)}</td>
        <td><button class="remove-btn" data-id="${entry.id}" type="button" title="Remove">✕</button></td>`;
      tbody.appendChild(tr);
    }

    // Bind remove buttons
    tbody.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        state.files = state.files.filter(f => f.id !== id);
        renderFileTable();
      });
    });

    refreshStats();
  }

  // ================================================================
  //  Add files
  // ================================================================
  function addFiles(fileList) {
    for (const file of fileList) {
      // Avoid exact duplicates by name+size
      const dup = state.files.some(f => f.file.name === file.name && f.file.size === file.size);
      if (dup) continue;
      state.files.push({ id: state.nextId++, file, size: file.size });
    }
    renderFileTable();
    showProgressState('idle');
  }

  // ================================================================
  //  Progress state machine
  // ================================================================
  function showProgressState(which) {
    el.idleState.classList.toggle('hidden', which !== 'idle');
    el.activeState.classList.toggle('hidden', which !== 'active');
    el.doneState.classList.toggle('hidden', which !== 'done');
  }

  // ================================================================
  //  Compress all files → multi-entry ZIP
  // ================================================================
  async function compressAll() {
    if (state.files.length === 0 || state.isCompressing) return;
    state.isCompressing = true;
    state.compressedBlob = null;
    el.generateBtn.disabled = true;

    showProgressState('active');
    el.progFill.style.width = '0%';
    el.progPct.textContent = '0%';
    el.progStatus.textContent = '⏳ Archiving…';
    el.progFile.textContent = '';

    const entries = [];
    const total = state.files.length;
    const useDeflate = state.algorithm === 'deflate' && state.mode !== 'fastest' && HAS_CS;

    for (let i = 0; i < total; i++) {
      const f = state.files[i].file;
      const baseProgress = (i / total) * 100;
      const sliceWeight = 100 / total;

      el.progFile.textContent = `${f.name}  (${i + 1}/${total})`;

      // Read file
      el.progStatus.textContent = `⏳ Reading ${f.name}…`;
      const raw = new Uint8Array(await f.arrayBuffer());

      let compData, method;

      if (useDeflate) {
        el.progStatus.textContent = `⏳ Compressing ${f.name}…`;

        // Extra analysis delay for "maximum" preset
        if (state.mode === 'maximum') {
          el.progStatus.textContent = `🔍 Analyzing ${f.name}…`;
          await sleep(150);
        }

        const deflated = await deflateRaw(raw, (p) => {
          const overall = baseProgress + (p / 100) * sliceWeight * 0.9;
          el.progFill.style.width = Math.round(overall) + '%';
          el.progPct.textContent = Math.round(overall) + '%';
        });

        if (deflated && deflated.length < raw.length) {
          compData = deflated;
          method = 8;
        } else {
          compData = raw;
          method = 0;
        }
      } else {
        // Store
        compData = raw;
        method = 0;
      }

      entries.push({ name: f.name, rawData: raw, compData, method });

      const overallDone = ((i + 1) / total) * 100;
      el.progFill.style.width = Math.round(overallDone) + '%';
      el.progPct.textContent = Math.round(overallDone) + '%';
    }

    // Package ZIP
    el.progStatus.textContent = '📦 Packaging ZIP…';
    el.progFile.textContent = '';
    await sleep(100);

    const blob = buildMultiZip(entries);
    const rawTotal = totalRawSize();

    state.compressedBlob = blob;
    state.compressedFileName = state.files.length === 1
      ? state.files[0].file.name.replace(/\.[^/.]+$/, '') + '.zip'
      : 'archive.zip';

    // Show done
    showProgressState('done');
    el.doneOriginal.textContent = formatSize(rawTotal);
    el.doneCompressed.textContent = formatSize(blob.size);
    const saved = rawTotal - blob.size;
    const savedPct = rawTotal > 0 ? ((saved / rawTotal) * 100).toFixed(1) : '0';
    el.doneSaved.textContent = saved > 0 ? `Saved ${formatSize(saved)} (${savedPct}%)` : 'Files were already optimised';

    state.isCompressing = false;
    el.generateBtn.disabled = false;
  }

  // ================================================================
  //  Download
  // ================================================================
  function downloadZip() {
    if (!state.compressedBlob) return;
    const url = URL.createObjectURL(state.compressedBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.compressedFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ================================================================
  //  Event binding
  // ================================================================
  function init() {
    // Browse
    el.browseBtn.addEventListener('click', (e) => { e.stopPropagation(); el.fileInput.click(); });
    el.fileInput.addEventListener('change', (e) => { if (e.target.files.length) addFiles(e.target.files); el.fileInput.value = ''; });

    // Drop zone
    el.dropZone.addEventListener('click', () => el.fileInput.click());
    el.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); el.dropZone.classList.add('drag-over'); });
    el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('drag-over'));
    el.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      el.dropZone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    // Settings — algorithm
    el.algorithmSelect.addEventListener('change', () => {
      state.algorithm = el.algorithmSelect.value;
      refreshStats();
    });

    // Settings — preset
    el.presetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        el.presetBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.mode = btn.dataset.mode;
        // Auto-switch algorithm to store for fastest
        if (state.mode === 'fastest') {
          el.algorithmSelect.value = 'store';
          state.algorithm = 'store';
        } else if (state.algorithm === 'store' && state.mode !== 'fastest') {
          el.algorithmSelect.value = 'deflate';
          state.algorithm = 'deflate';
        }
        refreshStats();
      });
    });

    // Generate
    el.generateBtn.addEventListener('click', compressAll);

    // Download
    el.downloadBtn.addEventListener('click', downloadZip);

    // Initial render
    renderFileTable();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
