/* TurboSign 4.0.x — Y-scroll “frame” + centered pinch zoom
   - New #pdf-stack inside #pdf-container (scale applies to stack)
   - X-axis locked (overflow-x:hidden); no horizontal drift
   - Pinch/wheel zoom keeps Y focus; X is always centered via layout
   - All 4.0 tools unchanged
*/

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.mjs';
const WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.worker.mjs';
import { PDFDocument, rgb, StandardFonts } from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';

const $ = (s, r=document) => r.querySelector(s);
const on = (el, ev, cb, opts) => el && el.addEventListener(ev, cb, opts);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isTouch = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;

const refs = {
  stage:  $('#pdf-stage'),
  scroll: $('#pdf-scroll'),
  container: $('#pdf-container'),
  stack:  $('#pdf-stack'),
  fileInput: $('#file-input'),
  toolbar: $('#toolbar'),
  openBtn: document.querySelector('[data-act="open"]'),
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
};

const toast = (msg, kind='ok', t=2400) => {
  const n = $('#toast'); if (!n) return; n.textContent = msg; n.className=''; n.classList.add('show', kind);
  clearTimeout(n._t); n._t = setTimeout(()=>{ n.className=''; }, t);
};

/* ---------- PDF.js worker boot (Safari-proof) ---------- */
async function bootPdfWorker(){
  try {
    const w1 = new Worker(WORKER_URL, { type: 'module' });
    pdfjsLib.GlobalWorkerOptions.workerPort = w1; return;
  } catch {}
  try {
    const code = await (await fetch(WORKER_URL, { mode:'cors', cache:'no-store' })).text();
    const blob = new Blob([code], { type:'text/javascript' });
    const url = URL.createObjectURL(blob);
    const w2 = new Worker(url, { type:'module' });
    pdfjsLib.GlobalWorkerOptions.workerPort = w2; return;
  } catch {}
  pdfjsLib.GlobalWorkerOptions.workerPort = null; // main-thread fallback
}
await bootPdfWorker();
try { pdfjsLib.setVerbosity?.((pdfjsLib.VerbosityLevel||{}).errors ?? 1); } catch {}

/* ---------- state ---------- */
let CURRENT_PDF = { file:null, bytes:null, filename:null, wraps:[], vpCSSByPage:[] };
let LAST_SIG_DATAURL = null;

/* ---------- Zoom (scale on #pdf-stack, X locked) ---------- */
const zoom = {
  scale: 1,
  min: 0.6,
  max: 3,
  suspended:false,

  setScale(newScale, _cx, cy){
    newScale = clamp(newScale, this.min, this.max);
    if (newScale === this.scale) return;

    // We'll keep X centered via layout, so we only adjust Y scroll to keep the pinch center vertically.
    const scroll = refs.scroll;
    const rect   = scroll.getBoundingClientRect();

    // content sizes using the *stack* (unscaled DOM height)
    const unscaledH = refs.stack.scrollHeight || 1;
    const contentH0 = unscaledH * this.scale;
    const contentH1 = unscaledH * newScale;

    // gutters (vertical top/bottom free space)
    const gy0 = Math.max(0, (scroll.clientHeight - contentH0) / 2);
    const gy1 = Math.max(0, (scroll.clientHeight - contentH1) / 2);

    const contentY = (scroll.scrollTop + (cy - rect.top) - gy0) / this.scale;

    this.scale = newScale;
    refs.stack.style.transformOrigin = '0 0';
    refs.stack.style.transform = `scale(${this.scale})`;

    // maintain same vertical content point under the gesture
    let newScrollTop = contentY * this.scale - (cy - rect.top) + gy1;

    // Clamp Y; X always 0 because overflow-x:hidden
    const maxY = Math.max(0, contentH1 - scroll.clientHeight);
    scroll.scrollTop = clamp(newScrollTop, 0, maxY);
  }
};

/* Pointer pinch (Y focus only) + wheel (ctrl/cmd) */
(function wirePinch(){
  const pts = new Map(); let lastDist=0, cx=0, cy=0, pinching=false;

  const onPD = (e)=>{ if(zoom.suspended) return; pts.set(e.pointerId, e);
    if(pts.size===2){ const [a,b]=[...pts.values()]; lastDist=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); cx=(a.clientX+b.clientX)/2; cy=(a.clientY+b.clientY)/2; pinching=true; refs.scroll.style.touchAction='none'; } };
  const onPM = (e)=>{ if(!pts.has(e.pointerId)) return; pts.set(e.pointerId,e);
    if(pinching && pts.size===2){ const [a,b]=[...pts.values()]; const d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
      cy=(a.clientY+b.clientY)/2;  // we only preserve Y focus
      if(lastDist){ zoom.setScale(zoom.scale*(d/lastDist), cx, cy); }
      lastDist=d; e.preventDefault(); } };
  const onPU = (e)=>{ pts.delete(e.pointerId); if(pts.size<2){ pinching=false; lastDist=0; refs.scroll.style.touchAction='pan-y'; } };

  refs.scroll.addEventListener('pointerdown', onPD);
  refs.scroll.addEventListener('pointermove', onPM, {passive:false});
  refs.scroll.addEventListener('pointerup', onPU);
  refs.scroll.addEventListener('pointercancel', onPU);

  refs.scroll.addEventListener('wheel', (e)=>{ if(!(e.ctrlKey||e.metaKey)) return; e.preventDefault();
    const factor = (e.deltaY < 0) ? 1.08 : 0.925; // a bit gentler
    zoom.setScale(zoom.scale*factor, e.clientX, e.clientY); }, {passive:false});

  // Block iOS native pinch inside stage
  const withinStage = el => !!el && (el===refs.scroll || el===refs.container || el.closest?.('#pdf-stage, #pdf-scroll, #pdf-container'));
  addEventListener('gesturestart',  e=>{ if(withinStage(e.target)) e.preventDefault(); }, {passive:false});
  addEventListener('gesturechange', e=>{ if(withinStage(e.target)) e.preventDefault(); }, {passive:false});
  addEventListener('gestureend',    e=>{ if(withinStage(e.target)) e.preventDefault(); }, {passive:false});
  refs.scroll.addEventListener('touchmove', (e)=>{ if(e.touches && e.touches.length>1) e.preventDefault(); }, {passive:false});
})();

/* Center on open: X via layout, Y to top */
function centerOnOpen(){
  refs.scroll.scrollLeft = 0; // X locked anyway
  refs.scroll.scrollTop  = 0; // start at top
}

/* ---------- Annotations (unchanged behavior) ---------- */
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
  }
  attachOverlays(wrapInfos){
    this.overlays.forEach(ov=>ov.remove()); this.overlays=[];
    wrapInfos.forEach(({wrap})=>{
      const ov=document.createElement('div'); ov.className='overlay'; wrap.appendChild(ov);

      on(ov,'dblclick', e=>{
        if (e.target!==ov) return;
        if (this.mode==='text'){
          const {x,y}=this._pos(ov,e); this._addText(ov,x,y,true);
        } else if (this.mode==='sign'){
          if (!LAST_SIG_DATAURL){ toast('Draw a signature first', 'err'); sigCtl.open(); return; }
          const {x,y}=this._pos(ov,e); const el=this._addSignature(ov,x,y,LAST_SIG_DATAURL, ov.clientWidth*0.5);
          this._select(el); scrollAnnoIntoView(el);
        }
      });

      if(isTouch){
        let t=0,lx=0,ly=0;
        on(ov,'pointerdown',e=>{
          if (e.pointerType!=='touch' || e.target!==ov) return;
          const now=performance.now(); const {x,y}=this._pos(ov,e);
          const dbl=(now-t<300 && Math.abs(x-lx)<24 && Math.abs(y-ly)<24); t=now; lx=x; ly=y;
          if(!dbl) return;
          if (this.mode==='text'){ this._addText(ov,x,y,true); }
          else if (this.mode==='sign'){ if(!LAST_SIG_DATAURL){ toast('Draw a signature first','err'); sigCtl.open(); return; } const el=this._addSignature(ov,x,y,LAST_SIG_DATAURL, ov.clientWidth*0.5); this._select(el); scrollAnnoIntoView(el); }
        }, {passive:true});
      }

      on(ov,'pointerdown', e=>{
        if(this.mode!=='stamp' || e.target!==ov) return;
        const {x,y}=this._pos(ov,e); this._addStamp(ov,x,y);
      }, {passive:true});

      this.overlays.push(ov);
    });
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
    el.innerHTML=`<svg viewBox="0 0 24 24" width="28" height="28"><path d="M4 12l4 4 12-12"/></svg>`;
    overlay.appendChild(el); this._wireAnno(el, overlay, {resizable:false}); this._recordAdd(overlay, el);
  }

  _addSignature(overlay,x,y,dataURL,widthHint){
    const el=document.createElement('div'); el.className='anno sign'; el.style.left=`${x}px`; el.style.top=`${y}px`;
    const img=new Image(); img.draggable=false; img.src=dataURL; img.style.display='block';
    el.appendChild(img); overlay.appendChild(el);
    this._wireAnno(el, overlay, {resizable:true});
    img.onload=()=>{ const maxW=widthHint || Math.min(overlay.clientWidth*0.6, img.naturalWidth||img.width||300); img.style.width=maxW+'px'; img.style.height='auto'; scrollAnnoIntoView(el); };
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
      on(h,'pointerdown',e=>{ e.stopPropagation(); const { w, h:hh } = this._elSize(el); this.resize={ el, overlay, startW:w, startH:hh, sx:e.clientX, sy:e.clientY }; $('#pdf-scroll').style.touchAction='none'; zoom.suspended=true; h.setPointerCapture?.(e.pointerId); }, {passive:false});
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
    if(changed) { /* keep as-is */ }
  }

  _focus(el){ el.focus(); const sel=getSelection(); const range=document.createRange(); range.selectNodeContents(el); range.collapse(false); sel.removeAllRanges(); sel.addRange(range); }
  _select(el){ refs.container.querySelectorAll('.anno').forEach(n=>n.classList.remove('selected')); this.selected=el; if(el) el.classList.add('selected'); }
  _recordAdd(overlay, el){ this.history.push({type:'add',overlay,el}); this.redoStack.length=0; }
  undo(){ const last=this.history.pop(); if(!last) return; if(last.el?.parentNode){ last.el.parentNode.removeChild(last.el); if(this.selected===last.el) this._select(null); this.redoStack.push(last);} }
  redo(){ const n=this.redoStack.pop(); if(!n) return; if(n.el){ n.overlay.appendChild(n.el); this.history.push(n);} }
}
const ann = new Annotations(refs.container);

function scrollAnnoIntoView(el){
  if (!el) return;
  const wrap = el.closest('.page-wrap'); if (!wrap) return;
  // X is centered via flex; just bring Y roughly into view
  const r = wrap.getBoundingClientRect();
  const s = refs.scroll.getBoundingClientRect();
  const y = refs.scroll.scrollTop + (r.top - s.top) - (s.height * 0.25);
  refs.scroll.scrollTo({ top: clamp(y, 0, refs.scroll.scrollHeight), behavior: 'smooth' });
}

/* ---------- PDF render ---------- */
function isValidPdfBytes(bytes){
  if (!bytes || !bytes.length) return false;
  const maxSkip = Math.min(8, bytes.length);
  for (let i=0; i<maxSkip; i++){
    if (bytes[i]===0x25 && bytes[i+1]===0x50 && bytes[i+2]===0x44 && bytes[i+3]===0x46 && bytes[i+4]===0x2D) return true; // %PDF-
  }
  return false;
}

async function renderPdfFromFile(file, scale=1){
  if (!file) { toast('No file selected','err'); return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isValidPdfBytes(bytes)){ toast('That file is not a valid PDF.','err',3600); return; }
  CURRENT_PDF.file=file; CURRENT_PDF.bytes=bytes; CURRENT_PDF.filename=file.name||'document.pdf';
  return renderPdfFromData(bytes, scale);
}

async function renderPdfFromData(bytes, scale=1){
  refs.stack.innerHTML=''; CURRENT_PDF.wraps=[]; CURRENT_PDF.vpCSSByPage=[];
  let pdf;
  try { pdf = await pdfjsLib.getDocument({ data: bytes }).promise; }
  catch(err){ console.error('getDocument failed', err); toast('Could not open PDF (engine error)','err'); throw err; }

  const ratio=Math.max(1,Math.min(2,devicePixelRatio||1));
  for(let i=1;i<=pdf.numPages;i++){
    const page=await pdf.getPage(i);
    const vpCSS=page.getViewport({scale});
    const vpDev=page.getViewport({scale:scale*ratio});
    const wrap=document.createElement('div'); wrap.className='page-wrap';
    const canvas=document.createElement('canvas'); canvas.className='pdfpage';
    canvas.width=Math.floor(vpDev.width); canvas.height=Math.floor(vpDev.height);
    canvas.style.width=vpCSS.width+'px'; canvas.style.height=vpCSS.height+'px';
    wrap.appendChild(canvas); refs.stack.appendChild(wrap);
    const ctx=canvas.getContext('2d',{alpha:false,desynchronized:true});
    await page.render({canvasContext:ctx, viewport:vpDev, intent:'display'}).promise;
    CURRENT_PDF.wraps.push(wrap); CURRENT_PDF.vpCSSByPage.push({width:vpCSS.width,height:vpCSS.height});
  }

  // Reset scale and vertically start at top; X is centered by flexbox
  zoom.scale = 1;
  refs.stack.style.transformOrigin = '0 0';
  refs.stack.style.transform = 'scale(1)';
  centerOnOpen();

  // Overlays on wraps
  ann.attachOverlays(CURRENT_PDF.wraps.map((wrap,i)=>({wrap, vpCSS:CURRENT_PDF.vpCSSByPage[i]})));

  toast('PDF loaded ✔️');
}

/* ---------- Save (unchanged) ---------- */
async function saveFlattened(){
  if (!CURRENT_PDF.bytes && !CURRENT_PDF.file){ toast('Open a PDF first','err'); return; }
  try{
    if (!isValidPdfBytes(CURRENT_PDF.bytes) && CURRENT_PDF.file){
      CURRENT_PDF.bytes = new Uint8Array(await CURRENT_PDF.file.arrayBuffer());
    }
  }catch{}

  let pdf, helv, helvB;
  try{
    pdf  = await PDFDocument.load(CURRENT_PDF.bytes);
    helv = await pdf.embedFont(StandardFonts.Helvetica);
    helvB= await pdf.embedFont(StandardFonts.HelveticaBold);
  }catch(e){ toast('Save failed: cannot read original PDF','err',3600); return; }

  const pages= pdf.getPages(); const embedOps=[];
  try{
    CURRENT_PDF.wraps.forEach((wrap, idx)=>{
      const overlay = wrap.querySelector('.overlay'); if(!overlay) return;
      const page = pages[idx]; if(!page) return;
      const pageW = page.getWidth(), pageH = page.getHeight();
      const vp = CURRENT_PDF.vpCSSByPage[idx];
      const fx = pageW / vp.width, fy = pageH / vp.height;

      overlay.querySelectorAll('.anno').forEach(el=>{
        const left=el.offsetLeft, top=el.offsetTop, w=el.offsetWidth, h=el.offsetHeight;
        const x=left*fx, y=pageH-(top+h)*fy;

        if (el.classList.contains('text')){
          const cs = getComputedStyle(el);
          const size = Math.max(8, (parseFloat(cs.fontSize)||16) * fx);
          const rgbm = cs.color.match(/\d+/g)||[0,0,0];
          const [rr,gg,bb] = rgbm.map(n=>parseInt(n,10)/255);
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
                const i = img.src.indexOf(','); const b64 = i>0 ? img.src.slice(i+1) : '';
                const bin = atob(b64); bytes=new Uint8Array(bin.length); for(let j=0;j<bytes.length;j++) bytes[j]=bin.charCodeAt(j);
              } else { const res=await fetch(img.src,{mode:'cors'}); bytes=new Uint8Array(await res.arrayBuffer()); }
              const png = await pdf.embedPng(bytes);
              page.drawImage(png, { x, y, width:w*fx, height:h*fy });
            }catch(err){ /* ignore */ }
          })();
          embedOps.push(p);
        }
      });
    });
    if (embedOps.length) await Promise.allSettled(embedOps);
    const out = await pdf.save();
    const name = (CURRENT_PDF.filename||'document').replace(/\.pdf$/i,'') + '-signed.pdf';
    await deliverBlob(new Blob([out], { type:'application/pdf' }), name);
    toast('Saved ✔️');
  }catch(e){
    toast('Could not save PDF','err',3600);
  }
}
async function deliverBlob(blob, name){
  try{
    if (navigator.canShare && navigator.canShare({ files: [new File([blob], name, {type: blob.type})] })){
      await navigator.share({ files:[new File([blob], name, {type: blob.type})] });
      return;
    }
  }catch{}
  if ('showSaveFilePicker' in window){
    try{
      const handle = await window.showSaveFilePicker({ suggestedName: name, types:[{ description:'PDF', accept:{ 'application/pdf':['.pdf'] } }] });
      const w = await handle.createWritable(); await w.write(blob); await w.close(); return;
    }catch{}
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 1500);
}

/* ---------- Signature pad ---------- */
class SigPad{
  constructor(canvas, modal){ this.canvas=canvas; this.modal=modal; this.ctx=canvas.getContext('2d'); this.clear(); this.drawing=false;
    const pos=ev=>{ const r=canvas.getBoundingClientRect(); const dpr=Math.max(1,devicePixelRatio||1); return {x:(ev.clientX-r.left)*dpr,y:(ev.clientY-r.top)*dpr}; };
    on(canvas,'pointerdown',e=>{ canvas.setPointerCapture?.(e.pointerId); this.drawing=true; const p=pos(e); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y); });
    on(canvas,'pointermove',e=>{ if(!this.drawing) return; const p=pos(e); this.ctx.lineTo(p.x,p.y); this.ctx.stroke(); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y); });
    on(canvas,'pointerup',()=>{ this.drawing=false; });
  }
  open(){ this.modal.classList.add('show'); }
  close(){ this.modal.classList.remove('show'); }
  clear(){ const dpr=Math.max(1,devicePixelRatio||1); this.canvas.width=500*dpr; this.canvas.height=200*dpr; this.canvas.style.width='500px'; this.canvas.style.height='200px';
    const c=this.ctx; c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,this.canvas.width,this.canvas.height); c.lineWidth=2.5*dpr; c.strokeStyle='#000'; c.lineCap='round'; c.lineJoin='round'; }
  dataURL(){ return this.canvas.toDataURL('image/png'); }
}
const sig = new SigPad(refs.sigPad, refs.sigModal);
class SigController{ constructor(sig,ann){ this.sig=sig; this.ann=ann; } open(){ this.sig.open(); } close(){ this.sig.close(); } use(){ LAST_SIG_DATAURL=this.sig.dataURL(); this.close(); this.ann.setMode('sign'); toast('Signature ready — double‑tap/click to place'); } }
const sigCtl = new SigController(sig, ann);
refs.sigModal?.classList.remove('show');

/* ---------- Toolbar wiring ---------- */
function wireUI(){
  on(refs.openBtn,'click',()=>{ try{ if (refs.fileInput.showPicker) refs.fileInput.showPicker(); else refs.fileInput.click(); }catch{} });
  on(refs.fileInput,'change',async e=>{
    const file=e.target.files?.[0]; if(!file) return;
    try { await renderPdfFromFile(file, 1); }
    catch(err){ console.error(err); toast('Could not open PDF','err'); }
  });

  on(refs.textBtn,'click',()=>{ ann.setMode(ann.mode==='text'?null:'text'); refs.textBtn.setAttribute('aria-pressed', ann.mode==='text' ? 'true' : 'false'); toast(ann.mode?(isTouch?'Text: double‑tap':'Text: double‑click'):'Tool off'); });
  on(refs.stampBtn,'click',()=>{ ann.setMode(ann.mode==='stamp'?null:'stamp'); refs.stampBtn.setAttribute('aria-pressed', ann.mode==='stamp' ? 'true' : 'false'); toast(ann.mode?'Stamp: tap/click':'Tool off'); });
  on(refs.signBtn,'click', ()=> { sigCtl.open(); refs.signBtn.classList.add('active'); refs.signBtn.setAttribute('aria-pressed','true'); });
  on(refs.undoBtn,'click',()=>ann.undo());
  on(refs.redoBtn,'click',()=>ann.redo());
  on(refs.helpBtn,'click',()=>toast('📂 Open → double‑tap Text/Signature (draw first) → Save. Drag to move.','ok',4200));
  on(refs.saveBtn,'click',saveFlattened);

  // keep centered horizontally on resize; Y is left alone
  on(window,'resize',()=>{ refs.scroll.scrollLeft = 0; });
  on(window,'orientationchange',()=>{ refs.scroll.scrollLeft = 0; });
}
wireUI();

/* ---------- benign rejections ---------- */
addEventListener('unhandledrejection',ev=>{ const m=String(ev.reason?.message||ev.reason||''); if(m.includes('Rendering cancelled')||m.includes('AbortError')) ev.preventDefault(); });