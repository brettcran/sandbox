/* TurboSign 4.0 — CDN-only ESM build (with in-app Debug Console)
   - PDF.js v5 via CDN ESM + module worker (fallback to main thread)
   - pdf-lib via CDN ESM (+esm)
   - Same UX as 4.0: open, text/stamp/sign, drag, undo/redo, save (flatten), pinch zoom
   - NEW: Debug Console (toggle long-press Help, or ?debug=1)
*/

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.mjs';
const WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.worker.mjs';

// pdf-lib (pure ESM)
import { PDFDocument, rgb, StandardFonts } from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';

/* ========== tiny debug console ========== */
const Debug = (() => {
  let panel, list, vis = false;
  const qsShow = new URLSearchParams(location.search).get('debug') === '1';

  function build() {
    panel = document.createElement('div');
    panel.id = 'ts-debug';
    Object.assign(panel.style, {
      position: 'fixed', bottom: '88px', right: '10px', zIndex: 9999,
      width: 'min(92vw, 520px)', maxHeight: '40vh', overflow: 'auto',
      background: 'rgba(10,12,18,.92)', color: '#e9eef5',
      border: '1px solid rgba(255,255,255,.18)', borderRadius: '10px',
      font: '12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      padding: '10px', boxShadow: '0 8px 28px rgba(0,0,0,.45)', display: 'none'
    });
    const header = document.createElement('div');
    header.textContent = 'TurboSign Debug';
    Object.assign(header.style, { fontWeight: '700', marginBottom: '8px' });

    const row = document.createElement('div');
    row.style.display = 'flex'; row.style.gap = '8px'; row.style.marginBottom = '8px';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    Object.assign(clearBtn.style, chipStyle());
    clearBtn.onclick = () => { list.innerHTML = ''; log('— cleared —'); };
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    Object.assign(copyBtn.style, chipStyle());
    copyBtn.onclick = async () => {
      try {
        const text = [...list.querySelectorAll('div')].map(d => d.textContent).join('\n');
        await navigator.clipboard.writeText(text);
        toast('Copied debug log');
      } catch {
        toast('Copy failed', 'err');
      }
    };
    row.append(clearBtn, copyBtn);

    list = document.createElement('div');
    panel.append(header, row, list);
    document.body.appendChild(panel);
    if (qsShow) show(true);
  }
  function chipStyle() {
    return {
      appearance: 'none', border: '1px solid rgba(255,255,255,.18)',
      background: '#1c2430', color: '#e9eef5', borderRadius: '8px',
      padding: '6px 10px', cursor: 'pointer', font: '12px system-ui'
    };
  }
  function fmt(x) { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }
  function log(...args) {
    if (!list) return;
    const d = document.createElement('div');
    const ts = new Date().toISOString().split('T')[1].replace('Z','');
    d.textContent = `[${ts}] ${args.map(fmt).join(' ')}`;
    list.appendChild(d);
    // Keep last ~400 entries
    if (list.children.length > 400) list.removeChild(list.firstChild);
    // Auto-scroll
    list.scrollTop = list.scrollHeight;
    // Mirror to real console too
    // eslint-disable-next-line no-console
    console.log('[TS]', ...args);
  }
  function show(on) {
    vis = on;
    if (!panel) build();
    panel.style.display = vis ? 'block' : 'none';
  }
  function toggle() { show(!vis); }
  return { build, log, show, toggle };
})();
Debug.build();

/* ========== helpers & refs ========== */
const $ = (s, r=document) => r.querySelector(s);
const on = (el, ev, cb, opts) => el && el.addEventListener(ev, cb, opts);
const once = (el, ev, cb, opts) => el && el.addEventListener(ev, function h(e){ el.removeEventListener(ev, h, opts); cb(e); }, opts);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isTouch = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;

const refs = {
  scroll: $('#pdf-scroll'),
  container: $('#pdf-container'),
  fileInput: $('#file-input'),
  textBtn: document.querySelector('[data-act="text"]'),
  stampBtn: document.querySelector('[data-act="stamp"]'),
  signBtn: document.querySelector('[data-act="sign"]'),
  undoBtn: document.querySelector('[data-act="undo"]'),
  redoBtn: document.querySelector('[data-act="redo"]'),
  helpBtn: document.querySelector('[data-act="help"]'),
  saveBtn: document.querySelector('[data-act="save"]'),
  sigModal: $('#sign-modal'), sigPad: $('#sig-pad'),
  sigUse: $('#sig-use'), sigClear: $('#sig-clear'), sigCancel: $('#sig-cancel'),
  restoreBanner: $('#restore-banner'), restoreText: $('#restore-text'),
  restoreYes: $('#restore-yes'), restoreNo: $('#restore-no'),
};

const toast = (msg, kind='ok', t=2400) => {
  const n = $('#toast'); if (!n) return;
  n.textContent = msg; n.className=''; n.classList.add('show', kind);
  clearTimeout(n._t); n._t = setTimeout(()=>{ n.className=''; }, t);
  Debug.log('TOAST:', kind, msg);
};

/* ========== PDF.js worker set up (log paths & fallbacks) ========== */
(() => {
  Debug.log('PDF.js core:', 'cdn pdf.mjs');
  try {
    const w = new Worker(WORKER_URL, { type: 'module' });
    pdfjsLib.GlobalWorkerOptions.workerPort = w;
    Debug.log('PDF.js worker: module OK →', WORKER_URL);
  } catch (e) {
    pdfjsLib.GlobalWorkerOptions.workerPort = null;
    Debug.log('PDF.js worker FAILED; render on main thread', String(e?.message||e));
  }
})();

/* ========== state ========== */
let CURRENT_PDF = { file:null, bytes:null, filename:null, wraps:[], vpCSSByPage:[] };
let LAST_SIG_DATAURL = null;

/* ========== zoom (4.0) ========== */
const zoom = {
  scale: 1, min: 0.6, max: 3, suspended:false,
  setScale(newScale, cx, cy){
    newScale = clamp(newScale, this.min, this.max);
    if (newScale === this.scale) return;

    const scroll = refs.scroll;
    const rect = scroll.getBoundingClientRect();

    const contentW0 = refs.container.scrollWidth * this.scale;
    const contentH0 = refs.container.scrollHeight * this.scale;
    const contentW1 = refs.container.scrollWidth * newScale;
    const contentH1 = refs.container.scrollHeight * newScale;

    const gx0 = Math.max(0, (scroll.clientWidth  - contentW0) / 2);
    const gy0 = Math.max(0, (scroll.clientHeight - contentH0) / 2);
    const gx1 = Math.max(0, (scroll.clientWidth  - contentW1) / 2);
    const gy1 = Math.max(0, (scroll.clientHeight - contentH1) / 2);

    const contentX = (scroll.scrollLeft + (cx - rect.left) - gx0) / this.scale;
    const contentY = (scroll.scrollTop  + (cy - rect.top ) - gy0) / this.scale;

    this.scale = newScale;
    refs.container.style.transformOrigin = '0 0';
    refs.container.style.transform = `scale(${this.scale})`;

    let newScrollLeft = contentX * this.scale - (cx - rect.left) + gx1;
    let newScrollTop  = contentY * this.scale - (cy - rect.top ) + gy1;

    const maxX = Math.max(0, contentW1 - scroll.clientWidth);
    const maxY = Math.max(0, contentH1 - scroll.clientHeight);
    scroll.scrollLeft = clamp(newScrollLeft, 0, maxX);
    scroll.scrollTop  = clamp(newScrollTop , 0, maxY);

    if (contentW1 <= scroll.clientWidth)  scroll.scrollLeft = 0;
    if (contentH1 <= scroll.clientHeight) scroll.scrollTop  = 0;
  }
};

// Pinch & wheel — with debug breadcrumbs
(function wirePinch(){
  const pts = new Map(); let lastDist=0, cx=0, cy=0, pinching=false;

  const onPD = (e)=>{ if(zoom.suspended) return; pts.set(e.pointerId, e);
    if(pts.size===2){ const [a,b]=[...pts.values()]; lastDist=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); cx=(a.clientX+b.clientX)/2; cy=(a.clientY+b.clientY)/2; pinching=true; refs.scroll.style.touchAction='none'; Debug.log('PINCH:start', 'cx,cy=', cx, cy); } };
  const onPM = (e)=>{ if(!pts.has(e.pointerId)) return; pts.set(e.pointerId,e);
    if(pinching && pts.size===2){ const [a,b]=[...pts.values()]; const d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); cx=(a.clientX+b.clientX)/2; cy=(a.clientY+b.clientY)/2; if(lastDist){ const f=d/lastDist; zoom.setScale(zoom.scale*f,cx,cy); Debug.log('PINCH:move', 'factor=', f.toFixed(3), 'scale=', zoom.scale.toFixed(3)); } lastDist=d; e.preventDefault(); } };
  const onPU = (e)=>{ pts.delete(e.pointerId); if(pts.size<2){ pinching=false; lastDist=0; refs.scroll.style.touchAction='pan-y'; Debug.log('PINCH:end'); } };

  refs.scroll.addEventListener('pointerdown', onPD);
  refs.scroll.addEventListener('pointermove', onPM, {passive:false});
  refs.scroll.addEventListener('pointerup', onPU);
  refs.scroll.addEventListener('pointercancel', onPU);

  refs.scroll.addEventListener('wheel', (e)=>{ if(!(e.ctrlKey||e.metaKey)) return; e.preventDefault();
    const f = (e.deltaY<0?1.1:0.9); zoom.setScale(zoom.scale*f, e.clientX, e.clientY); Debug.log('WHEEL:', 'factor=', f, 'scale=', zoom.scale.toFixed(3)); }, {passive:false});

  const withinStage = el => !!el && (el===refs.scroll || el===refs.container || el.closest?.('#pdf-stage, #pdf-scroll, #pdf-container'));
  addEventListener('gesturestart',  e=>{ if(withinStage(e.target)) e.preventDefault(); }, {passive:false});
  addEventListener('gesturechange', e=>{ if(withinStage(e.target)) e.preventDefault(); }, {passive:false});
  addEventListener('gestureend',    e=>{ if(withinStage(e.target)) e.preventDefault(); }, {passive:false});
  refs.scroll.addEventListener('touchmove', (e)=>{ if(e.touches && e.touches.length>1) e.preventDefault(); }, {passive:false});
})();

function centerHorizontally(){
  const w = CURRENT_PDF.vpCSSByPage[0]?.width ||
            parseFloat(CURRENT_PDF.wraps[0]?.querySelector('canvas')?.style.width || '0');
  if(!w) return;
  const desired = Math.max(0, (w*zoom.scale - refs.scroll.clientWidth)/2);
  refs.scroll.scrollLeft = desired;
  const totalH = refs.container.scrollHeight * zoom.scale;
  if (totalH <= refs.scroll.clientHeight) refs.scroll.scrollTop = 0;
  Debug.log('CENTER: scrollLeft=', refs.scroll.scrollLeft, 'scale=', zoom.scale.toFixed(3));
}
on(window,'resize', centerHorizontally);

/* ========== Annotations (4.0) ========== */
class Annotations{
  constructor(container){
    this.container=container; this.mode=null; this.overlays=[]; this.selected=null;
    this.history=[]; this.redoStack=[]; this.textStyle={ size:16, color:'#000', bold:false, italic:false, family:'Arial, sans-serif' };
    this.drag={ el:null, overlay:null, dx:0, dy:0 }; this.resize={ el:null, overlay:null, startW:0, startH:0, sx:0, sy:0 };
    on(document,'pointermove',e=>this._onMove(e),{passive:false});
    on(document,'pointerup',  e=>this._onUp(e));
  }
  setMode(m){
    this.mode=m;
    ['text','stamp','sign'].forEach(k=>document.querySelector(`[data-act="${k}"]`)?.classList.toggle('active', this.mode===k));
    this._select(null);
    Debug.log('MODE:', m ?? 'off');
  }
  attachOverlays(wrapInfos){
    this.overlays.forEach(ov=>ov.remove()); this.overlays=[];
    wrapInfos.forEach(({wrap}, i)=>{
      const ov=document.createElement('div'); ov.className='overlay'; wrap.appendChild(ov);
      on(ov,'pointerdown', e=>{ if(e.target===ov) this._select(null); }, {passive:true});

      on(ov,'dblclick', e=>{
        if (e.target!==ov) return;
        if (this.mode==='text'){
          const {x,y}=this._pos(ov,e); this._addText(ov,x,y,true); Debug.log('TEXT:add@dbl', 'page=', i+1, 'pos=', x,y);
        } else if (this.mode==='sign'){
          if (!LAST_SIG_DATAURL){ toast('Draw a signature first', 'err'); sigCtl.open(); return; }
          const {x,y}=this._pos(ov,e); const el=this._addSignature(ov,x,y,LAST_SIG_DATAURL, ov.clientWidth*0.5);
          this._select(el); scrollAnnoIntoView(el); Debug.log('SIGN:add@dbl', 'page=', i+1, 'pos=', x,y);
        }
      });

      if(isTouch){
        let t=0,lx=0,ly=0;
        on(ov,'pointerdown',e=>{
          if (e.pointerType!=='touch' || e.target!==ov) return;
          const now=performance.now(); const {x,y}=this._pos(ov,e);
          const dbl=(now-t<300 && Math.abs(x-lx)<24 && Math.abs(y-ly)<24); t=now; lx=x; ly=y;
          if(!dbl) return;
          if (this.mode==='text'){ this._addText(ov,x,y,true); Debug.log('TEXT:add@tap2', 'page=', i+1, 'pos=', x,y); }
          else if (this.mode==='sign'){ if(!LAST_SIG_DATAURL){ toast('Draw a signature first','err'); sigCtl.open(); return; } const el=this._addSignature(ov,x,y,LAST_SIG_DATAURL, ov.clientWidth*0.5); this._select(el); scrollAnnoIntoView(el); Debug.log('SIGN:add@tap2', 'page=', i+1, 'pos=', x,y); }
        }, {passive:true});
      }

      on(ov,'pointerdown', e=>{
        if(this.mode!=='stamp' || e.target!==ov) return;
        const {x,y}=this._pos(ov,e); this._addStamp(ov,x,y); Debug.log('STAMP:add', 'page=', i+1, 'pos=', x,y);
      }, {passive:true});

      this.overlays.push(ov);
    });
    Debug.log('OVERLAYS:attached', 'count=', this.overlays.length);
  }

  _pos(overlay,e){ const r=overlay.getBoundingClientRect(); return { x:(e.clientX-r.left)/zoom.scale, y:(e.clientY-r.top)/zoom.scale }; }
  _elSize(el){ return { w: el.offsetWidth, h: el.offsetHeight }; }

  _addText(overlay,x,y,focus){
    const el=document.createElement('div');
    el.className='anno text'; el.contentEditable='true'; el.style.left=`${x}px`; el.style.top=`${y}px`;
    const st=this.textStyle; el.style.color=st.color; el.style.fontSize=`${Math.max(16,st.size)}px`;
    el.style.fontWeight=st.bold?'700':'400'; el.style.fontStyle=st.italic?'italic':'normal'; el.style.fontFamily=st.family;
    overlay.appendChild(el); this._wireAnno(el, overlay, {resizable:false}); if(focus) this._focus(el);
    this._recordAdd(overlay, el);
  }

  _addStamp(overlay,x,y){
    const el=document.createElement('div'); el.className='anno stamp'; el.style.left=`${x}px`; el.style.top=`${y}px`;
    el.innerHTML=`<svg viewBox="0 0 24 24"><path d="M4 12l4 4 12-12"/></svg>`;
    overlay.appendChild(el); this._wireAnno(el, overlay, {resizable:false}); this._recordAdd(overlay, el);
  }

  _addSignature(overlay,x,y,dataURL,widthHint){
    const el=document.createElement('div'); el.className='anno sign'; el.style.left=`${x}px`; el.style.top=`${y}px`;
    const img=new Image(); img.draggable=false; img.src=dataURL; img.style.display='block';
    el.appendChild(img); overlay.appendChild(el);
    this._wireAnno(el, overlay, {resizable:true});
    img.onload=()=>{ const maxW=widthHint || Math.min(overlay.clientWidth*0.6, img.naturalWidth||img.width||300);
      img.style.width=maxW+'px'; img.style.height='auto'; scrollAnnoIntoView(el); };
    this._recordAdd(overlay, el); return el;
  }

  _wireAnno(el, overlay, {resizable}){
    const startDrag=(e)=>{ if(el.classList.contains('text') && document.activeElement===el){ this._select(el); return; }
      const {x,y}=this._pos(overlay,e); const left=parseFloat(el.style.left)||0, top=parseFloat(el.style.top)||0;
      this.drag={ el, overlay, dx:x-left, dy:y-top }; $('#pdf-scroll').style.touchAction='none'; zoom.suspended=true; el.setPointerCapture?.(e.pointerId); this._select(el); e.preventDefault(); };
    on(el,'pointerdown', startDrag, {passive:false});
    const innerImg=el.querySelector('img'); if(innerImg) on(innerImg,'pointerdown', startDrag, {passive:false});

    if(el.classList.contains('text')){ on(el,'dblclick',()=>{ this._focus(el); this._select(el); }); on(el,'input',()=>{}); }

    if(resizable && !el.classList.contains('text')){
      const h=document.createElement('div'); h.className='handle br';
      Object.assign(h.style,{ position:'absolute', right:'-8px', bottom:'-8px', width:'14px', height:'14px', background:'#fff', border:'2px solid #4ea3ff', borderRadius:'3px', cursor:'nwse-resize', touchAction:'none' });
      el.appendChild(h);
      on(h,'pointerdown',e=>{ e.stopPropagation(); const { w, h:hh } = this._elSize(el);
        this.resize={ el, overlay, startW:w, startH:hh, sx:e.clientX, sy:e.clientY }; $('#pdf-scroll').style.touchAction='none'; zoom.suspended=true; h.setPointerCapture?.(e.pointerId); }, {passive:false});
    }
  }

  _onMove(e){
    if(this.drag.el){
      const {x,y}=this._pos(this.drag.overlay,e);
      let nx=x-this.drag.dx, ny=y-this.drag.dy;
      const W=this.drag.overlay.clientWidth, H=this.drag.overlay.clientHeight;
      const {w:ew,h:eh}=this._elSize(this.drag.el);
      nx=Math.max(0,Math.min(nx,W-ew)); ny=Math.max(0,Math.min(ny,H-eh));
      this.drag.el.style.left=`${nx}px`; this.drag.el.style.top=`${ny}px`; e.preventDefault(); return;
    }
    if(this.resize.el){
      const dx=(e.clientX-this.resize.sx)/zoom.scale;
      const w=Math.max(24,this.resize.startW+dx);
      const img=this.resize.el.querySelector('img'); if(img){ img.style.width=w+'px'; img.style.height='auto'; }
      e.preventDefault();
    }
  }
  _onUp(e){
    const changed=this.drag.el||this.resize.el;
    if(this.drag.el){ try{this.drag.el.releasePointerCapture?.(e.pointerId)}catch{}; this.drag={el:null,overlay:null,dx:0,dy:0}; }
    if(this.resize.el){ try{this.resize.el.releasePointerCapture?.(e.pointerId)}catch{}; this.resize={el:null,overlay:null,startW:0,startH:0,sx:0,sy:0}; }
    $('#pdf-scroll').style.touchAction='pan-y'; zoom.suspended=false;
    if(changed) {/* mark dirty optional */}
  }

  _focus(el){ el.focus(); const sel=getSelection(); const range=document.createRange(); range.selectNodeContents(el); range.collapse(false); sel.removeAllRanges(); sel.addRange(range); }
  _select(el){ this.container.querySelectorAll('.anno').forEach(n=>n.classList.remove('selected')); this.selected=el; if(el) el.classList.add('selected'); }
  _recordAdd(overlay, el){ this.history.push({type:'add',overlay,el}); this.redoStack.length=0; }
  undo(){ const last=this.history.pop(); if(!last) return; if(last.el?.parentNode){ last.el.parentNode.removeChild(last.el); if(this.selected===last.el) this._select(null); this.redoStack.push(last);} }
  redo(){ const n=this.redoStack.pop(); if(!n) return; if(n.el){ n.overlay.appendChild(n.el); this.history.push(n);} }
}
const ann = new Annotations(refs.container);

function scrollAnnoIntoView(el){
  if (!el) return;
  const wrap = el.closest('.page-wrap'); if (!wrap) return;
  const rectC = $('#pdf-container').getBoundingClientRect();
  const wrapR = wrap.getBoundingClientRect();
  const elCX = (wrapR.left - rectC.left + el.offsetLeft + el.offsetWidth/2) * zoom.scale;
  const elCY = (wrapR.top  - rectC.top  + el.offsetTop  + el.offsetHeight/2) * zoom.scale;
  const targetLeft = clamp(elCX - refs.scroll.clientWidth/2, 0, refs.scroll.scrollWidth);
  const targetTop  = clamp(elCY - refs.scroll.clientHeight/2, 0, refs.scroll.scrollHeight);
  refs.scroll.scrollTo({ left: targetLeft, top: targetTop, behavior: 'smooth' });
}

/* ========== signature pad ========== */
class SigPad{
  constructor(canvas, modal){
    this.canvas=canvas; this.modal=modal; this.ctx=canvas.getContext('2d');
    this.clear(); this.drawing=false;
    const pos=ev=>{ const r=canvas.getBoundingClientRect(); const dpr=Math.max(1,devicePixelRatio||1); return {x:(ev.clientX-r.left)*dpr,y:(ev.clientY-r.top)*dpr}; };
    on(canvas,'pointerdown',e=>{ canvas.setPointerCapture?.(e.pointerId); this.drawing=true; const p=pos(e); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y); });
    on(canvas,'pointermove',e=>{ if(!this.drawing) return; const p=pos(e); this.ctx.lineTo(p.x,p.y); this.ctx.stroke(); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y); });
    on(canvas,'pointerup',()=>{ this.drawing=false; });
  }
  open(){ this.modal.classList.add('show'); }
  close(){ this.modal.classList.remove('show'); }
  clear(){
    const dpr=Math.max(1,devicePixelRatio||1);
    this.canvas.width=500*dpr; this.canvas.height=200*dpr;
    this.canvas.style.width='500px'; this.canvas.style.height='200px';
    const c=this.ctx; c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,this.canvas.width,this.canvas.height);
    c.lineWidth=2.5*dpr; c.strokeStyle='#000'; c.lineCap='round'; c.lineJoin='round';
  }
  dataURL(){ return this.canvas.toDataURL('image/png'); }
}
const sig = new SigPad(refs.sigPad, refs.sigModal);
class SigController{ constructor(sig,ann){ this.sig=sig; this.ann=ann; } open(){ this.sig.open(); } close(){ this.sig.close(); } use(){ LAST_SIG_DATAURL=this.sig.dataURL(); this.close(); this.ann.setMode('sign'); toast('Signature ready — double‑tap/click to place'); Debug.log('SIG:captured', LAST_SIG_DATAURL.slice(0,32)+'…'); } }
const sigCtl = new SigController(sig, ann);
refs.sigModal?.classList.remove('show');

/* ========== PDF helpers ========== */
function isValidPdfBytes(bytes){
  if (!bytes || !bytes.length) return false;
  const maxSkip = Math.min(8, bytes.length);
  for (let i=0; i<maxSkip; i++){
    if (bytes[i]===0x25 && bytes[i+1]===0x50 && bytes[i+2]===0x44 && bytes[i+3]===0x46 && bytes[i+4]===0x2D) return true; // %PDF-
  }
  return false;
}

/* ========== render ========== */
async function renderPdfFromFile(file, container, scale=1){
  Debug.log('OPEN:file', { name:file?.name, type:file?.type, size:file?.size });
  if (!file) { toast('No file selected','err'); return; }
  const ab = await file.arrayBuffer();
  const bytes = new Uint8Array(ab);
  Debug.log('OPEN:bytes[0..7]=', [...bytes.slice(0,8)]);
  CURRENT_PDF.file=file; CURRENT_PDF.bytes=bytes; CURRENT_PDF.filename=file.name||'document.pdf';
  return renderPdfFromData(bytes, container, scale);
}

async function renderPdfFromData(bytes, container, scale=1){
  if (!isValidPdfBytes(bytes)) {
    Debug.log('E-OPEN-HEADER', 'Missing %PDF- header', [...bytes.slice(0,16)]);
    toast('That file is not a valid PDF (no %PDF header).', 'err', 3600);
    throw new Error('E-OPEN-HEADER');
  }

  container.innerHTML=''; CURRENT_PDF.wraps=[]; CURRENT_PDF.vpCSSByPage=[];
  let pdf;
  try {
    Debug.log('PDF.js:getDocument start (bytes=', bytes.length, ')');
    pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    Debug.log('PDF.js:getDocument OK', 'pages=', pdf.numPages);
  } catch(err){
    Debug.log('E-GETDOC', String(err?.message||err));
    toast('Could not open PDF (engine error).', 'err', 3600);
    throw err;
  }

  const ratio=Math.max(1,Math.min(2,devicePixelRatio||1));
  for(let i=1;i<=pdf.numPages;i++){
    try {
      const page=await pdf.getPage(i);
      const vpCSS=page.getViewport({scale});
      const vpDev=page.getViewport({scale:scale*ratio});
      const wrap=document.createElement('div'); wrap.className='page-wrap';
      const canvas=document.createElement('canvas'); canvas.className='pdfpage';
      canvas.width=Math.floor(vpDev.width); canvas.height=Math.floor(vpDev.height);
      canvas.style.width=vpCSS.width+'px'; canvas.style.height=vpCSS.height+'px';
      wrap.appendChild(canvas); container.appendChild(wrap);
      const ctx=canvas.getContext('2d',{alpha:false,desynchronized:true});
      Debug.log('RENDER:page', i, 'vpCSS=', vpCSS.width+'x'+vpCSS.height, 'vpDev=', vpDev.width+'x'+vpDev.height);
      await page.render({canvasContext:ctx, viewport:vpDev, intent:'display'}).promise;
      CURRENT_PDF.wraps.push(wrap); CURRENT_PDF.vpCSSByPage.push({width:vpCSS.width,height:vpCSS.height});
    } catch (e) {
      Debug.log('E-RENDER-PAGE', i, String(e?.message||e));
    }
  }
  ann.attachOverlays(CURRENT_PDF.wraps.map((wrap,i)=>({wrap, vpCSS:CURRENT_PDF.vpCSSByPage[i]})));
  requestAnimationFrame(centerHorizontally); setTimeout(centerHorizontally,120);
  toast('PDF loaded ✔️');
}

/* ========== save (flatten) ========== */
async function saveFlattened(){
  if (!CURRENT_PDF.bytes){ toast('Open a PDF first','err'); Debug.log('E-SAVE-NOFILE'); return; }
  try{
    Debug.log('SAVE:load bytes=', CURRENT_PDF.bytes.length);
    const pdf  = await PDFDocument.load(CURRENT_PDF.bytes);
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    const helvB= await pdf.embedFont(StandardFonts.HelveticaBold);
    const pages= pdf.getPages();
    const embedOps = [];

    CURRENT_PDF.wraps.forEach((wrap, idx)=>{
      const overlay = wrap.querySelector('.overlay'); if(!overlay) return;
      const page = pages[idx];
      const pageW = page.getWidth(), pageH = page.getHeight();
      const vp = CURRENT_PDF.vpCSSByPage[idx];
      const fx = pageW / vp.width, fy = pageH / vp.height;

      overlay.querySelectorAll('.anno').forEach(el=>{
        const left=el.offsetLeft, top=el.offsetTop, w=el.offsetWidth, h=el.offsetHeight;
        const x=left*fx, y=pageH-(top+h)*fy;

        if (el.classList.contains('text')){
          const cs = getComputedStyle(el);
          const size = (parseFloat(cs.fontSize)||16) * fx;
          const [rr,gg,bb] = (cs.color.match(/\d+/g)||[0,0,0]).map(n=>parseInt(n,10)/255);
          const font = (parseInt(cs.fontWeight,10)||400) >= 600 ? helvB : helv;
          page.drawText(el.textContent||'', { x, y, size, font, color: rgb(rr,gg,bb) });
        } else if (el.classList.contains('stamp')){
          const stroke = rgb(0,0,0);
          const x1=x, y1=y+h*fy*0.45, x2=x+w*fx*0.35, y2=y+h*fy*0.15, x3=x+w*fx, y3=y+h*fy*0.85;
          page.drawLine({ start:{x:x1,y:y1}, end:{x:x2,y:y2}, thickness:2*fx, color:stroke });
          page.drawLine({ start:{x:x2,y:y2}, end:{x:x3,y:y3}, thickness:2*fx, color:stroke });
        } else {
          const img = el.querySelector('img'); if (!img) return;
          const p = (async ()=>{
            try{
              let bytes;
              if (img.src.startsWith('data:')){
                const b64=(img.src.split(',')[1]||''); const bin=atob(b64);
                bytes=new Uint8Array(bin.length); for(let i=0;i<bytes.length;i++) bytes[i]=bin.charCodeAt(i);
              } else {
                const res=await fetch(img.src,{mode:'cors'}); bytes=new Uint8Array(await res.arrayBuffer());
              }
              const png = await pdf.embedPng(bytes);
              page.drawImage(png, { x, y, width:w*fx, height:h*fy });
            }catch(err){ Debug.log('E-EMBED-PNG', String(err?.message||err)); }
          })();
          embedOps.push(p);
        }
      });
    });

    if (embedOps.length) await Promise.all(embedOps);
    const out = await pdf.save();
    const defaultName = (CURRENT_PDF.filename||'document.pdf').replace(/\.pdf$/i,'') + '-signed.pdf';

    if ('showSaveFilePicker' in window){
      try{
        const handle = await window.showSaveFilePicker({
          suggestedName: defaultName,
          types:[{ description:'PDF', accept:{ 'application/pdf':['.pdf'] } }]
        });
        const w = await handle.createWritable(); await w.write(out); await w.close();
        toast('Saved ✔️'); Debug.log('SAVE:OK via FS API', defaultName); return;
      }catch(e){ Debug.log('SAVE:FilePicker fallback', String(e?.message||e)); }
    }
    const blob = new Blob([out], { type:'application/pdf' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = defaultName;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 1200);
    toast('Downloaded ✔️'); Debug.log('SAVE:OK via download', defaultName);
  }catch(e){
    Debug.log('E-SAVE', String(e?.message||e));
    toast('Could not save PDF','err');
  }
}

/* ========== UI wiring ========== */
function wireUI(){
  // File input change
  on(refs.fileInput,'change',async e=>{
    const file=e.target.files?.[0];
    if(!file){ Debug.log('OPEN:change no file'); return; }
    try { await renderPdfFromFile(file, refs.container, 1); }
    catch(err){ Debug.log('E-OPEN-CHANGE', String(err?.message||err)); }
  });

  on(refs.textBtn,'click',()=>{ ann.setMode(ann.mode==='text'?null:'text'); toast(ann.mode?(isTouch?'Text: double‑tap':'Text: double‑click'):'Tool off'); });
  on(refs.stampBtn,'click',()=>{ ann.setMode(ann.mode==='stamp'?null:'stamp'); toast(ann.mode?'Stamp: tap/click':'Tool off'); });
  on(refs.signBtn,'click', ()=> sigCtl.open());
  on(refs.undoBtn,'click',()=>ann.undo());
  on(refs.redoBtn,'click',()=>ann.redo());

  // Help: short press → hint; long press (500ms) → toggle Debug panel
  let helpTimer=null;
  on(refs.helpBtn,'pointerdown',()=>{ helpTimer=setTimeout(()=>Debug.toggle(), 500); }, {passive:true});
  on(refs.helpBtn,'pointerup',  ()=>{ if(helpTimer){ clearTimeout(helpTimer); helpTimer=null; } else return;
    // if timer already fired, don't show toast
  }, {passive:true});
  on(refs.helpBtn,'click',()=>{ if(helpTimer){ // timer didn’t fire (short click)
      toast('📂 Open → double‑tap Text or Signature (draw first) → Save. Drag to move.','ok',4200);
    }
  });

  on(refs.saveBtn,'click',saveFlattened);

  on(refs.sigUse,'click',e=>{ e.stopPropagation(); sigCtl.use(); });
  on(refs.sigClear,'click',e=>{ e.stopPropagation(); sig.clear(); });
  on(refs.sigCancel,'click',e=>{ e.stopPropagation(); sigCtl.close(); });

  // Keyboard shortcut (Cmd/Ctrl+O) to open
  addEventListener('keydown', (e)=>{
    if ((e.ctrlKey||e.metaKey) && (e.key==='o' || e.key==='O')) {
      e.preventDefault();
      try{
        if (refs.fileInput.showPicker) refs.fileInput.showPicker();
        else refs.fileInput.click();
      }catch(err){ Debug.log('E-OPEN-KB', String(err?.message||err)); }
    }
  });
}
wireUI();

/* ========== benign rejections ========== */
addEventListener('unhandledrejection',ev=>{
  const m=String(ev.reason?.message||ev.reason||'');
  if(m.includes('Rendering cancelled')||m.includes('AbortError')) { ev.preventDefault(); Debug.log('IGNORED:', m); }
});

/* ========== end ========== */