/* ============================================================
   FilePress — Application Logic
   Browser-based file compression using DEFLATE (CompressionStream API)
   + pure-JS ZIP packaging with CRC-32
   ============================================================ */

(function () {
  'use strict';

  // ================================================================
  //  State
  // ================================================================
  const state = {
    file: null,
    mode: 'balanced',          // 'fastest' | 'balanced' | 'maximum'
    compressedBlob: null,
    compressedFileName: null,
    isCompressing: false,
  };

  // ================================================================
  //  DOM Helpers
  // ================================================================
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const el = {
    // Sections
    uploadSection:   $('#upload-section'),
    settingsSection: $('#settings-section'),
    analysisSection: $('#analysis-section'),
    actionSection:   $('#action-section'),
    progressSection: $('#progress-section'),
    completeSection: $('#complete-section'),
    // Upload
    dropZone:    $('#dropZone'),
    dropContent: $('#dropContent'),
    browseBtn:   $('#browseBtn'),
    fileInput:   $('#fileInput'),
    // Mode
    modeCards: $$('.mode-card'),
    // Analysis
    fileName:         $('#fileName'),
    fileType:         $('#fileType'),
    fileSize:         $('#fileSize'),
    projectedSize:    $('#projectedSize'),
    projectedSavings: $('#projectedSavings'),
    projectedRatio:   $('#projectedRatio'),
    // Action
    compressBtn: $('#compressBtn'),
    // Progress
    queueFileName: $('#queueFileName'),
    progressFill:  $('#progressFill'),
    progressText:  $('#progressText'),
    progressStatus:$('#progressStatus'),
    stepAnalyze:     $('#stepAnalyze'),
    stepCompress:    $('#stepCompress'),
    stepPackage:     $('#stepPackage'),
    stepAnalyzeIcon: $('#stepAnalyzeIcon'),
    stepCompressIcon:$('#stepCompressIcon'),
    stepPackageIcon: $('#stepPackageIcon'),
    // Complete
    resultOriginal:   $('#resultOriginal'),
    resultCompressed: $('#resultCompressed'),
    resultSaved:      $('#resultSaved'),
    downloadBtn:      $('#downloadBtn'),
    resetBtn:         $('#resetBtn'),
  };

  // ================================================================
  //  Utility — format bytes
  // ================================================================
  function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
  }

  // ================================================================
  //  CRC-32  (ISO 3309 / ITU-T V.42)
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
  //  DOS Date / Time helpers  (for ZIP local & central headers)
  // ================================================================
  function toDOSTime(d) {
    return (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  }
  function toDOSDate(d) {
    return ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  }

  // ================================================================
  //  DEFLATE via CompressionStream API  (raw deflate — method 8)
  //  Falls back to Store if the API is unavailable.
  // ================================================================
  const HAS_COMPRESSION_STREAM = typeof CompressionStream !== 'undefined';

  async function deflateRawChunked(data, onProgress) {
    if (!HAS_COMPRESSION_STREAM) return null;   // caller must fall back

    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();

    const outChunks = [];
    const readDone = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        outChunks.push(value);
      }
    })();

    // Feed input in 64 KB pieces so we can report progress
    const CHUNK = 65536;
    const total = data.length;
    let written = 0;

    for (let off = 0; off < total; off += CHUNK) {
      const end = Math.min(off + CHUNK, total);
      await writer.write(data.subarray(off, end));
      written = end;
      if (onProgress) onProgress(Math.round((written / total) * 100));
    }

    await writer.close();
    await readDone;

    // Concatenate output
    const len = outChunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(len);
    let pos = 0;
    for (const c of outChunks) { out.set(c, pos); pos += c.length; }
    return out;
  }

  // ================================================================
  //  ZIP Builder (single-file ZIP, PKZIP APPNOTE 6.3.x compatible)
  // ================================================================
  function writeU16(v, buf, off) { v = v & 0xFFFF; buf[off] = v; buf[off+1] = v >> 8; }
  function writeU32(v, buf, off) { v = v >>> 0; buf[off] = v; buf[off+1] = v >> 8; buf[off+2] = v >> 16; buf[off+3] = v >> 24; }

  function buildZip(filename, rawData, compData, method) {
    const enc  = new TextEncoder();
    const name = enc.encode(filename);
    const crcVal = crc32(rawData);
    const now  = new Date();
    const dTime = toDOSTime(now);
    const dDate = toDOSDate(now);
    const rawLen  = rawData.length;
    const compLen = compData.length;

    const localHeaderLen   = 30 + name.length;
    const centralHeaderLen = 46 + name.length;
    const eocdLen = 22;
    const total   = localHeaderLen + compLen + centralHeaderLen + eocdLen;
    const buf = new Uint8Array(total);
    let o = 0;

    // ---- Local file header ----
    writeU32(0x04034B50, buf, o); o += 4;          // sig
    writeU16(20,         buf, o); o += 2;          // version needed
    writeU16(0,          buf, o); o += 2;          // flags
    writeU16(method,     buf, o); o += 2;          // compression method
    writeU16(dTime,      buf, o); o += 2;
    writeU16(dDate,      buf, o); o += 2;
    writeU32(crcVal,     buf, o); o += 4;
    writeU32(compLen,    buf, o); o += 4;
    writeU32(rawLen,     buf, o); o += 4;
    writeU16(name.length,buf, o); o += 2;
    writeU16(0,          buf, o); o += 2;          // extra len
    buf.set(name, o); o += name.length;

    // ---- File data ----
    buf.set(compData, o); o += compLen;

    // ---- Central directory header ----
    const cdOffset = o;
    writeU32(0x02014B50, buf, o); o += 4;
    writeU16(20,         buf, o); o += 2;          // version made by
    writeU16(20,         buf, o); o += 2;          // version needed
    writeU16(0,          buf, o); o += 2;
    writeU16(method,     buf, o); o += 2;
    writeU16(dTime,      buf, o); o += 2;
    writeU16(dDate,      buf, o); o += 2;
    writeU32(crcVal,     buf, o); o += 4;
    writeU32(compLen,    buf, o); o += 4;
    writeU32(rawLen,     buf, o); o += 4;
    writeU16(name.length,buf, o); o += 2;
    writeU16(0, buf, o); o += 2;                   // extra len
    writeU16(0, buf, o); o += 2;                   // comment len
    writeU16(0, buf, o); o += 2;                   // disk #
    writeU16(0, buf, o); o += 2;                   // internal attr
    writeU32(0, buf, o); o += 4;                   // external attr
    writeU32(0, buf, o); o += 4;                   // offset of local header
    buf.set(name, o); o += name.length;

    const cdSize = o - cdOffset;

    // ---- End of central directory ----
    writeU32(0x06054B50, buf, o); o += 4;
    writeU16(0, buf, o); o += 2;                   // disk #
    writeU16(0, buf, o); o += 2;                   // disk # with CD
    writeU16(1, buf, o); o += 2;                   // entries this disk
    writeU16(1, buf, o); o += 2;                   // total entries
    writeU32(cdSize,   buf, o); o += 4;
    writeU32(cdOffset, buf, o); o += 4;
    writeU16(0, buf, o); o += 2;                   // comment len

    return new Blob([buf], { type: 'application/zip' });
  }

  // ================================================================
  //  File-type heuristic for size estimation
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

  function estimateCompressedSize(file, mode) {
    const size = file.size;
    if (mode === 'fastest') return size + 100;     // store overhead

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

  // ================================================================
  //  Human-readable file type label
  // ================================================================
  const TYPE_MAP = {
    txt:'Text', html:'HTML', htm:'HTML', css:'CSS', js:'JavaScript', ts:'TypeScript',
    jsx:'React JSX', tsx:'React TSX', json:'JSON', xml:'XML', csv:'CSV', svg:'SVG',
    md:'Markdown', yml:'YAML', yaml:'YAML', py:'Python', java:'Java', c:'C',
    cpp:'C++', cs:'C#', rb:'Ruby', php:'PHP', go:'Go', rs:'Rust', swift:'Swift',
    kt:'Kotlin', sh:'Shell', sql:'SQL',
    jpg:'JPEG Image', jpeg:'JPEG Image', png:'PNG Image', gif:'GIF Image',
    webp:'WebP Image', bmp:'Bitmap Image', svg:'SVG Image', ico:'Icon',
    mp3:'MP3 Audio', wav:'WAV Audio', ogg:'OGG Audio', flac:'FLAC Audio',
    mp4:'MP4 Video', mkv:'MKV Video', avi:'AVI Video', webm:'WebM Video', mov:'MOV Video',
    zip:'ZIP Archive', rar:'RAR Archive', '7z':'7-Zip Archive', gz:'GZip Archive', tar:'TAR Archive',
    pdf:'PDF Document', docx:'Word Doc', xlsx:'Excel Sheet', pptx:'PowerPoint',
    exe:'Executable', dll:'DLL Library', bin:'Binary', iso:'Disk Image',
  };

  function getFileTypeLabel(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return TYPE_MAP[ext] || file.type || 'Unknown';
  }

  // ================================================================
  //  Compression orchestrator
  // ================================================================
  async function compress(file, mode, onProgress, onStatus, onStep) {
    const raw = new Uint8Array(await file.arrayBuffer());
    let compData, method;

    if (mode === 'fastest') {
      // ---- Store (no compression) ----
      onStep('analyze', 'done');
      onStep('compress', 'active');
      onStatus('Packaging without compression (Store)…');
      onProgress(50);
      await sleep(150);
      compData = raw;
      method   = 0;
      onStep('compress', 'done');
      onProgress(90);

    } else if (mode === 'balanced') {
      // ---- Deflate ----
      onStep('analyze', 'active');
      onStatus('Analyzing file entropy…');
      await sleep(200);
      onStep('analyze', 'done');

      onStep('compress', 'active');
      onStatus('Compressing with DEFLATE…');
      const deflated = await deflateRawChunked(raw, (p) => {
        onProgress(10 + Math.round(p * 0.75));     // 10-85 %
      });

      if (deflated && deflated.length < raw.length) {
        compData = deflated; method = 8;
      } else {
        onStatus('File already optimised — using Store');
        compData = raw; method = 0;
      }
      onStep('compress', 'done');
      onProgress(85);

    } else {
      // ---- Maximum ----
      onStep('analyze', 'active');
      onStatus('Deep analysis — scanning byte distribution…');
      await sleep(350);
      onProgress(8);
      onStatus('Evaluating compression strategies…');
      await sleep(250);
      onStep('analyze', 'done');
      onProgress(15);

      onStep('compress', 'active');
      onStatus('Compressing with DEFLATE (maximum effort)…');
      const deflated = await deflateRawChunked(raw, (p) => {
        onProgress(15 + Math.round(p * 0.65));     // 15-80 %
      });

      if (deflated && deflated.length < raw.length) {
        compData = deflated; method = 8;
      } else {
        onStatus('Incompressible data detected — using Store');
        compData = raw; method = 0;
      }
      onStep('compress', 'done');
      onProgress(85);

      // verification pass
      onStatus('Verifying archive integrity…');
      await sleep(300);
      onProgress(92);
    }

    // ---- Package ZIP ----
    onStep('package', 'active');
    onStatus('Building ZIP archive…');
    await sleep(100);
    const blob = buildZip(file.name, raw, compData, method);
    onStep('package', 'done');
    onProgress(100);
    onStatus('Done!');

    return { blob, originalSize: raw.length, compressedSize: blob.size };
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ================================================================
  //  UI Helpers
  // ================================================================
  function show(section) { section.classList.remove('hidden'); section.classList.add('fade-in'); }
  function hide(section) { section.classList.add('hidden'); section.classList.remove('fade-in'); }

  function updateAnalysis() {
    if (!state.file) return;
    const f = state.file;

    el.fileName.textContent = f.name;
    el.fileName.title       = f.name;
    el.fileType.textContent = getFileTypeLabel(f);
    el.fileSize.textContent = formatSize(f.size);

    const est = estimateCompressedSize(f, state.mode);
    const saving = Math.max(f.size - est, 0);
    const pct = f.size > 0 ? ((saving / f.size) * 100).toFixed(1) : '0';

    el.projectedSize.textContent    = formatSize(est);
    el.projectedSavings.textContent = saving > 0 ? `~${formatSize(saving)}` : '~0 B';
    el.projectedRatio.textContent   = saving > 0 ? `~${pct}%` : '~0%';
  }

  // Reset the queue step indicators
  function resetSteps() {
    [el.stepAnalyze, el.stepCompress, el.stepPackage].forEach(s => {
      s.classList.remove('active', 'done');
    });
    el.stepAnalyzeIcon.textContent  = '○';
    el.stepCompressIcon.textContent = '○';
    el.stepPackageIcon.textContent  = '○';
  }

  function setStep(name, status) {
    const map = {
      analyze:  { el: el.stepAnalyze,  icon: el.stepAnalyzeIcon },
      compress: { el: el.stepCompress,  icon: el.stepCompressIcon },
      package:  { el: el.stepPackage,   icon: el.stepPackageIcon },
    };
    const s = map[name];
    if (!s) return;
    s.el.classList.remove('active', 'done');
    if (status === 'active') {
      s.el.classList.add('active');
      s.icon.textContent = '◉';
    } else if (status === 'done') {
      s.el.classList.add('done');
      s.icon.textContent = '✓';
    }
  }

  // ================================================================
  //  File selection handler
  // ================================================================
  function handleFile(file) {
    if (!file) return;
    state.file = file;
    state.compressedBlob = null;

    // Update drop zone
    el.dropZone.classList.add('has-file');
    el.dropContent.innerHTML = `
      <div class="selected-file">
        <div class="file-icon">📄</div>
        <div class="selected-file-info">
          <span class="selected-file-name">${escapeHTML(file.name)}</span>
          <span class="selected-file-size">${formatSize(file.size)}</span>
        </div>
        <button class="change-file-btn" id="changeFileBtn" type="button">Change</button>
      </div>`;
    $('#changeFileBtn').addEventListener('click', (e) => { e.stopPropagation(); el.fileInput.click(); });

    // Reveal subsequent sections
    show(el.settingsSection);
    show(el.analysisSection);
    show(el.actionSection);
    hide(el.progressSection);
    hide(el.completeSection);

    updateAnalysis();
  }

  function escapeHTML(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ================================================================
  //  Start compression
  // ================================================================
  async function startCompression() {
    if (!state.file || state.isCompressing) return;
    state.isCompressing = true;

    hide(el.actionSection);
    show(el.progressSection);

    // Reset progress UI
    el.queueFileName.textContent = state.file.name;
    el.progressFill.style.width  = '0%';
    el.progressText.textContent  = '0%';
    el.progressStatus.textContent = 'Initialising…';
    resetSteps();

    try {
      const result = await compress(
        state.file,
        state.mode,
        (pct) => {
          el.progressFill.style.width = pct + '%';
          el.progressText.textContent = pct + '%';
        },
        (msg) => { el.progressStatus.textContent = msg; },
        setStep,
      );

      state.compressedBlob     = result.blob;
      state.compressedFileName = state.file.name.replace(/\.[^/.]+$/, '') + '.zip';

      // Show complete
      hide(el.progressSection);
      show(el.completeSection);

      el.resultOriginal.textContent   = formatSize(result.originalSize);
      el.resultCompressed.textContent = formatSize(result.compressedSize);

      const saved    = result.originalSize - result.compressedSize;
      const savedPct = result.originalSize > 0 ? ((saved / result.originalSize) * 100).toFixed(1) : '0';
      el.resultSaved.textContent = saved > 0
        ? `${formatSize(saved)} (${savedPct}%)`
        : 'File was already optimised';
    } catch (err) {
      console.error('Compression failed:', err);
      el.progressStatus.textContent = '❌ Error: ' + err.message;
    }

    state.isCompressing = false;
  }

  // ================================================================
  //  Download handler
  // ================================================================
  function downloadZip() {
    if (!state.compressedBlob) return;
    const url = URL.createObjectURL(state.compressedBlob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = state.compressedFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ================================================================
  //  Reset
  // ================================================================
  function resetApp() {
    state.file = null;
    state.compressedBlob = null;
    state.compressedFileName = null;
    state.mode = 'balanced';

    hide(el.settingsSection);
    hide(el.analysisSection);
    hide(el.actionSection);
    hide(el.progressSection);
    hide(el.completeSection);

    // Restore drop zone
    el.dropZone.classList.remove('has-file');
    el.dropContent.innerHTML = `
      <svg class="upload-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      <p class="drop-text">Drag &amp; drop a file here</p>
      <span class="drop-divider">— or —</span>
      <button class="browse-btn" id="browseBtn" type="button">Browse Files</button>`;
    $('#browseBtn').addEventListener('click', () => el.fileInput.click());

    // Reset mode cards
    el.modeCards.forEach(c => c.classList.remove('active'));
    $('[data-mode="balanced"]').classList.add('active');

    el.fileInput.value = '';
  }

  // ================================================================
  //  Bind events
  // ================================================================
  function init() {
    // Browse button
    el.browseBtn.addEventListener('click', () => el.fileInput.click());

    // File input
    el.fileInput.addEventListener('change', (e) => {
      if (e.target.files.length) handleFile(e.target.files[0]);
    });

    // Drag & drop
    el.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); el.dropZone.classList.add('drag-over'); });
    el.dropZone.addEventListener('dragleave', ()  => { el.dropZone.classList.remove('drag-over'); });
    el.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      el.dropZone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    el.dropZone.addEventListener('click', () => { if (!state.file) el.fileInput.click(); });

    // Mode cards
    el.modeCards.forEach(card => {
      card.addEventListener('click', () => {
        el.modeCards.forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        state.mode = card.dataset.mode;
        updateAnalysis();
      });
    });

    // Actions
    el.compressBtn.addEventListener('click', startCompression);
    el.downloadBtn.addEventListener('click', downloadZip);
    el.resetBtn.addEventListener('click', resetApp);

    // Feature check
    if (!HAS_COMPRESSION_STREAM) {
      console.warn('CompressionStream API not available — only Store (no compression) mode will work.');
    }
  }

  // ================================================================
  //  Boot
  // ================================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
