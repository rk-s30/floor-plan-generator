/* =====================================================
   Floor Plan Generator — Editor Core (Phase 2)
   - Drag-to-draw rooms
   - Wall line drawing
   - Room label + tatami editing
   - Linked rect + IText (no Groups → stable resize)
   - Robust undo/redo
   - Zoom / pan
   ===================================================== */

'use strict';

// -------------------------------------------------------
// Constants
// -------------------------------------------------------
const GRID_SIZE       = 20;
const GRID_MM         = 455;   // 1グリッド = 455mm（半間）
const TATAMI_SQM      = 1.62;  // 1畳 = 1.62㎡（公団畳基準）
const ZOOM_STEP       = 0.1;
const ZOOM_MIN        = 0.2;
const ZOOM_MAX        = 4.0;
const GRID_COLOR      = '#c8c4bc';
const GRID_COLOR_MAJOR= '#aeaaa0';
const MIN_ROOM_SIZE   = GRID_SIZE * 2;  // 40px minimum
const WALL_WIDTH      = 6;             // default stroke width for walls and rooms
const FURNITURE_TOOLS = new Set(['toilet','bathtub','sink','refrigerator','washer','stove']);
const ROOM_TOOLS      = new Set(['room','cl-room','poly','wet-room']);

// Fixed room widths for wet rooms (furniture fills this width)
const WET_ROOM_W = {
  toilet:  3 * GRID_SIZE,   // 60px = ~3グリッド ≒ 1365mm（トイレ室）
  bathtub: 4 * GRID_SIZE,   // 80px = ~4グリッド ≒ 1820mm（浴室）
  sink:    4 * GRID_SIZE,   // 80px = ~4グリッド ≒ 1820mm（洗面所）
};

// -------------------------------------------------------
// State
// -------------------------------------------------------
let currentTool  = 'select';
let wetRoomType  = 'toilet';   // active wet-room subtype
let snapEnabled  = true;
let gridVisible  = true;
let undoStack    = [];
let redoStack    = [];
let historyPaused= false;
let uidCounter   = 0;
let isDirty      = false;

// Drawing state (drag-to-draw)
const draw = { active: false, preview: null, startPt: null, furPreview: null,
               wallRef: null, wallP1: null, wallP2: null, winT1: 0, winT2: 0 };

// Wall multi-segment state
const wall = { points: [], preview: null, activeLine: null };

// -------------------------------------------------------
// Canvas init
// -------------------------------------------------------
const canvasWrap = document.getElementById('canvas-wrap');

const canvas = new fabric.Canvas('floor-plan-canvas', {
  backgroundColor: '#faf9f7',
  selection: true,
  preserveObjectStacking: true,
  stopContextMenu: true,
  fireRightClick: true,
});

// グリッド用 canvas を Fabric の upper canvas の直前に挿入
// → lower canvas より前面・upper canvas（選択ハンドル）より背面になる
const gridCanvas = document.createElement('canvas');
gridCanvas.id = 'grid-canvas';
gridCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
canvas.wrapperEl.insertBefore(gridCanvas, canvas.upperCanvasEl);
const gridCtx = gridCanvas.getContext('2d');

function fitCanvas() {
  canvas.setWidth(canvasWrap.clientWidth);
  canvas.setHeight(canvasWrap.clientHeight);
  canvas.renderAll();
}
fitCanvas();
window.addEventListener('resize', () => { fitCanvas(); drawGrid(); });

// -------------------------------------------------------
// UID generator
// -------------------------------------------------------
function uid() { return `obj_${++uidCounter}_${Date.now()}`; }

// -------------------------------------------------------
// Grid — drawn on a separate overlay <canvas> so Fabric never touches it
// -------------------------------------------------------
function drawGrid() {
  const w = canvas.getWidth();
  const h = canvas.getHeight();
  gridCanvas.width  = w;
  gridCanvas.height = h;
  gridCtx.clearRect(0, 0, w, h);
  if (!gridVisible) return;

  const zoom = canvas.getZoom();
  const vpt  = canvas.viewportTransform;
  const left = -vpt[4] / zoom;
  const top  = -vpt[5] / zoom;
  const startX = Math.floor(left / GRID_SIZE) * GRID_SIZE;
  const startY = Math.floor(top  / GRID_SIZE) * GRID_SIZE;
  const endX   = startX + w / zoom + GRID_SIZE;
  const endY   = startY + h / zoom + GRID_SIZE;

  gridCtx.save();
  gridCtx.setTransform(zoom, 0, 0, zoom, vpt[4], vpt[5]);

  for (let x = startX; x <= endX; x += GRID_SIZE) {
    const major = (x / GRID_SIZE) % 5 === 0;
    gridCtx.beginPath();
    gridCtx.strokeStyle = major ? GRID_COLOR_MAJOR : GRID_COLOR;
    gridCtx.lineWidth   = (major ? 0.8 : 0.5) / zoom;
    gridCtx.moveTo(x, startY);
    gridCtx.lineTo(x, endY);
    gridCtx.stroke();
  }
  for (let y = startY; y <= endY; y += GRID_SIZE) {
    const major = (y / GRID_SIZE) % 5 === 0;
    gridCtx.beginPath();
    gridCtx.strokeStyle = major ? GRID_COLOR_MAJOR : GRID_COLOR;
    gridCtx.lineWidth   = (major ? 0.8 : 0.5) / zoom;
    gridCtx.moveTo(startX, y);
    gridCtx.lineTo(endX, y);
    gridCtx.stroke();
  }
  gridCtx.restore();
}

drawGrid();
// 初期状態をスタックに積んでおく（最初のUndoが空キャンバスに戻れるように）
undoStack.push(captureState());
updateObjectCount();

// ファイル名の初期値を「間取り図_YYYYMMDD」に設定
(function initFilename() {
  const d    = new Date();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  document.getElementById('filename-input').value = `間取り図_${yyyy}${mm}${dd}`;
})();

// -------------------------------------------------------
// Snap helpers
// -------------------------------------------------------
function snap(v) { return Math.round(v / GRID_SIZE) * GRID_SIZE; }

function getPointer(e) {
  const pt = canvas.getPointer(e.e);
  if (snapEnabled) return { x: snap(pt.x), y: snap(pt.y) };
  return pt;
}

// -------------------------------------------------------
// History
// -------------------------------------------------------
function captureState() {
  // Serialize only non-grid objects
  const objects = canvas.getObjects().filter(o => !o._isGrid && !o._isPreview);
  return JSON.stringify(canvas.toJSON(['data', '_uid', '_linkedLabelId', '_linkedRectId', '_isGrid', '_wetFurnitureId', '_wetFurnitureOffset', '_wetFurnitureInitAngle', '_wetFurnitureType']));
}

function saveHistory() {
  if (historyPaused) return;
  undoStack.push(captureState());
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  isDirty = true;
  syncUndoButtons();
}

function loadState(jsonStr) {
  historyPaused = true;
  canvas.loadFromJSON(JSON.parse(jsonStr), () => {
    historyPaused = false;
    // Restore non-selectable state for wet room furniture
    canvas.getObjects().forEach(o => {
      if (o.data?.isWetFurniture) {
        o.selectable = false;
        o.evented    = false;
      }
    });
    drawGrid();
    updateObjectCount();
    clearPropsPanel();
    canvas.renderAll();
    syncUndoButtons();
  });
}

function undo() {
  if (undoStack.length <= 1) return;      // 初期状態より前には戻れない
  redoStack.push(undoStack.pop());        // 現在の状態をredoへ
  loadState(undoStack[undoStack.length - 1]); // 1つ前の状態を読む（popしない）
}

function redo() {
  if (!redoStack.length) return;
  const next = redoStack.pop();
  undoStack.push(next);
  loadState(next);
}

function syncUndoButtons() {
  document.getElementById('btn-undo').disabled = undoStack.length <= 1;
  document.getElementById('btn-redo').disabled = redoStack.length === 0;
}

// object:modified は後述の統合ハンドラで一元管理するためここでは登録しない

// -------------------------------------------------------
// Object count
// -------------------------------------------------------
function updateObjectCount() {
  const n = canvas.getObjects().filter(o => !o._isGrid && !o._isPreview).length;
  document.getElementById('status-objects').textContent = `オブジェクト: ${n}`;
  updateWelcomeOverlay(n);
}

// -------------------------------------------------------
// Mouse position
// -------------------------------------------------------
canvas.on('mouse:move', (e) => {
  const pt = canvas.getPointer(e.e);
  document.getElementById('status-pos').innerHTML =
    `X: ${Math.round(pt.x)} &nbsp; Y: ${Math.round(pt.y)}`;
});

// -------------------------------------------------------
// Tool management
// -------------------------------------------------------
const TOOL_LABELS = {
  select: '選択', room: '部屋', poly: '多角形',
  indent: '削る', protrude: '出す',
  wall: '壁', door: 'ドア', window: '窓', stairs: '階段', text: 'テキスト',
  toilet: 'トイレ', bathtub: 'バスタブ', sink: '流し台',
  refrigerator: '冷蔵庫', washer: '洗濯機', stove: 'コンロ',
};

function setTool(name) {
  // Cancel any active drawing
  cancelDrawing();
  cancelWall();
  cancelPolyDraw();
  cancelModifyDraw();
  cancelDoorDraw();

  currentTool = name;

  document.querySelectorAll('.tool-btn[data-tool]').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === name);
  });
  // パネル系ボタンのアクティブ状態
  const btnRoomOpen = document.getElementById('tool-room-open');
  if (btnRoomOpen) btnRoomOpen.classList.toggle('active', ROOM_TOOLS.has(name));
  const btnFurnitureOpen = document.getElementById('tool-furniture-open');
  if (btnFurnitureOpen) btnFurnitureOpen.classList.toggle('active', FURNITURE_TOOLS.has(name));
  const btnDoorOpen = document.getElementById('tool-door-open');
  if (btnDoorOpen) btnDoorOpen.classList.toggle('active', name === 'door');

  const isSelect = name === 'select';
  canvas.isDrawingMode = false;
  canvas.selection     = isSelect;
  canvas.defaultCursor = isSelect ? 'default'    : 'crosshair';
  canvas.hoverCursor   = isSelect ? 'move'       : 'crosshair';

  // 描画ツール中は既存オブジェクトを操作不可にして誤移動を防ぐ
  canvas.getObjects().forEach(obj => {
    if (obj._isGrid || obj._isPreview) return;
    obj.selectable = isSelect;
    obj.evented    = isSelect;
  });
  if (!isSelect) canvas.discardActiveObject();
  canvas.renderAll();

  document.getElementById('status-tool').textContent =
    `ツール: ${TOOL_LABELS[name] || name}`;
  document.getElementById('canvas-hint').style.display =
    isSelect ? 'block' : 'none';

  // ステータスバーにヒントを表示
  const TOOL_HINTS = {
    select:     '',
    room:       'ドラッグで部屋を描く',
    'cl-room':  'ドラッグでCL（クローゼット）を描く',
    poly:       'クリックで頂点を追加 / 最初の点をクリックまたは Enter で確定 / Esc でキャンセル',
    wall:       'クリックで壁の始点・終点を指定 / Esc でキャンセル',
    door:       '壁上の1点目をクリック → 2点目をクリック → マウスで向きを確認して3クリック目で配置 / Esc でキャンセル',
    indent:     '壁をクリック(起点) → 自由点を任意個クリック → 壁をクリック(終点)で確定 / Esc でキャンセル',
    protrude:   '壁をクリック(起点) → 自由点を任意個クリック → 壁をクリック(終点)で確定 / Esc でキャンセル',
    window:     '壁の上をドラッグして窓を挿入',
    stairs:     'クリックで配置 / [ ] で回転',
    text:       'クリックでテキストを配置 / ダブルクリックで編集',
    'wet-room':  'ドラッグで水回り部屋を描く',
    toilet:     'クリックで配置 / [ ] で回転',
    bathtub:    'クリックで配置 / [ ] で回転',
    sink:       'クリックで配置 / [ ] で回転',
    refrigerator: 'クリックで配置 / [ ] で回転',
    washer:     'クリックで配置 / [ ] で回転',
    stove:      'クリックで配置 / [ ] で回転',
  };
  const hint    = TOOL_HINTS[name] || '';
  const $hint   = document.getElementById('status-hint');
  const $hintSep= document.getElementById('status-hint-sep');
  $hint.textContent       = hint;
  $hintSep.style.display  = hint ? '' : 'none';
}


document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

// パネル共通：固定位置で表示、他パネルをすべて閉じる
const ALL_PANELS = ['room-panel', 'furniture-panel', 'door-panel'];
function _openPanel(panel, triggerBtn) {
  ALL_PANELS.forEach(id => {
    const el = document.getElementById(id);
    if (el && el !== panel) el.style.display = 'none';
  });
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
  const r = triggerBtn.getBoundingClientRect();
  panel.style.left = (r.right + 6) + 'px';
  panel.style.top  = r.top + 'px';
  panel.style.display = 'block';
}

// 部屋パネルの開閉
(function () {
  const panel  = document.getElementById('room-panel');
  const btnOpen = document.getElementById('tool-room-open');

  btnOpen.addEventListener('click', (e) => {
    e.stopPropagation();
    _openPanel(panel, btnOpen);
  });

  // 普通の部屋・多角形
  panel.querySelectorAll('[data-tool]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.style.display = 'none';
      setTool(item.dataset.tool);
    });
  });

  // 水回り部屋
  panel.querySelectorAll('[data-wet]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      wetRoomType = item.dataset.wet;
      panel.style.display = 'none';
      setTool('wet-room');
    });
  });

  document.addEventListener('click', () => { panel.style.display = 'none'; });
})();

// 家具パネルの開閉
(function () {
  const panel  = document.getElementById('furniture-panel');
  const btnOpen = document.getElementById('tool-furniture-open');

  btnOpen.addEventListener('click', (e) => {
    e.stopPropagation();
    _openPanel(panel, btnOpen);
  });

  panel.querySelectorAll('.furniture-item[data-tool]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.style.display = 'none';
      setTool(item.dataset.tool);
    });
  });

  document.addEventListener('click', () => { panel.style.display = 'none'; });
})();

// ドアパネルの開閉
(function () {
  const panel   = document.getElementById('door-panel');
  const btnOpen = document.getElementById('tool-door-open');

  btnOpen.addEventListener('click', (e) => {
    e.stopPropagation();
    _openPanel(panel, btnOpen);
  });

  panel.querySelectorAll('.furniture-item[data-tool]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.style.display = 'none';
      if (item.dataset.doorSubtype) doorSubtype = item.dataset.doorSubtype;
      setTool(item.dataset.tool);
    });
  });

  document.addEventListener('click', () => { panel.style.display = 'none'; });
})();

// -------------------------------------------------------
// Room — drag to draw
// -------------------------------------------------------
function startRoomDraw(pt) {
  draw.startPt = pt;
  draw.preview = new fabric.Rect({
    left: pt.x, top: pt.y, width: 1, height: 1,
    fill: 'rgba(255,255,255,0.6)',
    stroke: '#d97706', strokeWidth: 2,
    strokeDashArray: [6, 4],
    selectable: false, evented: false,
    _isPreview: true,
  });
  canvas.add(draw.preview);
  draw.active = true;
}

function updateRoomDraw(pt) {
  if (!draw.active || !draw.preview) return;
  const x = Math.min(draw.startPt.x, pt.x);
  const y = Math.min(draw.startPt.y, pt.y);
  const w = Math.abs(pt.x - draw.startPt.x);
  const h = Math.abs(pt.y - draw.startPt.y);
  draw.preview.set({ left: x, top: y, width: Math.max(w, 1), height: Math.max(h, 1) });
  canvas.renderAll();
  showDrawDimTooltip(pt, w, h);
}

function showDrawDimTooltip(pt, wPx, hPx) {
  const tip = document.getElementById('draw-dim-tooltip');
  if (!tip) return;
  const wM = (wPx / GRID_SIZE * GRID_MM / 1000);
  const hM = (hPx / GRID_SIZE * GRID_MM / 1000);
  const sqm = wM * hM;
  const tatami = sqm / TATAMI_SQM;
  const sqmStr    = sqm.toFixed(1);
  const tatamiStr = tatami.toFixed(1);
  tip.textContent = `${tatamiStr}畳 ≈ ${sqmStr}㎡`;

  // キャンバス要素の画面座標を基準に絶対配置
  const canvasEl = document.getElementById('floor-plan-canvas');
  const rect = canvasEl.getBoundingClientRect();
  const zoom = canvas.getZoom();
  const vpt  = canvas.viewportTransform;
  const screenX = pt.x * zoom + vpt[4] + rect.left;
  const screenY = pt.y * zoom + vpt[5] + rect.top;
  const wrap    = document.getElementById('canvas-wrap');
  const wrapRect = wrap.getBoundingClientRect();

  tip.style.left    = `${screenX - wrapRect.left + 12}px`;
  tip.style.top     = `${screenY - wrapRect.top  + 12}px`;
  tip.style.display = 'block';
}

function hideDrawDimTooltip() {
  const tip = document.getElementById('draw-dim-tooltip');
  if (tip) tip.style.display = 'none';
}

function finishRoomDraw(pt) {
  if (!draw.active) return;
  const x = Math.min(draw.startPt.x, pt.x);
  const y = Math.min(draw.startPt.y, pt.y);
  const w = Math.abs(pt.x - draw.startPt.x);
  const h = Math.abs(pt.y - draw.startPt.y);

  hideDrawDimTooltip();
  canvas.remove(draw.preview);
  draw.active  = false;
  draw.preview = null;
  draw.startPt = null;

  if (w < MIN_ROOM_SIZE || h < MIN_ROOM_SIZE) return;

  const label = currentTool === 'cl-room' ? 'CL' : '部屋';
  addRoom(x, y, w, h, label);
  saveHistory();
}

// -------------------------------------------------------
// Wet room — drag to draw
// Width is fixed per type; user drags to set depth only.
// -------------------------------------------------------
// 家具プレビューの位置・スケール・角度を計算して適用する
function _applyFurPreview(fur, type, roomX, roomY, w, h) {
  const NAT_SIZE = { toilet: [40, 80], bathtub: [80, 120], sink: [80, 60] };
  const pad = WALL_WIDTH + 4;
  const availW = w - pad * 2, availH = h - pad * 2;
  if (availW <= 0 || availH <= 0) return;

  const [natW, natH] = NAT_SIZE[type];
  const isLandscape  = w >= h;
  let scaleX, scaleY, visualW, visualH;

  if (type === 'toilet') {
    const ASPECT = natW * 1.5 / natH;
    if (!isLandscape) {
      scaleX = Math.min(Math.sqrt(availW * availH / 4.5), availW) / natW;
      scaleY = Math.min(scaleX * ASPECT, availH / natH);
      if (scaleY < scaleX * ASPECT) scaleX = scaleY / ASPECT;
    } else {
      scaleX = Math.min(Math.sqrt(availW * availH / 4.5), availH) / natW;
      scaleY = Math.min(scaleX * ASPECT, availW / natH);
      if (scaleY < scaleX * ASPECT) scaleX = scaleY / ASPECT;
    }
    if (!isLandscape) { visualW = natW * scaleX; visualH = natH * scaleY; }
    else              { visualW = natH * scaleY; visualH = natW * scaleX; }
  } else if (type === 'bathtub') {
    const sBase = Math.sqrt(availW * availH * 0.60 / (natW * natH));
    if (!isLandscape) {
      const s = Math.min(sBase, availW / natH, availH / natW);
      scaleX = scaleY = s; visualW = natH * s; visualH = natW * s;
    } else {
      const s = Math.min(sBase, availW / natW, availH / natH);
      scaleX = scaleY = s; visualW = natW * s; visualH = natH * s;
    }
  } else {
    const sBase = Math.sqrt(availW * availH * 0.30 / (natW * natH));
    if (!isLandscape) {
      const s = Math.min(sBase, availW / natW, availH / natH);
      scaleX = scaleY = s; visualW = natW * s; visualH = natH * s;
    } else {
      const s = Math.min(sBase, availW / natH, availH / natW);
      scaleX = scaleY = s; visualW = natH * s; visualH = natW * s;
    }
  }

  const furAngle  = type === 'bathtub'
    ? (isLandscape ? 180 : 90)
    : (isLandscape ? 90 : (type === 'toilet' ? 180 : 0));
  const cxCanvas  = roomX + (!isLandscape ? w / 2 : w - visualW / 2 - pad);
  const cyCanvas  = roomY + (!isLandscape ? h - visualH / 2 - pad : h / 2);

  fur.set({ left: cxCanvas, top: cyCanvas, scaleX, scaleY, angle: furAngle });
  fur.setCoords();
}

function startWetRoomDraw(pt) {
  startRoomDraw(pt);
  // 家具プレビューを生成（canvas には追加済み・選択不可）
  const ADD_FN = { toilet: addToilet, bathtub: addBathtub, sink: addSink };
  historyPaused = true;
  ADD_FN[wetRoomType](0, 0);
  historyPaused = false;
  const fur = canvas.getActiveObject();
  if (fur) {
    fur.set({
      selectable: false, evented: false,
      originX: 'center', originY: 'center',
      opacity: 0.55,
      _isPreview: true,
    });
    draw.furPreview = fur;
  }
  canvas.discardActiveObject();
}

function updateWetRoomDraw(pt) {
  if (!draw.active || !draw.preview) return;
  const x = Math.min(draw.startPt.x, pt.x);
  const y = Math.min(draw.startPt.y, pt.y);
  const w = Math.abs(pt.x - draw.startPt.x);
  const h = Math.abs(pt.y - draw.startPt.y);
  draw.preview.set({ left: x, top: y, width: Math.max(w, 1), height: Math.max(h, 1) });
  if (draw.furPreview && w >= MIN_ROOM_SIZE && h >= MIN_ROOM_SIZE) {
    _applyFurPreview(draw.furPreview, wetRoomType, x, y, w, h);
  }
  canvas.renderAll();
  showDrawDimTooltip(pt, w, h);
}

function finishWetRoomDraw(pt) {
  if (!draw.active) return;
  const x = Math.min(draw.startPt.x, pt.x);
  const y = Math.min(draw.startPt.y, pt.y);
  const w = Math.abs(pt.x - draw.startPt.x);
  const h = Math.abs(pt.y - draw.startPt.y);

  canvas.remove(draw.preview);
  if (draw.furPreview) { canvas.remove(draw.furPreview); draw.furPreview = null; }
  draw.active  = false;
  draw.preview = null;
  draw.startPt = null;

  if (w < MIN_ROOM_SIZE || h < MIN_ROOM_SIZE) return;

  addWetRoom(x, y, w, h, wetRoomType);
  setTool('select');
  saveHistory();
}

function addWetRoom(x, y, w, h, type) {
  const LABELS = { toilet: 'トイレ', bathtub: '浴室', sink: '洗面所' };
  const ADD_FN = { toilet: addToilet, bathtub: addBathtub, sink: addSink };

  historyPaused = true;
  const rect = addRoom(x, y, w, h, LABELS[type], '');
  historyPaused = false;

  historyPaused = true;
  ADD_FN[type](0, 0);
  historyPaused = false;

  const furniture = canvas.getActiveObject();
  if (furniture) {
    furniture.set({ selectable: false, evented: false, originX: 'center', originY: 'center' });
    furniture.data = { ...furniture.data, isWetFurniture: true };
    rect._wetFurnitureId   = furniture._uid;
    rect._wetFurnitureType = type;
    recalcWetFurniture(rect);  // syncLabel も内部で呼ばれる
    canvas.setActiveObject(rect);
    canvas.renderAll();
  }
}

// 部屋サイズに合わせて家具スケール・位置・角度を再計算する
function recalcWetFurniture(rectObj) {
  if (!rectObj._wetFurnitureId || !rectObj._wetFurnitureType) return;
  const fur = canvas.getObjects().find(o => o._uid === rectObj._wetFurnitureId);
  if (!fur) return;

  const type = rectObj._wetFurnitureType;
  const w    = rectObj.getScaledWidth();
  const h    = rectObj.getScaledHeight();
  const NAT_SIZE = { toilet: [40, 80], bathtub: [80, 120], sink: [80, 60] };
  const pad  = WALL_WIDTH + 4;
  const availW = w - pad * 2;
  const availH = h - pad * 2;
  if (availW <= 0 || availH <= 0) return;

  const [natW, natH] = NAT_SIZE[type];
  const isLandscape  = w >= h;
  let scaleX, scaleY, visualW, visualH;

  if (type === 'toilet') {
    const ASPECT = natW * 1.5 / natH;
    if (!isLandscape) {
      scaleX = Math.min(Math.sqrt(availW * availH / 4.5), availW) / natW;
      scaleY = Math.min(scaleX * ASPECT, availH / natH);
      if (scaleY < scaleX * ASPECT) scaleX = scaleY / ASPECT;
    } else {
      scaleX = Math.min(Math.sqrt(availW * availH / 4.5), availH) / natW;
      scaleY = Math.min(scaleX * ASPECT, availW / natH);
      if (scaleY < scaleX * ASPECT) scaleX = scaleY / ASPECT;
    }
  } else if (type === 'bathtub') {
    const sBase = Math.sqrt(availW * availH * 0.60 / (natW * natH));
    if (!isLandscape) {
      const s = Math.min(sBase, availW / natH, availH / natW);
      scaleX = scaleY = s; visualW = natH * s; visualH = natW * s;
    } else {
      const s = Math.min(sBase, availW / natW, availH / natH);
      scaleX = scaleY = s; visualW = natW * s; visualH = natH * s;
    }
  } else {
    // 洗面所：部屋面積の約30%（縦長=0°、横長=90°回転）
    const sBase = Math.sqrt(availW * availH * 0.30 / (natW * natH));
    if (!isLandscape) {
      scaleX = scaleY = Math.min(sBase, availW / natW, availH / natH);
    } else {
      scaleX = scaleY = Math.min(sBase, availW / natH, availH / natW);
    }
  }

  if (type !== 'bathtub') {
    if (!isLandscape) { visualW = natW * scaleX; visualH = natH * scaleY; }
    else              { visualW = natH * scaleY; visualH = natW * scaleX; }
  }

  const furAngle = type === 'bathtub'
    ? (isLandscape ? 180 : 90)
    : (isLandscape ? 90 : (type === 'toilet' ? 180 : 0));

  // 部屋中心からの相対オフセット（ローカル座標）を更新
  const cxLocal = !isLandscape ? w / 2 : w - visualW / 2 - pad;
  const cyLocal = !isLandscape ? h - visualH / 2 - pad : h / 2;
  rectObj._wetFurnitureOffset    = { dx: cxLocal - w / 2, dy: cyLocal - h / 2 };
  rectObj._wetFurnitureInitAngle = furAngle;

  fur.set({ scaleX, scaleY });
  fur.setCoords();
  syncWetFurniture(rectObj);
  syncLabel(rectObj);
}

function cancelDrawing() {
  hideDrawDimTooltip();
  if (draw.preview)    { canvas.remove(draw.preview); }
  if (draw.furPreview) { canvas.remove(draw.furPreview); draw.furPreview = null; }
  canvas.renderAll();
  draw.active      = false;
  draw.preview     = null;
  draw.startPt     = null;
  draw.wallRef     = null;
  draw.wallSource  = null;
}

// -------------------------------------------------------
// Room object: Rect + IText (linked, not grouped)
// -------------------------------------------------------
function addRoom(x, y, w, h, labelText = '部屋', tatamiText = '') {
  const id = uid();

  const rect = new fabric.Rect({
    left: x, top: y, width: w, height: h,
    fill: '#ffffff', stroke: '#1a1a1a', strokeWidth: WALL_WIDTH,
    strokeUniform: true, lockScalingFlip: true,
    data: { type: 'room', label: labelText, tatami: tatamiText },
    _uid: id, _linkedLabelId: id + '_lbl',
  });

  const displayText = buildRoomLabel(labelText, tatamiText);
  const label = new fabric.IText(displayText, {
    left:       x + w / 2,
    top:        y + h / 2,
    originX:    'center',
    originY:    'center',
    fontSize:   fitLabelFontSize(rect, displayText),
    fontFamily: 'Inter, sans-serif',
    fill:       '#1a1a1a',
    textAlign:  'center',
    editable:   true,
    lockScalingFlip: true,
    padding:    10,
    data: { type: 'room-label', linkedRectId: id },
    _uid: id + '_lbl', _linkedRectId: id,
  });

  canvas.add(rect);
  canvas.add(label);
  updateObjectCount();
  canvas.setActiveObject(rect);
  canvas.renderAll();
  return rect;
}

function buildRoomLabel(name, tatami) {
  if (!name && !tatami) return '';
  if (!tatami) return name;
  return `${name}\n${tatami}`;
}

// Auto-calculate font size to fit text inside rectObj.
// Returns rectObj.data.labelFontSize if user has set a manual override.
function fitLabelFontSize(rectObj, text) {
  if (rectObj.data?.labelFontSize) return rectObj.data.labelFontSize;
  if (!text) return 13;
  const availW = rectObj.getScaledWidth()  - 12;
  const availH = rectObj.getScaledHeight() - 12;
  if (availW <= 0 || availH <= 0) return 7;

  const lines = text.split('\n');
  const lineCount = lines.length;

  // CJK chars ≈ fontSize px wide, ASCII/digits ≈ 0.6 × fontSize
  function lineWidth(fs, str) {
    let w = 0;
    for (const ch of str) {
      w += /[\u3000-\u9FFF\uFF00-\uFFEF]/.test(ch) ? fs : fs * 0.6;
    }
    return w;
  }

  for (let fs = 13; fs >= 7; fs--) {
    const maxW   = Math.max(...lines.map(l => lineWidth(fs, l)));
    const totalH = lineCount * fs * 1.4;
    if (maxW <= availW && totalH <= availH) return fs;
  }
  return 7;
}

// Keep label centered on rect during move/scale/rotate
// getCenterPoint() is rotation-aware and always returns the visual center
function syncLabel(rectObj) {
  if (!rectObj._linkedLabelId) return;
  const lbl = canvas.getObjects().find(o => o._uid === rectObj._linkedLabelId);
  if (!lbl) return;

  const center = rectObj.getCenterPoint();
  const fs = fitLabelFontSize(rectObj, lbl.text);

  if (rectObj._wetFurnitureOffset && rectObj._wetFurnitureId) {
    // 水回り部屋：家具の実際のサイズから空き領域を算出してラベルを配置
    const w = rectObj.getScaledWidth();
    const h = rectObj.getScaledHeight();
    const isLandscape = w >= h;
    const { dx, dy } = rectObj._wetFurnitureOffset;

    // 家具の視覚サイズ（部屋ローカル軸で見た半分）を取得
    const fur = canvas.getObjects().find(o => o._uid === rectObj._wetFurnitureId);
    let furHalfH = 20, furHalfW = 20;
    if (fur) {
      const relAngle = ((fur.angle - (rectObj.angle || 0)) % 360 + 360) % 360;
      const swapped  = relAngle === 90 || relAngle === 270;
      furHalfH = (swapped ? fur.getScaledWidth()  : fur.getScaledHeight()) / 2;
      furHalfW = (swapped ? fur.getScaledHeight() : fur.getScaledWidth())  / 2;
    }

    let dxLocal, dyLocal;
    if (!isLandscape) {
      // 家具は下側：空き領域は (0 〜 家具上端)
      const furTopLocal  = h / 2 + dy - furHalfH;   // 部屋中央基準で家具上端
      dyLocal = furTopLocal / 2 - h / 2;             // 空き領域中央 → center 基準
      dxLocal = 0;
    } else {
      // 家具は右側：空き領域は (0 〜 家具左端)
      const furLeftLocal = w / 2 + dx - furHalfW;
      dxLocal = furLeftLocal / 2 - w / 2;
      dyLocal = 0;
    }

    const rad = fabric.util.degreesToRadians(rectObj.angle || 0);
    const cos = Math.cos(rad), sin = Math.sin(rad);
    lbl.set({
      left:     center.x + cos * dxLocal - sin * dyLocal,
      top:      center.y + sin * dxLocal + cos * dyLocal,
      fontSize: fs,
    });
    canvas.bringToFront(lbl);
  } else {
    lbl.set({ left: center.x, top: center.y, fontSize: fs });
    canvas.bringToFront(lbl);
  }
  canvas.renderAll();
}

// Keep wet room furniture linked to its room rect
function syncWetFurniture(rectObj) {
  if (!rectObj._wetFurnitureId) return;
  const fur = canvas.getObjects().find(o => o._uid === rectObj._wetFurnitureId);
  if (!fur) return;
  const { dx, dy } = rectObj._wetFurnitureOffset;
  const center = rectObj.getCenterPoint();
  const rad = fabric.util.degreesToRadians(rectObj.angle || 0);
  const cos = Math.cos(rad), sin = Math.sin(rad);
  fur.set({
    left:  center.x + cos * dx - sin * dy,
    top:   center.y + sin * dx + cos * dy,
    angle: (rectObj._wetFurnitureInitAngle || 0) + (rectObj.angle || 0),
  });
  fur.setCoords();
}

// -------------------------------------------------------
// Rotation snap — Fabric.js 組み込み snapAngle を使用
// ハードスナップより滑らか（ snapThreshold 内に入ったときだけスナップ）
// -------------------------------------------------------
const SNAP90_TYPES = new Set(['room', 'wall', 'door', 'window', 'stairs', 'toilet', 'bathtub', 'sink', 'refrigerator', 'washer', 'stove']);

function applyRotationSnapSetting(obj) {
  if (!obj) { canvas.snapAngle = 0; return; }
  const type = obj.data?.type || obj.type;
  if (SNAP90_TYPES.has(type)) {
    canvas.snapAngle     = 90;
    canvas.snapThreshold = 12; // ±12° 以内でスナップ
  } else {
    canvas.snapAngle     = 0;
    canvas.snapThreshold = 0;
  }
}

canvas.on('selection:created', (e) => applyRotationSnapSetting(e.selected?.[0]));
canvas.on('selection:updated', (e) => applyRotationSnapSetting(e.selected?.[0]));
canvas.on('selection:cleared', ()  => applyRotationSnapSetting(null));

// -------------------------------------------------------
// Move / Scale / Modify handlers
// スナップはマウスアップ後（object:modified）のみ適用して
// ドラッグ中のジャンプを防ぐ
// -------------------------------------------------------

// ドラッグ中：ラベル同期のみ（スナップはしない）
canvas.on('object:moving', (e) => {
  if (e.target.data?.type === 'room') { syncLabel(e.target); syncWetFurniture(e.target); }
});

// スケール中：ラベル同期のみ（スナップはしない）
// ※スケール途中に scaleX/Y を書き換えると Fabric.js の内部状態と衝突し
//   オブジェクトが飛ぶため、修正は mouse:up 後の object:modified で行う
canvas.on('object:scaling', (e) => {
  if (e.target.data?.type === 'room') { syncLabel(e.target); syncWetFurniture(e.target); }
});

// 回転中：ラベル同段のみ（角度スナップは canvas.snapAngle に委譲）
canvas.on('object:rotating', (e) => {
  if (e.target.data?.type === 'room') { syncLabel(e.target); syncWetFurniture(e.target); }
});

// マウスアップ後：スナップ・ラベル同期・履歴保存・パネル更新を一括処理
canvas.on('object:modified', (e) => {
  const obj = e.target;
  if (!obj || obj._isGrid) return;

  if (snapEnabled && !obj.data?.snapDisabled) {
    // 位置スナップ（窓は壁上に固定されるのでスキップ）
    if (obj.data?.type !== 'window') {
      obj.set({
        left: snap(obj.left),
        top:  snap(obj.top),
      });
    }

    // サイズスナップ（Line・テキスト・窓以外）
    if (obj.type !== 'line' && obj.type !== 'i-text' && obj.type !== 'text'
        && obj.data?.type !== 'window') {
      const snappedW = Math.max(snap(obj.getScaledWidth()),  MIN_ROOM_SIZE);
      const snappedH = Math.max(snap(obj.getScaledHeight()), MIN_ROOM_SIZE);
      obj.set({
        scaleX: snappedW / obj.width,
        scaleY: snappedH / obj.height,
      });
    }

    // 窓：長さ方向のみスナップ、位置・厚さはスナップしない
    if (obj.data?.type === 'window') {
      const snappedW = Math.max(snap(obj.getScaledWidth()), GRID_SIZE);
      obj.set({ scaleX: snappedW / obj.width });
    }

    canvas.renderAll();
  }

  if (obj._wetFurnitureId) {
    // スケール変更時は家具サイズも再計算（内部で syncLabel も呼ばれる）
    const action = e.action || '';
    if (action.startsWith('scale')) recalcWetFurniture(obj);
    else { syncWetFurniture(obj); syncLabel(obj); }
  } else if (obj.data?.type === 'room') {
    syncLabel(obj);
  }

  // 階段：180° / 270° は UP/DN を反転して 0° / 90° に正規化
  // → テキストが逆さまになる角度を排除する
  if (obj.data?.type === 'stairs') {
    const angle = ((obj.angle % 360) + 360) % 360;
    if (angle === 180 || angle === 270) {
      // requestAnimationFrame で現在のイベントサイクル外に逃がして安全に再生成
      const captured = obj;
      requestAnimationFrame(() => flipStairsDirection(captured, angle - 180));
      return; // saveHistory は flipStairsDirection 内で呼ばれる
    }
  }

  updatePropsPanel();
  // リサイズ後に実寸参考を更新
  const _modObj = canvas.getActiveObject();
  if (_modObj?.data?.type === 'room') updateScaleInfo(_modObj);
  saveHistory();
});

// Delete room label (and wet furniture) when rect is removed
canvas.on('object:removed', (e) => {
  const obj = e.target;
  if (obj.data?.type === 'room' && obj._linkedLabelId) {
    const lbl = canvas.getObjects().find(o => o._uid === obj._linkedLabelId);
    if (lbl) canvas.remove(lbl);
  }
  if (obj._wetFurnitureId) {
    const fur = canvas.getObjects().find(o => o._uid === obj._wetFurnitureId);
    if (fur) canvas.remove(fur);
  }
  updateObjectCount();
});

// -------------------------------------------------------
// Wall — drag to draw a single line segment
// -------------------------------------------------------
function startWallDraw(pt) {
  draw.startPt = pt;
  draw.preview = new fabric.Line([pt.x, pt.y, pt.x, pt.y], {
    stroke: '#1a1a1a', strokeWidth: WALL_WIDTH,
    selectable: false, evented: false,
    _isPreview: true,
  });
  canvas.add(draw.preview);
  draw.active = true;
}

function updateWallDraw(pt) {
  if (!draw.active || !draw.preview) return;
  draw.preview.set({ x2: pt.x, y2: pt.y });
  canvas.renderAll();
}

function finishWallDraw(pt) {
  if (!draw.active) return;
  const x1 = draw.startPt.x, y1 = draw.startPt.y;
  const x2 = pt.x, y2 = pt.y;

  canvas.remove(draw.preview);
  draw.active  = false;
  draw.preview = null;
  draw.startPt = null;

  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < GRID_SIZE) return;

  const line = new fabric.Line([x1, y1, x2, y2], {
    stroke: '#1a1a1a', strokeWidth: WALL_WIDTH,
    strokeLineCap: 'square',
    strokeUniform: true, lockScalingFlip: true,
    selectable: true, evented: true,
    hasControls: true,
    data: { type: 'wall' },
    _uid: uid(),
  });
  canvas.add(line);
  canvas.setActiveObject(line);
  updateObjectCount();
  canvas.renderAll();
  saveHistory();
}

function cancelWall() {
  if (draw.active && draw.preview) {
    canvas.remove(draw.preview);
    canvas.renderAll();
  }
  draw.active  = false;
  draw.preview = null;
  draw.startPt = null;
}

// -------------------------------------------------------
// Polygon room tool — click to add vertices, close on first-vertex click or Enter
// -------------------------------------------------------
const poly = {
  active:    false,
  vertices:  [],   // [{x, y}] snapped absolute coords
  lines:     [],   // preview edge lines
  dots:      [],   // vertex indicator circles
  guideLine: null, // dashed line from last vertex to cursor
};

const POLY_CLOSE_RADIUS = 14; // px — snap-close range for first vertex

function startPolyDraw(pt) {
  poly.active   = true;
  poly.vertices = [pt];

  // First vertex dot — orange (= close target indicator)
  const dot = new fabric.Circle({
    left: pt.x, top: pt.y, radius: 6,
    originX: 'center', originY: 'center',
    fill: '#d97706', stroke: '#fff', strokeWidth: 2,
    selectable: false, evented: false, _isPreview: true,
  });
  canvas.add(dot);
  poly.dots.push(dot);

  // Guide line from first vertex to cursor
  poly.guideLine = new fabric.Line([pt.x, pt.y, pt.x, pt.y], {
    stroke: '#d97706', strokeWidth: 1.5, strokeDashArray: [5, 4],
    selectable: false, evented: false, _isPreview: true,
  });
  canvas.add(poly.guideLine);
  canvas.renderAll();
}

function addPolyVertex(pt) {
  const last = poly.vertices[poly.vertices.length - 1];

  // Completed edge
  const line = new fabric.Line([last.x, last.y, pt.x, pt.y], {
    stroke: '#d97706', strokeWidth: 1.5,
    selectable: false, evented: false, _isPreview: true,
  });
  canvas.add(line);
  poly.lines.push(line);

  // Vertex dot (gray for non-first)
  const dot = new fabric.Circle({
    left: pt.x, top: pt.y, radius: 4,
    originX: 'center', originY: 'center',
    fill: '#888', stroke: '#fff', strokeWidth: 1,
    selectable: false, evented: false, _isPreview: true,
  });
  canvas.add(dot);
  poly.dots.push(dot);

  poly.vertices.push(pt);
  poly.guideLine.set({ x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y });
  canvas.renderAll();
}

function updatePolyGuide(pt) {
  if (!poly.active || !poly.guideLine) return;
  poly.guideLine.set({ x2: pt.x, y2: pt.y });
  // Cursor hint: pointer when near first vertex (≥3 verts)
  const nearFirst = poly.vertices.length >= 3 &&
    Math.hypot(pt.x - poly.vertices[0].x, pt.y - poly.vertices[0].y) <= POLY_CLOSE_RADIUS;
  canvas.defaultCursor = nearFirst ? 'pointer' : 'crosshair';
  canvas.renderAll();
}

function isNearFirstPolyVertex(pt) {
  if (poly.vertices.length < 3) return false;
  return Math.hypot(pt.x - poly.vertices[0].x, pt.y - poly.vertices[0].y) <= POLY_CLOSE_RADIUS;
}

function closePolygon() {
  if (poly.vertices.length < 3) { cancelPolyDraw(); return; }

  const id     = uid();
  const points = poly.vertices.map(v => ({ x: v.x, y: v.y }));

  clearPolyPreview();

  const polyObj = new fabric.Polygon(points, {
    fill: '#ffffff', stroke: '#1a1a1a', strokeWidth: WALL_WIDTH,
    strokeUniform: true, lockScalingFlip: true,
    objectCaching: false,
    data: { type: 'room', label: '部屋', tatami: '' },
    _uid: id, _linkedLabelId: id + '_lbl',
  });
  canvas.add(polyObj);

  const center = polyObj.getCenterPoint();
  const label  = new fabric.IText('部屋', {
    left: center.x, top: center.y,
    originX: 'center', originY: 'center',
    fontSize: fitLabelFontSize(polyObj, '部屋'), fontFamily: 'Inter, sans-serif',
    fill: '#1a1a1a', textAlign: 'center', editable: true,
    lockScalingFlip: true,
    padding: 10,
    data: { type: 'room-label', linkedRectId: id },
    _uid: id + '_lbl', _linkedRectId: id,
  });
  canvas.add(label);
  canvas.setActiveObject(polyObj);
  updateObjectCount();
  canvas.renderAll();
  saveHistory();
  setTool('select');
}

function cancelPolyDraw() {
  clearPolyPreview();
  poly.active   = false;
  poly.vertices = [];
}

function clearPolyPreview() {
  [...poly.lines, ...poly.dots].forEach(o => canvas.remove(o));
  if (poly.guideLine) canvas.remove(poly.guideLine);
  poly.lines     = [];
  poly.dots      = [];
  poly.guideLine = null;
  canvas.renderAll();
}

// -------------------------------------------------------
// Text tool
// -------------------------------------------------------
function addTextAt(pt) {
  const t = new fabric.IText('テキスト', {
    left: pt.x, top: pt.y,
    fontSize: 13, fontFamily: 'Inter, sans-serif', fill: '#1a1a1a',
    lockScalingFlip: true,
    data: { type: 'text' }, _uid: uid(),
  });
  canvas.add(t);
  canvas.setActiveObject(t);
  t.enterEditing();
  t.selectAll();
  updateObjectCount();
  canvas.renderAll();
  saveHistory();
}

// -------------------------------------------------------
// Furniture symbols
// -------------------------------------------------------

function makeFurnitureGroup(objects, x, y, type, label) {
  const grp = new fabric.Group(objects, {
    left: x, top: y,
    subTargetCheck: false,
    strokeUniform: true, lockScalingFlip: true,
    data: { type, label },
    _uid: uid(),
  });
  canvas.add(grp);
  canvas.setActiveObject(grp);
  updateObjectCount();
  canvas.renderAll();
  saveHistory();
}

// トイレ (W=40, H=80)
function addToilet(x, y) {
  const W = GRID_SIZE * 2, H = GRID_SIZE * 4, TH = 16;
  makeFurnitureGroup([
    new fabric.Rect({ left:0, top:0, width:W, height:TH,
      fill:'#ccc9c0', stroke:'#1a1a1a', strokeWidth:1.5, strokeUniform:true,
      originX:'left', originY:'top' }),
    new fabric.Rect({ left:0, top:TH, width:W, height:H-TH, rx:W*0.4, ry:(H-TH)*0.3,
      fill:'#fff', stroke:'#1a1a1a', strokeWidth:1.5, strokeUniform:true,
      originX:'left', originY:'top' }),
    new fabric.Ellipse({ left:W*0.1, top:TH+(H-TH)*0.08, rx:W*0.4, ry:(H-TH)*0.41,
      fill:'#e8e5e0', stroke:'#1a1a1a', strokeWidth:1, strokeUniform:true,
      originX:'left', originY:'top' }),
  ], x, y, 'toilet', 'トイレ');
}

// バスタブ (W=80, H=120)
function addBathtub(x, y) {
  const W = GRID_SIZE * 4, H = GRID_SIZE * 6;
  makeFurnitureGroup([
    new fabric.Rect({ left:0, top:0, width:W, height:H, rx:10, ry:10,
      fill:'#fff', stroke:'#1a1a1a', strokeWidth:1.5, strokeUniform:true,
      originX:'left', originY:'top' }),
    new fabric.Ellipse({ left:W*0.14, top:H*0.17, rx:W*0.36, ry:H*0.34,
      fill:'#d4eef7', stroke:'#5ba4c4', strokeWidth:1, strokeUniform:true,
      originX:'left', originY:'top' }),
    new fabric.Rect({ left:W*0.38, top:H*0.04, width:W*0.24, height:H*0.07,
      rx:2, fill:'#888', stroke:null,
      originX:'left', originY:'top' }),
    new fabric.Circle({ left:W*0.44, top:H*0.87, radius:W*0.06,
      fill:'#888', stroke:null,
      originX:'left', originY:'top' }),
  ], x, y, 'bathtub', 'バスタブ');
}

// 流し台 (W=80, H=60)
function addSink(x, y) {
  const W = GRID_SIZE * 4, H = GRID_SIZE * 3;
  makeFurnitureGroup([
    new fabric.Rect({ left:0, top:0, width:W, height:H,
      fill:'#e0ddd8', stroke:'#1a1a1a', strokeWidth:1.5, strokeUniform:true,
      originX:'left', originY:'top' }),
    new fabric.Rect({ left:W*0.1, top:H*0.14, width:W*0.8, height:H*0.72, rx:4,
      fill:'#fff', stroke:'#1a1a1a', strokeWidth:1, strokeUniform:true,
      originX:'left', originY:'top' }),
    new fabric.Circle({ left:W*0.44, top:H*0.42, radius:W*0.08,
      fill:'#aaa', stroke:null,
      originX:'left', originY:'top' }),
    new fabric.Rect({ left:W*0.43, top:H*0.05, width:W*0.14, height:H*0.2,
      rx:2, fill:'#888', stroke:null,
      originX:'left', originY:'top' }),
  ], x, y, 'sink', '流し台');
}

// 冷蔵庫 (W=60, H=80) — 点線四角＋「冷」
function addRefrigerator(x, y) {
  const W = GRID_SIZE * 3, H = GRID_SIZE * 4;
  makeFurnitureGroup([
    new fabric.Rect({ left:0, top:0, width:W, height:H,
      fill:'#fff', stroke:'#1a1a1a', strokeWidth:1.5,
      strokeDashArray:[4, 3], strokeUniform:true,
      originX:'left', originY:'top' }),
    new fabric.Text('冷', {
      left:W/2, top:H/2, originX:'center', originY:'center',
      fontSize:22, fontFamily:'sans-serif', fill:'#1a1a1a',
    }),
  ], x, y, 'refrigerator', '冷蔵庫');
}

// 洗濯機 (W=60, H=60) — 点線四角＋「洗」
function addWasher(x, y) {
  const W = GRID_SIZE * 3, H = GRID_SIZE * 3;
  makeFurnitureGroup([
    new fabric.Rect({ left:0, top:0, width:W, height:H,
      fill:'#fff', stroke:'#1a1a1a', strokeWidth:1.5,
      strokeDashArray:[4, 3], strokeUniform:true,
      originX:'left', originY:'top' }),
    new fabric.Text('洗', {
      left:W/2, top:H/2, originX:'center', originY:'center',
      fontSize:22, fontFamily:'sans-serif', fill:'#1a1a1a',
    }),
  ], x, y, 'washer', '洗濯機');
}

// コンロ (W=80, H=60) — 4口
function addStove(x, y) {
  const W = GRID_SIZE * 4, H = GRID_SIZE * 3;
  const br = W * 0.13; // burner outer radius
  const positions = [
    [W*0.22, H*0.27], [W*0.78, H*0.27],
    [W*0.22, H*0.73], [W*0.78, H*0.73],
  ];
  const objs = [
    new fabric.Rect({ left:0, top:0, width:W, height:H, rx:3,
      fill:'#3a3a3a', stroke:'#1a1a1a', strokeWidth:1.5, strokeUniform:true,
      originX:'left', originY:'top' }),
  ];
  positions.forEach(([cx, cy]) => {
    objs.push(new fabric.Circle({
      left: cx - br, top: cy - br, radius: br,
      fill:'#555', stroke:'#222', strokeWidth:1, strokeUniform:true,
      originX:'left', originY:'top',
    }));
    objs.push(new fabric.Circle({
      left: cx - br*0.4, top: cy - br*0.4, radius: br*0.4,
      fill:'#777', stroke:null,
      originX:'left', originY:'top',
    }));
  });
  makeFurnitureGroup(objs, x, y, 'stove', 'コンロ');
}

// -------------------------------------------------------
// Door — 3-click flow: pt1 → pt2 → orientation confirm
// -------------------------------------------------------
let doorSubtype = 'swing'; // 'swing' | 'bifold' | 'double-bifold'

const doorTool = { state: 0, pt1: null, pt2: null, linePreview: null, shapePreview: null };

// pt1, pt2: door opening endpoints; mousePt: determines hinge side & swing direction
function _getDoorPath(pt1, pt2, mousePt) {
  const dx = pt2.x - pt1.x, dy = pt2.y - pt1.y;
  const len = Math.hypot(dx, dy);
  if (len < 4) return null;
  const d    = { x: dx / len, y: dy / len };        // wall direction
  const perp = { x: -d.y, y: d.x };                 // perpendicular (CCW)
  const mid  = { x: (pt1.x + pt2.x) / 2, y: (pt1.y + pt2.y) / 2 };

  // Which end is the hinge?
  const t = (mousePt.x - pt1.x) * d.x + (mousePt.y - pt1.y) * d.y;
  const hinge    = t < len / 2 ? pt1 : pt2;
  const dFromH   = t < len / 2 ? d : { x: -d.x, y: -d.y };

  // Which side does the door swing?
  const s = (mousePt.x - mid.x) * perp.x + (mousePt.y - mid.y) * perp.y;
  const n = s >= 0 ? perp : { x: -perp.x, y: -perp.y };

  // SVG arc sweep flag (CW=1, CCW=0 in screen coords)
  const sweepFlag = (dFromH.x * n.y - dFromH.y * n.x) > 0 ? 1 : 0;

  const ex = hinge.x + dFromH.x * len;
  const ey = hinge.y + dFromH.y * len;
  const ox = hinge.x + n.x * len;
  const oy = hinge.y + n.y * len;

  // 壁側の線（閉じ位置）は省略 → アーク＋ヒンジへの線のみ
  return {
    pathStr: `M ${ex} ${ey} A ${len} ${len} 0 0 ${sweepFlag} ${ox} ${oy} L ${hinge.x} ${hinge.y}`,
    len,
  };
}

// 折り戸（2枚）: V字形の2本線
function _getBifoldPath(pt1, pt2, mousePt) {
  const dx = pt2.x - pt1.x, dy = pt2.y - pt1.y;
  const len = Math.hypot(dx, dy);
  if (len < 4) return null;
  const d    = { x: dx / len, y: dy / len };
  const perp = { x: -d.y, y: d.x };
  const mid  = { x: (pt1.x + pt2.x) / 2, y: (pt1.y + pt2.y) / 2 };
  const s    = (mousePt.x - mid.x) * perp.x + (mousePt.y - mid.y) * perp.y;
  const n    = s >= 0 ? 1 : -1;
  const depth = len * 0.3;
  const fold = { x: mid.x + n * perp.x * depth, y: mid.y + n * perp.y * depth };
  return {
    pathStr: `M ${pt1.x} ${pt1.y} L ${fold.x} ${fold.y} L ${pt2.x} ${pt2.y}`,
    len,
  };
}

// 2枚折り戸（4枚）: W字形の4本線
function _getDoubleBifoldPath(pt1, pt2, mousePt) {
  const dx = pt2.x - pt1.x, dy = pt2.y - pt1.y;
  const len = Math.hypot(dx, dy);
  if (len < 4) return null;
  const d    = { x: dx / len, y: dy / len };
  const perp = { x: -d.y, y: d.x };
  const mid  = { x: (pt1.x + pt2.x) / 2, y: (pt1.y + pt2.y) / 2 };
  const s    = (mousePt.x - mid.x) * perp.x + (mousePt.y - mid.y) * perp.y;
  const n    = s >= 0 ? 1 : -1;
  const depth = len * 0.15;
  const q1  = { x: pt1.x + dx * 0.25, y: pt1.y + dy * 0.25 };
  const q3  = { x: pt1.x + dx * 0.75, y: pt1.y + dy * 0.75 };
  const f1  = { x: q1.x + n * perp.x * depth, y: q1.y + n * perp.y * depth };
  const f2  = { x: q3.x + n * perp.x * depth, y: q3.y + n * perp.y * depth };
  return {
    pathStr: `M ${pt1.x} ${pt1.y} L ${f1.x} ${f1.y} L ${mid.x} ${mid.y} L ${f2.x} ${f2.y} L ${pt2.x} ${pt2.y}`,
    len,
  };
}

function _getDoorPathForSubtype(pt1, pt2, mousePt) {
  if (doorSubtype === 'bifold')        return _getBifoldPath(pt1, pt2, mousePt);
  if (doorSubtype === 'double-bifold') return _getDoubleBifoldPath(pt1, pt2, mousePt);
  return _getDoorPath(pt1, pt2, mousePt);
}

function _doorClearPreviews() {
  if (doorTool.linePreview)  { canvas.remove(doorTool.linePreview);  doorTool.linePreview  = null; }
  if (doorTool.shapePreview) { canvas.remove(doorTool.shapePreview); doorTool.shapePreview = null; }
}

function cancelDoorDraw() {
  _doorClearPreviews();
  doorTool.state = 0; doorTool.pt1 = null; doorTool.pt2 = null;
  canvas.renderAll();
}

function handleDoorDown(rawPt) {
  if (doorTool.state === 0) {
    const hit = findNearestWallOrEdge(rawPt);
    if (!hit) return;
    const t = projectOntoSegment(rawPt, hit.p1, hit.p2);
    const pt = ptOnSegment(hit.p1, hit.p2, t);
    doorTool.pt1 = pt;
    doorTool.state = 1;

  } else if (doorTool.state === 1) {
    const hit = findNearestWallOrEdge(rawPt);
    if (!hit) return;
    const t = projectOntoSegment(rawPt, hit.p1, hit.p2);
    const pt = ptOnSegment(hit.p1, hit.p2, t);
    doorTool.pt2 = pt;
    doorTool.state = 2;
    _doorUpdateShapePreview(rawPt);

  } else if (doorTool.state === 2) {
    // Confirm placement
    const result = _getDoorPathForSubtype(doorTool.pt1, doorTool.pt2, rawPt);
    const pt1 = doorTool.pt1, pt2 = doorTool.pt2;
    _doorClearPreviews();
    doorTool.state = 0; doorTool.pt1 = null; doorTool.pt2 = null;
    if (result) {
      _placeDoorGrouped(result.pathStr, result.len, pt1, pt2);
    }
    setTool('select');
  }
}

function handleDoorMove(rawPt) {
  if (doorTool.state === 1) {
    // Line preview from pt1 to cursor (snapped to nearest wall)
    if (doorTool.linePreview) canvas.remove(doorTool.linePreview);
    const hit = findNearestWallOrEdge(rawPt);
    const pt = hit
      ? ptOnSegment(hit.p1, hit.p2, projectOntoSegment(rawPt, hit.p1, hit.p2))
      : { x: snap(rawPt.x), y: snap(rawPt.y) };
    doorTool.linePreview = new fabric.Line(
      [doorTool.pt1.x, doorTool.pt1.y, pt.x, pt.y],
      { stroke: '#d97706', strokeWidth: 2, strokeDashArray: [6, 3],
        selectable: false, evented: false, _isPreview: true }
    );
    canvas.add(doorTool.linePreview);
    canvas.renderAll();

  } else if (doorTool.state === 2) {
    _doorUpdateShapePreview(rawPt);
  }
}

function _doorUpdateShapePreview(rawPt) {
  if (doorTool.shapePreview) { canvas.remove(doorTool.shapePreview); doorTool.shapePreview = null; }
  const result = _getDoorPathForSubtype(doorTool.pt1, doorTool.pt2, rawPt);
  if (!result) return;
  const isFold = doorSubtype !== 'swing';
  doorTool.shapePreview = new fabric.Path(result.pathStr, {
    fill: isFold ? 'transparent' : 'rgba(217, 119, 6, 0.2)',
    stroke: '#d97706', strokeWidth: 2, strokeDashArray: [6, 3],
    selectable: false, evented: false, _isPreview: true,
  });
  canvas.add(doorTool.shapePreview);
  canvas.renderAll();
}

// Interactive door placement — gap line + door path grouped together
function _placeDoorGrouped(pathStr, size, pt1, pt2) {
  const gapLen   = Math.hypot(pt2.x - pt1.x, pt2.y - pt1.y);
  const gapAngle = Math.atan2(pt2.y - pt1.y, pt2.x - pt1.x) * 180 / Math.PI;
  const gapMid   = { x: (pt1.x + pt2.x) / 2, y: (pt1.y + pt2.y) / 2 };
  const gapRect = new fabric.Rect({
    left: gapMid.x, top: gapMid.y,
    width: gapLen, height: WALL_WIDTH,
    fill: '#ffffff', stroke: '#1a1a1a', strokeWidth: 1,
    originX: 'center', originY: 'center',
    angle: gapAngle,
  });
  const doorPath = new fabric.Path(pathStr, {
    fill: 'transparent',
    stroke: '#1a1a1a',
    strokeWidth: 2,
    strokeUniform: true,
  });
  const group = new fabric.Group([doorPath, gapRect], {
    lockScalingFlip: true,
    data: { type: 'door', size },
    _uid: uid(),
  });
  canvas.add(group);
  canvas.setActiveObject(group);
  updateObjectCount();
  canvas.renderAll();
  saveHistory();
}

// Programmatic door placement (used by JSON import / legacy flow)
function addDoor(x, y) {
  const s = GRID_SIZE * 4;
  addDoorFromPath(`M 0 ${s} A ${s} ${s} 0 0 0 ${s} 0 L 0 0`, s, x, y);
}

function addDoorFromPath(pathStr, size, left, top) {
  const opts = {
    fill: 'transparent', stroke: '#1a1a1a',
    strokeWidth: 2, strokeUniform: true, lockScalingFlip: true,
    data: { type: 'door', size }, _uid: uid(),
  };
  if (left !== undefined) { opts.left = left; opts.top = top; }
  const door = new fabric.Path(pathStr, opts);
  canvas.add(door);
  canvas.setActiveObject(door);
  updateObjectCount();
  canvas.renderAll();
  saveHistory();
}

// -------------------------------------------------------
// Room modify — indent (削る) / protrude (出っ張らせる)
// UX: ①辺上で1点目クリック ②辺上で2点目クリック ③ドラッグで深さ決定・離して確定
// -------------------------------------------------------

// 部屋（Rect or Polygon）の頂点をキャンバス座標で返す
function getRoomCanvasPoints(room) {
  if (room.type === 'rect') {
    // getCoords() includes strokeWidth in the bounding box (Fabric.js 5 behaviour),
    // so we compute geometric corners manually to avoid a strokeWidth/2 offset.
    const center = room.getCenterPoint();
    // getScaledWidth() includes strokeWidth → use room.width * scaleX for pure geometry
    const w = room.width  * (room.scaleX || 1) / 2;
    const h = room.height * (room.scaleY || 1) / 2;
    const rad = fabric.util.degreesToRadians(room.angle || 0);
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return [
      { x: center.x - cos*w + sin*h, y: center.y - sin*w - cos*h }, // TL
      { x: center.x + cos*w + sin*h, y: center.y + sin*w - cos*h }, // TR
      { x: center.x + cos*w - sin*h, y: center.y + sin*w + cos*h }, // BR
      { x: center.x - cos*w - sin*h, y: center.y - sin*w + cos*h }, // BL
    ];
  }
  // polygon: points は pathOffset 基準のローカル座標
  const matrix = room.calcTransformMatrix();
  const ox = room.pathOffset ? room.pathOffset.x : 0;
  const oy = room.pathOffset ? room.pathOffset.y : 0;
  return room.points.map(p => {
    const pt = fabric.util.transformPoint({ x: p.x - ox, y: p.y - oy }, matrix);
    return { x: pt.x, y: pt.y };
  });
}

// pt に最も近い部屋の辺を返す
function findNearestRoomEdgePt(pt, threshold) {
  threshold = threshold || 25;
  let best = null, bestDist = threshold;
  canvas.getObjects().forEach(function(obj) {
    if (obj._isGrid || obj._isPreview) return;
    if (obj.data && obj.data.type !== 'room') return;
    if (obj.type !== 'rect' && obj.type !== 'polygon') return;
    const verts = getRoomCanvasPoints(obj);
    const n = verts.length;
    for (let i = 0; i < n; i++) {
      const v1 = verts[i], v2 = verts[(i + 1) % n];
      const t = projectOntoSegment(pt, v1, v2);
      const snap = ptOnSegment(v1, v2, t);
      const d = Math.hypot(pt.x - snap.x, pt.y - snap.y);
      if (d < bestDist) {
        bestDist = d;
        best = { room: obj, edgeIdx: i, snapPt: snap, v1: v1, v2: v2, t: t };
      }
    }
  });
  return best;
}

// 辺の内向き法線（部屋中心方向）を返す
function edgeInwardNormal(v1, v2, roomCenter) {
  const dx = v2.x - v1.x, dy = v2.y - v1.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return { x: 0, y: -1 };
  const lx = -dy / len, ly = dx / len;   // 左垂直
  const rx =  dy / len, ry = -dx / len;  // 右垂直
  const mid = { x: (v1.x + v2.x) / 2, y: (v1.y + v2.y) / 2 };
  const toCx = roomCenter.x - mid.x, toCy = roomCenter.y - mid.y;
  return (lx * toCx + ly * toCy) > 0 ? { x: lx, y: ly } : { x: rx, y: ry };
}

// -------------------------------------------------------
// Room modify — 削る / 出す
// UX: ①壁クリック(pt1) → ②自由クリック×任意 → ③壁クリック(ptN) で確定
// -------------------------------------------------------
const modTool = {
  state:    0,      // 0=idle 1=点収集中
  type:     null,   // 'indent'|'protrude'
  room:     null,
  edge1:    -1,     // pt1 が乗る辺インデックス
  pt1:      null,
  freePts:  [],     // 自由点リスト
  // preview
  dots:     [],
  lines:    [],
  cursorLine: null,
};

function _modClearPreview() {
  modTool.dots.forEach(d => canvas.remove(d));  modTool.dots = [];
  modTool.lines.forEach(l => canvas.remove(l)); modTool.lines = [];
  if (modTool.cursorLine) { canvas.remove(modTool.cursorLine); modTool.cursorLine = null; }
}

function cancelModifyDraw() {
  _modClearPreview();
  modTool.state = 0;
  modTool.room = modTool.pt1 = null;
  modTool.edge1 = -1;
  modTool.freePts = [];
  canvas.renderAll();
}

// 点がポリゴン内にあるか（ray casting）
function _pointInPolygon(pt, polyPts) {
  let inside = false;
  const n = polyPts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polyPts[i].x, yi = polyPts[i].y;
    const xj = polyPts[j].x, yj = polyPts[j].y;
    if ((yi > pt.y) !== (yj > pt.y) &&
        pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// 指定部屋の最近傍辺を返す（閾値内のみ）
function _findEdgeOnRoom(rawPt, room) {
  const threshold = 16 / canvas.getZoom();
  const verts = getRoomCanvasPoints(room);
  const n = verts.length;
  let best = null, bestDist = threshold;
  for (let i = 0; i < n; i++) {
    const v1 = verts[i], v2 = verts[(i+1)%n];
    const t  = projectOntoSegment(rawPt, v1, v2);
    const c  = ptOnSegment(v1, v2, t);
    const d  = Math.hypot(rawPt.x - c.x, rawPt.y - c.y);
    if (d < bestDist) { bestDist = d; best = { edgeIdx: i }; }
  }
  return best;
}

// どの部屋の辺にも近い点を返す
function _findEdgeOnAnyRoom(rawPt) {
  const threshold = 16 / canvas.getZoom();
  let best = null, bestDist = threshold;
  canvas.getObjects().forEach(obj => {
    if (obj._isGrid || obj._isPreview) return;
    if (obj.data?.type !== 'room') return;
    if (obj.type !== 'rect' && obj.type !== 'polygon') return;
    const verts = getRoomCanvasPoints(obj);
    const n = verts.length;
    for (let i = 0; i < n; i++) {
      const v1 = verts[i], v2 = verts[(i+1)%n];
      const t  = projectOntoSegment(rawPt, v1, v2);
      const c  = ptOnSegment(v1, v2, t);
      const d  = Math.hypot(rawPt.x - c.x, rawPt.y - c.y);
      if (d < bestDist) { bestDist = d; best = { room: obj, edgeIdx: i }; }
    }
  });
  return best;
}

function _modAddDot(pt) {
  const dot = new fabric.Circle({
    left: pt.x, top: pt.y, radius: 5,
    originX: 'center', originY: 'center',
    fill: '#d97706', stroke: '#ffffff', strokeWidth: 1.5,
    selectable: false, evented: false, _isPreview: true,
  });
  canvas.add(dot);
  modTool.dots.push(dot);
}

function _modAddLine(a, b, dashed) {
  const line = new fabric.Line([a.x, a.y, b.x, b.y], {
    stroke: '#d97706', strokeWidth: 2,
    strokeDashArray: dashed ? [6, 3] : null,
    selectable: false, evented: false, _isPreview: true,
  });
  canvas.add(line);
  modTool.lines.push(line);
}

// 辺上に投影した点を返す（壁クリックは必ず辺上になるよう）
function _projectOntoEdge(rawPt, room, edgeIdx) {
  const verts = getRoomCanvasPoints(room);
  const va = verts[edgeIdx];
  const vb = verts[(edgeIdx + 1) % verts.length];
  const t  = Math.max(0, Math.min(1, projectOntoSegment(rawPt, va, vb)));
  return ptOnSegment(va, vb, t);
}

// マウスダウン処理
function handleModifyDown(rawPt, type) {
  if (modTool.state === 0) {
    const hit = _findEdgeOnAnyRoom(rawPt);
    if (!hit) return;
    // 壁クリック: 辺上に投影してからグリッドスナップ
    const _proj1 = _projectOntoEdge(rawPt, hit.room, hit.edgeIdx);
    const pt1 = { x: snap(_proj1.x), y: snap(_proj1.y) };
    modTool.type  = type;
    modTool.room  = hit.room;
    modTool.edge1 = hit.edgeIdx;
    modTool.pt1   = pt1;
    modTool.freePts = [];
    modTool.state = 1;
    _modAddDot(pt1);
    canvas.renderAll();

  } else if (modTool.state === 1) {
    const hit = _findEdgeOnRoom(rawPt, modTool.room);

    if (hit && modTool.freePts.length >= 1) {
      // 終点壁クリック → 辺上に投影してグリッドスナップ後に確定
      const _projN = _projectOntoEdge(rawPt, modTool.room, hit.edgeIdx);
      const ptN = { x: snap(_projN.x), y: snap(_projN.y) };
      const edgeN = hit.edgeIdx;
      const { room, pt1, edge1, freePts, type } = modTool;
      _modClearPreview();
      modTool.state = 0;
      modTool.room = modTool.pt1 = null;
      modTool.edge1 = -1;
      modTool.freePts = [];
      _applyRoomModification(room, pt1, edge1, freePts, ptN, edgeN);
      setTool('select');
    } else {
      // 自由点追加 — 削る=内側・出す=外側 のみ受け付ける
      // 方向チェックはスナップ前の生座標で行う（スナップで壁上に乗ると境界判定がずれるため）
      const pt = { x: snap(rawPt.x), y: snap(rawPt.y) };
      const verts = getRoomCanvasPoints(modTool.room);
      const isInside = _pointInPolygon(rawPt, verts);
      if (modTool.type === 'indent'   && !isInside) return;  // 削る: 外側は無効
      if (modTool.type === 'protrude' &&  isInside) return;  // 出す: 内側は無効

      const prevPt = modTool.freePts.length === 0 ? modTool.pt1 : modTool.freePts[modTool.freePts.length - 1];
      modTool.freePts.push(pt);
      _modAddDot(pt);
      _modAddLine(prevPt, pt, false);
      canvas.renderAll();
    }
  }
}

// マウスムーブ処理
function handleModifyMove(rawPt) {
  if (modTool.state !== 1) return;
  if (modTool.cursorLine) { canvas.remove(modTool.cursorLine); modTool.cursorLine = null; }
  const lastPt = modTool.freePts.length === 0 ? modTool.pt1 : modTool.freePts[modTool.freePts.length - 1];
  const pt = { x: snap(rawPt.x), y: snap(rawPt.y) };
  modTool.cursorLine = new fabric.Line([lastPt.x, lastPt.y, pt.x, pt.y], {
    stroke: '#d97706', strokeWidth: 2, strokeDashArray: [6, 3],
    selectable: false, evented: false, _isPreview: true,
  });
  canvas.add(modTool.cursorLine);
  canvas.renderAll();
}

function handleModifyUp(rawPt) { /* 確定は mouse:down で行う */ }

// 実際に部屋ポリゴンを変形する
// pt1(edge1上) → freePts → ptN(edgeN上) で wall section を置換
function _applyRoomModification(room, pt1, edge1, freePts, ptN, edgeN) {
  const verts = getRoomCanvasPoints(room);
  const n = verts.length;

  // pt1/ptN はグリッドスナップ済みで壁から微妙にずれている可能性があるため、
  // ポリゴン構築前に辺上へ再投影して直線を保証する
  let p1 = _projectOntoEdge(pt1, room, edge1);
  let pN = _projectOntoEdge(ptN, room, edgeN);
  let fps = [...freePts];
  let e1 = edge1, eN = edgeN;

  if (e1 === eN) {
    // 同じ辺: t1 < tN になるよう並べ替え
    const t1 = projectOntoSegment(p1, verts[e1], verts[(e1+1)%n]);
    const tN = projectOntoSegment(pN, verts[eN], verts[(eN+1)%n]);
    if (t1 > tN) { [p1, pN] = [pN, p1]; fps = fps.reverse(); }
  } else {
    // 異なる辺: 置換区間が短くなる経路を選択
    // 前進方向で置換される頂点数 = (eN - e1 + n) % n
    const fwdSkip = (eN - e1 + n) % n;
    if (fwdSkip > n - fwdSkip) {
      // 後退方向のほうが短い → e1/eN と p1/pN を入れ替えて前進方向を逆にする
      [e1, eN] = [eN, e1];
      [p1, pN] = [pN, p1];
      fps = fps.reverse();
    }
  }

  // 新頂点列を構築
  // v[(eN+1)%n] から v[e1] まで既存頂点を保持し、その後 p1→fps→pN を追加
  const count = ((e1 - eN + n) % n) || n;
  const newVerts = [];
  for (let j = 0; j < count; j++) {
    newVerts.push(verts[(eN + 1 + j) % n]);
  }

  // 重複回避: p1 が v[e1] と同一なら省略
  const t1 = projectOntoSegment(p1, verts[e1], verts[(e1+1)%n]);
  if (t1 > 0.005) newVerts.push(p1);
  fps.forEach(p => newVerts.push(p));
  // 重複回避: pN が v[(eN+1)%n] と同一なら省略
  const tN = projectOntoSegment(pN, verts[eN], verts[(eN+1)%n]);
  if (tN < 0.995) newVerts.push(pN);

  // 新しいポリゴンを作成（プロパティを引き継ぐ）
  const newRoom = new fabric.Polygon(newVerts, {
    fill:            room.fill  || '#ffffff',
    stroke:          room.stroke || '#1a1a1a',
    strokeWidth:     room.strokeWidth || WALL_WIDTH,
    strokeUniform:   true,
    lockScalingFlip: true,
    objectCaching:   false,
    strokeLineJoin:  'miter',
    data:            Object.assign({}, room.data),
    _uid:            room._uid,
    _linkedLabelId:  room._linkedLabelId,
  });
  if (room._wetFurnitureId) {
    newRoom._wetFurnitureId        = room._wetFurnitureId;
    newRoom._wetFurnitureOffset    = room._wetFurnitureOffset;
    newRoom._wetFurnitureInitAngle = room._wetFurnitureInitAngle;
    newRoom._wetFurnitureType      = room._wetFurnitureType;
  }

  historyPaused = true;
  // object:removed でラベル・水回り家具が連動削除されないよう一時的にリンクを外す
  const savedLabelId      = room._linkedLabelId;
  const savedFurnitureId  = room._wetFurnitureId;
  room._linkedLabelId = null;
  room._wetFurnitureId = null;
  const roomIndex = canvas.getObjects().indexOf(room);
  canvas.remove(room);
  canvas.add(newRoom);
  if (roomIndex >= 0) canvas.moveTo(newRoom, roomIndex);
  newRoom._linkedLabelId = savedLabelId;
  historyPaused = false;

  if (savedFurnitureId) {
    // 家具の現在の絶対座標から新しい部屋中心との相対オフセットを再計算し、
    // 家具を動かさずにオフセットだけ更新する
    const fur = canvas.getObjects().find(o => o._uid === savedFurnitureId);
    if (fur) {
      const center = newRoom.getCenterPoint();
      const rad = fabric.util.degreesToRadians(newRoom.angle || 0);
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const relX = fur.left - center.x;
      const relY = fur.top  - center.y;
      newRoom._wetFurnitureOffset = {
        dx:  cos * relX + sin * relY,
        dy: -sin * relX + cos * relY,
      };
    }
  }
  syncLabel(newRoom);
  canvas.setActiveObject(newRoom);
  updateObjectCount();
  canvas.renderAll();
  saveHistory();
}

// -------------------------------------------------------
// Window — drag along a wall to insert a window segment
// -------------------------------------------------------

// Get absolute canvas endpoints of a wall line (handles move/scale/rotation)
// wall.x1/y1/x2/y2 are creation-time absolute coords; left/top is current center.
// Convert to center-relative before applying the current transform matrix.
function getWallEndpoints(wall) {
  const cx0 = (wall.x1 + wall.x2) / 2;
  const cy0 = (wall.y1 + wall.y2) / 2;
  const t   = wall.calcTransformMatrix();
  return [
    fabric.util.transformPoint({ x: wall.x1 - cx0, y: wall.y1 - cy0 }, t),
    fabric.util.transformPoint({ x: wall.x2 - cx0, y: wall.y2 - cy0 }, t),
  ];
}

// Project pt onto segment p1-p2, return t in [0,1]
function projectOntoSegment(pt, p1, p2) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1) return 0;
  return Math.max(0, Math.min(1, ((pt.x - p1.x) * dx + (pt.y - p1.y) * dy) / len2));
}

function ptOnSegment(p1, p2, t) {
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

// 壁（Line）または部屋の辺（Rect）のうち最も近いものを返す
// 戻り値: { isWall, obj, p1, p2 } または null
function findNearestWallOrEdge(pt) {
  // 30 screen-px regardless of zoom level
  let best = null, bestDist = 30 / canvas.getZoom();

  canvas.getObjects().forEach(obj => {
    if (obj._isGrid || obj._isPreview) return;

    if (obj.data?.type === 'wall') {
      const [p1, p2] = getWallEndpoints(obj);
      const t = projectOntoSegment(pt, p1, p2);
      const c = ptOnSegment(p1, p2, t);
      const d = Math.hypot(pt.x - c.x, pt.y - c.y);
      if (d < bestDist) { bestDist = d; best = { isWall: true, obj, p1, p2 }; }

    } else if (obj.data?.type === 'room') {
      const verts = getRoomCanvasPoints(obj);
      const n = verts.length;
      for (let i = 0; i < n; i++) {
        const p1 = verts[i], p2 = verts[(i + 1) % n];
        const t  = projectOntoSegment(pt, p1, p2);
        const c  = ptOnSegment(p1, p2, t);
        const d  = Math.hypot(pt.x - c.x, pt.y - c.y);
        if (d < bestDist) { bestDist = d; best = { isWall: false, obj, p1, p2 }; }
      }
    }
  });
  return best;
}

function makeWallLine(p1, p2) {
  return new fabric.Line([p1.x, p1.y, p2.x, p2.y], {
    stroke: '#1a1a1a', strokeWidth: WALL_WIDTH,
    strokeLineCap: 'square',
    strokeUniform: true, lockScalingFlip: true,
    data: { type: 'wall' }, _uid: uid(),
  });
}

// 引き違い窓記号（JIS平面断面記号）
// 全オブジェクトを originX/Y:'center' + 中心座標で指定
// → Fabric.js Group のバウンディングボックス計算が安定してズレなし
function makeWindowObject(p1, p2) {
  const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (len < 4) return null;
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;
  const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
  const H  = WALL_WIDTH;  // 6px
  const hl = len / 2;
  const ov = hl * 0.2;   // 障子の重なり量（各側20%）

  // 中心座標指定の 1px 高さ Rect（strokeWidth:0）
  function hLine(cx, cy, w) {
    return new fabric.Rect({
      left: cx, top: cy, width: w, height: 1,
      fill: '#1a1a1a', strokeWidth: 0,
      originX: 'center', originY: 'center',
    });
  }

  // 背景：壁を完全に隠す白抜き（中心=(0,0)、height=WALL_WIDTH）
  const bg = new fabric.Rect({
    left: 0, top: 0, width: len, height: H,
    fill: '#ffffff', strokeWidth: 0,
    originX: 'center', originY: 'center',
  });

  // 壁外面（上端）・壁内面（下端）
  const wTop   = hLine(0,              -(H / 2 - 0.5), len);
  const wBot   = hLine(0,               (H / 2 - 0.5), len);
  // 外障子（外面から1px内側、左端〜中央+ov）
  const gOuter = hLine((-hl + ov) / 2, -(H / 2 - 1.5), hl + ov);
  // 内障子（内面から1px内側、中央-ov〜右端）
  const gInner = hLine((-ov + hl) / 2,  (H / 2 - 1.5), hl + ov);

  return new fabric.Group([bg, wTop, wBot, gOuter, gInner], {
    left: cx, top: cy, angle,
    originX: 'center', originY: 'center',
    subTargetCheck: false, lockScalingFlip: true,
    data: { type: 'window' }, _uid: uid(),
  });
}

function startWindowDraw(pt) {
  const source = findNearestWallOrEdge(pt);
  if (!source) return;

  const { p1, p2 } = source;
  const t = projectOntoSegment(pt, p1, p2);
  const sp = ptOnSegment(p1, p2, t);
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;

  draw.active      = true;
  draw.wallSource  = source;
  draw.wallRef     = source.obj;   // keep for compat
  draw.wallP1      = p1;
  draw.wallP2      = p2;
  draw.winT1   = t;
  draw.winT2   = t;
  draw.startPt = pt;

  draw.preview = new fabric.Rect({
    left: sp.x, top: sp.y, width: 1, height: WALL_WIDTH,
    originX: 'center', originY: 'center', angle,
    fill: 'rgba(217, 119, 6, 0.15)', stroke: '#d97706', strokeWidth: 1,
    selectable: false, evented: false, _isPreview: true,
  });
  canvas.add(draw.preview);
  canvas.renderAll();
}

function updateWindowDraw(pt) {
  if (!draw.active || !draw.preview || !draw.wallSource) return;
  const { wallP1: p1, wallP2: p2 } = draw;
  const t2   = projectOntoSegment(pt, p1, p2);
  const tMin = Math.min(draw.winT1, t2);
  const tMax = Math.max(draw.winT1, t2);
  const sp = ptOnSegment(p1, p2, tMin);
  const ep = ptOnSegment(p1, p2, tMax);
  const len = Math.max(1, Math.hypot(ep.x - sp.x, ep.y - sp.y));
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;

  draw.winT2 = t2;
  draw.preview.set({
    left: (sp.x + ep.x) / 2, top: (sp.y + ep.y) / 2,
    width: len, angle,
  });
  draw.preview.setCoords();
  canvas.renderAll();
}

function finishWindowDraw(pt) {
  if (!draw.active || !draw.wallSource) { cancelDrawing(); return; }

  const { wallSource: source, wallP1: p1, wallP2: p2 } = draw;
  const t2   = projectOntoSegment(pt, p1, p2);
  const tMin = Math.min(draw.winT1, t2);
  const tMax = Math.max(draw.winT1, t2);

  canvas.remove(draw.preview);
  draw.active      = false;
  draw.preview     = null;
  draw.startPt     = null;
  draw.wallRef     = null;
  draw.wallSource  = null;

  const totalLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (totalLen * (tMax - tMin) < GRID_SIZE) return;   // 短すぎる

  const wp1 = ptOnSegment(p1, p2, tMin);
  const wp2 = ptOnSegment(p1, p2, tMax);

  // 壁・部屋辺どちらも窓シンボルを上に重ねるだけ（元の線は変更しない）
  historyPaused = true;
  const win = makeWindowObject(wp1, wp2);
  historyPaused = false;
  if (win) { canvas.add(win); canvas.setActiveObject(win); }

  updateObjectCount();
  canvas.renderAll();
  saveHistory();
}

// -------------------------------------------------------
// Stairs — click to place (rectangle + tread lines + UP/DN arrow)
// -------------------------------------------------------
function buildStairsObjects(W, H, direction) {
  const STEPS = 8;
  const stepH = H / STEPS;
  const cx    = W / 2;
  const isUp  = direction === 'up';
  const objects = [];

  // Outer border
  objects.push(new fabric.Rect({
    left: 0, top: 0, width: W, height: H,
    fill: '#fafafa', stroke: '#1a1a1a', strokeWidth: 2,
    strokeUniform: true, originX: 'left', originY: 'top',
  }));

  // Tread lines
  for (let i = 1; i < STEPS; i++) {
    objects.push(new fabric.Line([0, i * stepH, W, i * stepH], {
      stroke: '#1a1a1a', strokeWidth: 1.5, strokeUniform: true,
    }));
  }

  // Arrow shaft + head as a single Path
  const y1   = isUp ? H * 0.82 : H * 0.18; // shaft base
  const y2   = isUp ? H * 0.22 : H * 0.78; // shaft tip
  const yhd  = isUp ? H * 0.12 : H * 0.88; // arrowhead point
  const yhb  = isUp ? H * 0.24 : H * 0.76; // arrowhead base
  const aw   = 6;                            // arrowhead half-width

  objects.push(new fabric.Path(
    `M ${cx} ${y1} L ${cx} ${y2} M ${cx - aw} ${yhb} L ${cx} ${yhd} L ${cx + aw} ${yhb}`,
    { stroke: '#1a1a1a', strokeWidth: 2, fill: 'transparent', strokeUniform: true }
  ));

  // Label: "UP" or "DN"
  const labelY = isUp ? H * 0.89 : H * 0.11;
  objects.push(new fabric.Text(isUp ? 'UP' : 'DN', {
    left: cx, top: labelY,
    originX: 'center', originY: 'center',
    fontSize: 10, fontFamily: 'Inter, sans-serif',
    fill: '#1a1a1a', fontWeight: '600',
  }));

  return objects;
}

function addStairs(x, y, direction = 'up') {
  const W = GRID_SIZE * 5;  // 100px
  const H = GRID_SIZE * 8;  // 160px
  const id = uid();

  const grp = new fabric.Group(buildStairsObjects(W, H, direction), {
    left: x, top: y,
    data: { type: 'stairs', direction, W, H },
    _uid: id,
    subTargetCheck: false,
    strokeUniform: true, lockScalingFlip: true,
  });
  canvas.add(grp);
  canvas.setActiveObject(grp);
  updateObjectCount();
  canvas.renderAll();
  saveHistory();
  return grp;
}

// UP ↔ DN 切替：グループを同位置に再生成
// sourceObj: 対象オブジェクト（省略時はアクティブオブジェクト）
// overrideAngle: 再生成後に設定する角度（省略時は元の角度をそのまま使用）
function flipStairsDirection(sourceObj, overrideAngle) {
  const obj = sourceObj || canvas.getActiveObject();
  if (!obj || obj.data?.type !== 'stairs') return;

  const dir   = obj.data.direction === 'up' ? 'dn' : 'up';
  const W     = obj.data.W || GRID_SIZE * 5;
  const H     = obj.data.H || GRID_SIZE * 8;
  const angle = overrideAngle !== undefined ? overrideAngle : obj.angle;

  const newGrp = new fabric.Group(buildStairsObjects(W, H, dir), {
    left:    obj.left,
    top:     obj.top,
    angle,
    scaleX:  obj.scaleX,
    scaleY:  obj.scaleY,
    data: { type: 'stairs', direction: dir, W, H },
    _uid: uid(),
    subTargetCheck: false,
    strokeUniform: true, lockScalingFlip: true,
  });

  canvas.remove(obj);
  canvas.add(newGrp);
  canvas.setActiveObject(newGrp);
  updateObjectCount();
  canvas.renderAll();
  updatePropsPanel();
  saveHistory();
}

// -------------------------------------------------------
// Unified mouse events
// -------------------------------------------------------
canvas.on('mouse:down', (e) => {
  // 右クリック → 配置中のツールをキャンセルして選択ツールへ
  if (e.e.button === 2) {
    if (doorTool.state > 0)  { cancelDoorDraw();   setTool('select'); return; }
    if (poly.active)         { cancelPolyDraw();   setTool('select'); return; }
    if (modTool.room)        { cancelModifyDraw(); setTool('select'); return; }
    if (draw.active)         { cancelDrawing();    setTool('select'); return; }
  }
  // Middle-mouse / Alt+drag pan
  if (e.e.button === 1 || (e.e.button === 0 && e.e.altKey)) {
    startPan(e); return;
  }
  // select ツールで空白をドラッグ → パン
  if (currentTool === 'select' && !e.target && e.e.button === 0) {
    startPan(e); return;
  }

  const pt = getPointer(e);

  switch (currentTool) {
    case 'room':
    case 'cl-room':
      // 1クリック目はmouse:upで処理する（2クリック確定方式）
      break;
    case 'wet-room':
      if (!e.target) startWetRoomDraw(pt);
      break;
    case 'wall':
      if (!e.target) startWallDraw(pt);
      break;
    case 'door':
      handleDoorDown(canvas.getPointer(e.e));
      break;
    case 'indent':
    case 'protrude':
      handleModifyDown(canvas.getPointer(e.e), currentTool);
      break;
    case 'window':
      startWindowDraw(canvas.getPointer(e.e));  // スナップなし：壁への投影で位置決め
      break;
    case 'stairs':
      if (!e.target) addStairs(pt.x, pt.y);
      setTool('select');
      break;
    case 'text':
      if (!e.target) addTextAt(pt);
      setTool('select');
      break;
    case 'poly':
      if (!poly.active) {
        startPolyDraw(pt);
      } else if (isNearFirstPolyVertex(pt)) {
        closePolygon();
      } else {
        addPolyVertex(pt);
      }
      break;
    case 'toilet':      if (!e.target) addToilet(pt.x, pt.y);      setTool('select'); break;
    case 'bathtub':     if (!e.target) addBathtub(pt.x, pt.y);     setTool('select'); break;
    case 'sink':        if (!e.target) addSink(pt.x, pt.y);        setTool('select'); break;
    case 'refrigerator':if (!e.target) addRefrigerator(pt.x, pt.y);setTool('select'); break;
    case 'washer':      if (!e.target) addWasher(pt.x, pt.y);      setTool('select'); break;
    case 'stove':       if (!e.target) addStove(pt.x, pt.y);       setTool('select'); break;
  }
});

canvas.on('mouse:move', (e) => {
  if (isPanning) { doPan(e); return; }
  const pt = getPointer(e);
  if (currentTool === 'room' || currentTool === 'cl-room') updateRoomDraw(pt);
  if (currentTool === 'wet-room') updateWetRoomDraw(pt);
  if (currentTool === 'wall')     updateWallDraw(pt);
  if (currentTool === 'indent' || currentTool === 'protrude') handleModifyMove(canvas.getPointer(e.e));
  if (currentTool === 'door')     handleDoorMove(canvas.getPointer(e.e));
  if (currentTool === 'window')   updateWindowDraw(canvas.getPointer(e.e));
  if (currentTool === 'poly')     updatePolyGuide(pt);
});

canvas.on('mouse:up', (e) => {
  if (isPanning) { stopPan(); return; }
  const pt = getPointer(e);
  if (currentTool === 'room' || currentTool === 'cl-room') {
    if (!draw.active && !e.target) startRoomDraw(pt);   // 1クリック目: 起点を設定
    else if (draw.active)          finishRoomDraw(pt);  // 2クリック目: 確定
  }
  if (currentTool === 'wet-room') finishWetRoomDraw(pt);
  if (currentTool === 'wall')     finishWallDraw(pt);
  if (currentTool === 'indent' || currentTool === 'protrude') handleModifyUp(canvas.getPointer(e.e));
  if (currentTool === 'window')   { finishWindowDraw(canvas.getPointer(e.e)); setTool('select'); }
});

// Double-click on room rect → enter label editor
canvas.on('mouse:dblclick', (e) => {
  if (!e.target) return;
  const obj = e.target;

  if (obj.data?.type === 'room') {
    // Focus label input in props panel
    const labelInput = document.getElementById('prop-label');
    labelInput.focus();
    labelInput.select();
    return;
  }

  if (obj.type === 'i-text' || obj.type === 'text') {
    obj.enterEditing();
    canvas.renderAll();
  }
});

// -------------------------------------------------------
// Pan with middle-mouse / Alt+drag
// -------------------------------------------------------
let isPanning  = false;
let panLastPt  = { x: 0, y: 0 };

function startPan(e) {
  isPanning = true;
  canvas.selection = false;
  panLastPt = { x: e.e.clientX, y: e.e.clientY };
  canvas.defaultCursor = 'grabbing';
  e.e.preventDefault();
}

function doPan(e) {
  const vpt = canvas.viewportTransform;
  vpt[4] += e.e.clientX - panLastPt.x;
  vpt[5] += e.e.clientY - panLastPt.y;
  panLastPt = { x: e.e.clientX, y: e.e.clientY };
  canvas.requestRenderAll();
  drawGrid();
}

function stopPan() {
  isPanning = false;
  canvas.selection = currentTool === 'select';
  canvas.defaultCursor = currentTool === 'select' ? 'default' : 'crosshair';
}

// -------------------------------------------------------
// Zoom
// -------------------------------------------------------
function setZoom(z) {
  z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  canvas.setZoom(z);
  document.getElementById('zoom-display').textContent = `${Math.round(z * 100)}%`;
  drawGrid();
}

canvas.on('mouse:wheel', (e) => {
  let z = canvas.getZoom() * (0.999 ** e.e.deltaY);
  setZoom(z);
  e.e.preventDefault();
  e.e.stopPropagation();
});

document.getElementById('btn-zoom-in').addEventListener('click',
  () => setZoom(canvas.getZoom() + ZOOM_STEP));
document.getElementById('btn-zoom-out').addEventListener('click',
  () => setZoom(canvas.getZoom() - ZOOM_STEP));
document.getElementById('btn-zoom-reset').addEventListener('click', () => {
  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  setZoom(1);
});

// -------------------------------------------------------
// Delete selected
// -------------------------------------------------------
function deleteSelected() {
  const active = canvas.getActiveObjects();
  if (!active.length) return;
  active.forEach(obj => canvas.remove(obj));
  canvas.discardActiveObject();
  canvas.renderAll();
  saveHistory();
}

document.getElementById('btn-delete-selected').addEventListener('click', deleteSelected);

// Per-object snap toggle
document.getElementById('prop-snap-toggle').addEventListener('change', (e) => {
  const obj = canvas.getActiveObject();
  if (!obj || obj._isGrid) return;
  const $snapLabel = document.getElementById('prop-snap-label');
  if (e.target.checked) {
    delete obj.data.snapDisabled;
    $snapLabel.textContent = 'ON';
  } else {
    if (!obj.data) obj.data = {};
    obj.data.snapDisabled = true;
    $snapLabel.textContent = 'OFF';
  }
  saveHistory();
});

// -------------------------------------------------------
// Properties panel
// -------------------------------------------------------
const $propsEmpty   = document.getElementById('props-empty');
const $propsContent = document.getElementById('props-content');
const $propLabel         = document.getElementById('prop-label');
const $propTatami        = document.getElementById('prop-tatami');
const $propLabelFontsize = document.getElementById('prop-label-fontsize');
const $propAngle         = document.getElementById('prop-angle');
const $typeBadge         = document.getElementById('prop-type-badge');

const TYPE_LABELS = {
  room: '部屋', wall: '壁', door: 'ドア',
  window: '窓', stairs: '階段', text: 'テキスト',
  'room-label': 'ラベル',
  toilet: 'トイレ', bathtub: 'バスタブ', sink: '流し台',
  refrigerator: '冷蔵庫', washer: '洗濯機', stove: 'コンロ',
};

canvas.on('selection:created', updatePropsPanel);
canvas.on('selection:updated', updatePropsPanel);
canvas.on('selection:cleared', clearPropsPanel);

function updatePropsPanel() {
  const obj = canvas.getActiveObject();
  if (!obj || obj._isGrid) { clearPropsPanel(); return; }

  $propsEmpty.style.display   = 'none';
  $propsContent.style.display = 'block';

  // Type badge
  const objType = obj.data?.type || obj.type || '—';
  $typeBadge.textContent = TYPE_LABELS[objType] || objType;

  // Rotation — step と placeholder をオブジェクト種別に合わせる
  const freeRotation = !SNAP90_TYPES.has(objType);
  if ($propAngle) {
    $propAngle.step        = freeRotation ? 1   : 90;
    $propAngle.placeholder = freeRotation ? '0' : '0 / 90 / 180 / 270';
    $propAngle.value       = Math.round(obj.angle || 0);
  }

  // Show/hide room fields (room rect OR room-label both show the panel)
  const isRoom      = objType === 'room';
  const isRoomLabel = objType === 'room-label';
  const roomRect    = isRoom ? obj : (isRoomLabel ? getLinkedRect(obj) : null);
  document.getElementById('prop-room-fields').style.display = roomRect ? 'block' : 'none';
  if (roomRect) {
    $propLabel.value  = roomRect.data.label  || '';
    $propTatami.value = roomRect.data.tatami || '';
    // Show current font size (manual override or auto-calculated)
    const lbl = canvas.getObjects().find(o => o._uid === roomRect._linkedLabelId);
    const currentFs = roomRect.data.labelFontSize || (lbl ? lbl.fontSize : 13);
    $propLabelFontsize.value       = currentFs;
    $propLabelFontsize.placeholder = roomRect.data.labelFontSize ? '' : '自動';
    updateScaleInfo(roomRect);
  }
  document.getElementById('prop-scale-info').style.display = roomRect ? 'block' : 'none';

  // Show/hide stairs fields
  const isStairs = objType === 'stairs';
  document.getElementById('prop-stairs-fields').style.display = isStairs ? 'block' : 'none';
  if (isStairs) {
    const dir = obj.data?.direction || 'up';
    document.getElementById('btn-stairs-direction').textContent =
      dir === 'up' ? 'UP ↑（クリックで DN に切替）' : 'DN ↓（クリックで UP に切替）';
  }

  // Per-object snap toggle
  const snapDisabled = obj.data?.snapDisabled || false;
  const $snapToggle = document.getElementById('prop-snap-toggle');
  const $snapLabel  = document.getElementById('prop-snap-label');
  $snapToggle.checked    = !snapDisabled;
  $snapLabel.textContent = snapDisabled ? 'OFF' : 'ON';

  // Swatches
  syncFillSwatches(obj.fill);
  syncStrokeSwatches(obj.stroke);
}

function clearPropsPanel() {
  $propsEmpty.style.display   = 'block';
  $propsContent.style.display = 'none';
}

// Returns the room rect whether the selection is the rect itself or its label
function getActiveRoom() {
  const obj = canvas.getActiveObject();
  if (!obj) return null;
  if (obj.data?.type === 'room') return obj;
  if (obj.data?.type === 'room-label') return getLinkedRect(obj);
  return null;
}

function getLinkedRect(labelObj) {
  return canvas.getObjects().find(o => o._uid === labelObj._linkedRectId) || null;
}

// Room label / tatami
$propLabel.addEventListener('input', () => {
  const rect = getActiveRoom();
  if (!rect) return;
  rect.data.label = $propLabel.value;
  updateRoomLabelText(rect);
});

function updateScaleInfo(obj) {
  const wM = (obj.getScaledWidth()  / GRID_SIZE * GRID_MM / 1000);
  const hM = (obj.getScaledHeight() / GRID_SIZE * GRID_MM / 1000);
  const sqm = wM * hM;
  const tatami = sqm / TATAMI_SQM;
  const wStr = wM.toFixed(2).replace(/\.?0+$/, '');
  const hStr = hM.toFixed(2).replace(/\.?0+$/, '');
  const sqmStr = sqm.toFixed(1);
  const tatamiStr = tatami.toFixed(1);
  document.getElementById('scale-info-text').textContent =
    `約${tatamiStr}畳 / ${sqmStr}㎡`;
}

document.getElementById('btn-apply-scale').addEventListener('click', () => {
  const rect = getActiveRoom();
  if (!rect) return;
  const wM = (rect.getScaledWidth()  / GRID_SIZE * GRID_MM / 1000);
  const hM = (rect.getScaledHeight() / GRID_SIZE * GRID_MM / 1000);
  const sqm = wM * hM;
  const tatami = sqm / TATAMI_SQM;
  const value = `約${tatami.toFixed(1)}畳 / ${sqm.toFixed(1)}㎡`;
  $propTatami.value   = value;
  rect.data.tatami    = value;
  updateRoomLabelText(rect);
  saveHistory();
});

$propTatami.addEventListener('input', () => {
  const rect = getActiveRoom();
  if (!rect) return;
  rect.data.tatami = $propTatami.value;
  updateRoomLabelText(rect);
});

// Manual font size override
$propLabelFontsize.addEventListener('change', () => {
  const rect = getActiveRoom();
  if (!rect) return;
  const fs = parseInt($propLabelFontsize.value, 10);
  if (!isNaN(fs) && fs >= 7 && fs <= 36) {
    rect.data.labelFontSize = fs;
    updateRoomLabelText(rect);
    saveHistory();
  }
});


function updateRoomLabelText(rectObj) {
  if (!rectObj._linkedLabelId) return;
  const lbl = canvas.getObjects().find(o => o._uid === rectObj._linkedLabelId);
  if (!lbl) return;
  const text = buildRoomLabel(rectObj.data.label, rectObj.data.tatami);
  const fs   = fitLabelFontSize(rectObj, text);
  lbl.set({ text, fontSize: fs });
  canvas.renderAll();
}

// Stairs direction toggle
document.getElementById('btn-stairs-direction').addEventListener('click', () => flipStairsDirection());


// 90° 回転ボタン（↺ ↻）
function rotateBy90(dir) {
  const obj = canvas.getActiveObject();
  if (!obj) return;
  const current = obj.angle || 0;
  const next    = ((current + dir * 90) % 360 + 360) % 360;
  obj.set({ angle: next });
  if ($propAngle) $propAngle.value = next;
  canvas.fire('object:modified', { target: obj });
}

document.getElementById('btn-rotate-ccw').addEventListener('click', () => rotateBy90(-1));
document.getElementById('btn-rotate-cw' ).addEventListener('click', () => rotateBy90(+1));

// 水平・垂直に戻す：現在角度を最も近い 0/90/180/270° にスナップ
function snapAngleToNearest90() {
  const obj = canvas.getActiveObject();
  if (!obj) return;
  const snapped = Math.round((obj.angle || 0) / 90) * 90 % 360;
  obj.set({ angle: snapped });
  if ($propAngle) $propAngle.value = snapped;
  canvas.fire('object:modified', { target: obj });
}

document.getElementById('btn-snap-angle').addEventListener('click', snapAngleToNearest90);

// Flip buttons
document.getElementById('btn-flip-h').addEventListener('click', () => {
  const obj = canvas.getActiveObject();
  if (!obj) return;
  // 階段の左右反転もテキストが鏡像になるため、方向切替で代替
  if (obj.data?.type === 'stairs') { flipStairsDirection(); return; }
  obj.set({ flipX: !obj.flipX });
  canvas.renderAll();
  canvas.fire('object:modified', { target: obj });
});

document.getElementById('btn-flip-v').addEventListener('click', () => {
  const obj = canvas.getActiveObject();
  if (!obj) return;
  // 階段の上下反転 = UP/DN の切替（flipY だとテキストが逆さになるため再生成）
  if (obj.data?.type === 'stairs') { flipStairsDirection(); return; }
  obj.set({ flipY: !obj.flipY });
  canvas.renderAll();
  canvas.fire('object:modified', { target: obj });
});


// -------------------------------------------------------
// Color picker — trigger toggle + swatch selection
// -------------------------------------------------------
function _cpickOpen(dropdownId) {
  // 他方を閉じる
  ['fill-cpick-dropdown', 'stroke-cpick-dropdown'].forEach(id => {
    if (id !== dropdownId)
      document.getElementById(id).classList.remove('open');
  });
  document.getElementById(dropdownId).classList.toggle('open');
}

// 外クリックで閉じる
document.addEventListener('click', (e) => {
  if (!e.target.closest('.cpick-wrap')) {
    document.querySelectorAll('.cpick-dropdown').forEach(d => d.classList.remove('open'));
  }
});

document.getElementById('fill-cpick-trigger').addEventListener('click', (e) => {
  e.stopPropagation();
  _cpickOpen('fill-cpick-dropdown');
});
document.getElementById('stroke-cpick-trigger').addEventListener('click', (e) => {
  e.stopPropagation();
  _cpickOpen('stroke-cpick-dropdown');
});

// Fill swatches
document.getElementById('fill-cpick-dropdown').addEventListener('click', (e) => {
  const sw = e.target.closest('.prop-color-swatch');
  if (!sw) return;
  document.querySelectorAll('#fill-cpick-dropdown .prop-color-swatch')
    .forEach(s => s.classList.remove('selected'));
  sw.classList.add('selected');
  document.getElementById('fill-cpick-dropdown').classList.remove('open');
  const obj = canvas.getActiveObject();
  if (!obj) return;
  obj.set({ fill: sw.dataset.color });
  canvas.renderAll();
  canvas.fire('object:modified', { target: obj });
});

// Stroke swatches
document.getElementById('stroke-cpick-dropdown').addEventListener('click', (e) => {
  const sw = e.target.closest('.prop-color-swatch');
  if (!sw) return;
  document.querySelectorAll('#stroke-cpick-dropdown .prop-color-swatch')
    .forEach(s => s.classList.remove('selected'));
  sw.classList.add('selected');
  document.getElementById('stroke-cpick-dropdown').classList.remove('open');
  const obj = canvas.getActiveObject();
  if (!obj) return;
  obj.set({ stroke: sw.dataset.color });
  canvas.renderAll();
  canvas.fire('object:modified', { target: obj });
});

function _cpickSetTrigger(previewId, labelId, color, label) {
  const preview = document.getElementById(previewId);
  const lbl     = document.getElementById(labelId);
  if (!preview || !lbl) return;
  if (color === 'transparent') {
    preview.style.background = 'repeating-linear-gradient(45deg,#ccc 0,#ccc 2px,#fff 0,#fff 50%) 0/8px 8px';
  } else {
    preview.style.background = color;
  }
  lbl.textContent = label || color;
}

function syncFillSwatches(color) {
  let activeLabel = color;
  document.querySelectorAll('#fill-cpick-dropdown .prop-color-swatch').forEach(s => {
    const match = s.dataset.color === color;
    s.classList.toggle('selected', match);
    if (match) activeLabel = s.dataset.label || color;
  });
  _cpickSetTrigger('fill-cpick-preview', 'fill-cpick-label', color, activeLabel);
}

function syncStrokeSwatches(color) {
  let activeLabel = color;
  document.querySelectorAll('#stroke-cpick-dropdown .prop-color-swatch').forEach(s => {
    const match = s.dataset.color === color;
    s.classList.toggle('selected', match);
    if (match) activeLabel = s.dataset.label || color;
  });
  _cpickSetTrigger('stroke-cpick-preview', 'stroke-cpick-label', color, activeLabel);
}

// -------------------------------------------------------
// Keyboard shortcuts
// -------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
  // Don't fire when IText is in edit mode
  const active = canvas.getActiveObject();
  if (active && (active.isEditing)) return;

  const k = e.key.toLowerCase();

  if (e.ctrlKey || e.metaKey) {
    if (k === 'z') { e.preventDefault(); undo(); return; }
    if (k === 'y') { e.preventDefault(); redo(); return; }
    if (k === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if (k === 's') { e.preventDefault(); saveProject(); return; }
  }

  const keyMap = { v:'select', r:'room', p:'poly', w:'wall', d:'door', n:'window', s:'stairs', t:'text' };
  if (keyMap[k] && !e.ctrlKey) { setTool(keyMap[k]); return; }

  // [ / ] で 90° 回転、0 で水平/垂直に正規化
  if (e.key === '[') { e.preventDefault(); rotateBy90(-1);        return; }
  if (e.key === ']') { e.preventDefault(); rotateBy90(+1);        return; }
  if (e.key === '0') { e.preventDefault(); snapAngleToNearest90(); return; }

  // 矢印キー移動: 通常=1px微調整, Shift=1グリッド(455mm)
  if (['arrowup','arrowdown','arrowleft','arrowright'].includes(k)) {
    const objs = canvas.getActiveObjects();
    if (objs.length) {
      e.preventDefault();
      const step = e.shiftKey ? GRID_SIZE : 1;
      const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
      const dy = k === 'arrowup'   ? -step : k === 'arrowdown'  ? step : 0;
      objs.forEach(obj => {
        obj.set({ left: obj.left + dx, top: obj.top + dy });
        if (obj.data?.type === 'room') { syncLabel(obj); syncWetFurniture(obj); }
      });
      canvas.requestRenderAll();
      saveHistory();
    }
    return;
  }

  if (k === 'delete' || k === 'backspace') { deleteSelected(); return; }
  if (k === 'escape') {
    setTool('select');
    canvas.discardActiveObject();
    canvas.renderAll();
  }
  if (k === 'enter' && currentTool === 'poly' && poly.active) {
    e.preventDefault();
    closePolygon();
  }
});

// -------------------------------------------------------
// Duplicate (Ctrl+D)
// -------------------------------------------------------
function duplicateSelected() {
  const objs = canvas.getActiveObjects();
  if (!objs.length) return;
  canvas.discardActiveObject();

  const clones = [];
  let done = 0;

  objs.forEach(obj => {
    // Skip labels (they'll be re-created with rooms)
    if (obj.data?.type === 'room-label') { done++; return; }

    obj.clone((cloned) => {
      const newId = uid();
      cloned.set({ left: obj.left + GRID_SIZE * 2, top: obj.top + GRID_SIZE * 2 });
      cloned._uid = newId;

      if (obj.data?.type === 'room') {
        cloned._linkedLabelId = newId + '_lbl';
        cloned.data = { ...obj.data };
        canvas.add(cloned);

        const lblSrc = canvas.getObjects().find(o => o._uid === obj._linkedLabelId);
        const furSrc = obj._wetFurnitureId
          ? canvas.getObjects().find(o => o._uid === obj._wetFurnitureId) : null;
        if (lblSrc) {
          lblSrc.clone((lblClone) => {
            lblClone._uid = newId + '_lbl';
            lblClone._linkedRectId = newId;
            lblClone.data = { ...lblSrc.data, linkedRectId: newId };
            lblClone.set({
              left: cloned.left + cloned.getScaledWidth()  / 2,
              top:  cloned.top  + cloned.getScaledHeight() / 2,
            });
            canvas.add(lblClone);

            if (furSrc) {
              const furNewId = uid();
              furSrc.clone((furClone) => {
                furClone._uid = furNewId;
                furClone.data = { ...furSrc.data };
                furClone.set({
                  left: furSrc.left + GRID_SIZE * 2,
                  top:  furSrc.top  + GRID_SIZE * 2,
                  selectable: false,
                  evented:    false,
                });
                canvas.add(furClone);
                cloned._wetFurnitureId        = furNewId;
                cloned._wetFurnitureOffset    = { ...obj._wetFurnitureOffset };
                cloned._wetFurnitureInitAngle = obj._wetFurnitureInitAngle;
                clones.push(cloned);
                done++;
                if (done === objs.length) finalizeDuplicate(clones);
              }, ['data', '_uid']);
            } else {
              clones.push(cloned);
              done++;
              if (done === objs.length) finalizeDuplicate(clones);
            }
          }, ['data', '_uid', '_linkedRectId']);
          return;
        }
      } else {
        canvas.add(cloned);
      }
      clones.push(cloned);
      done++;
      if (done === objs.length) finalizeDuplicate(clones);
    }, ['data', '_uid', '_linkedLabelId', '_linkedRectId']);
  });
}

function finalizeDuplicate(clones) {
  if (!clones.length) return;
  const sel = new fabric.ActiveSelection(clones, { canvas });
  canvas.setActiveObject(sel);
  updateObjectCount();
  canvas.renderAll();
  saveHistory();
}

// -------------------------------------------------------
// Save / Export / Open
// -------------------------------------------------------

// ----- JSON Save (Ctrl+S) -----
function saveProject() {
  const name = document.getElementById('filename-input').value || '間取り図';
  const json = JSON.stringify(
    canvas.toJSON(['data', '_uid', '_linkedLabelId', '_linkedRectId', '_wetFurnitureId', '_wetFurnitureOffset', '_wetFurnitureInitAngle', '_wetFurnitureType']), null, 2
  );
  downloadBlob(`${name}.json`, json, 'application/json');
  isDirty = false;
  showToast('編集データをダウンロードしました');
}

window.addEventListener('beforeunload', (e) => {
  if (!isDirty) return;
  e.preventDefault();
});
document.getElementById('btn-save').addEventListener('click', saveProject);

// ----- JSON Open -----
document.getElementById('btn-open').addEventListener('click', () => {
  document.getElementById('file-input-json').value = '';
  document.getElementById('file-input-json').click();
});

document.getElementById('file-input-json').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const jsonStr = ev.target.result;
      JSON.parse(jsonStr); // validate before loading
      undoStack = [];
      redoStack = [];
      loadState(jsonStr);
      const fname = file.name.replace(/\.json$/i, '');
      document.getElementById('filename-input').value = fname;
    } catch {
      alert('ファイルの読み込みに失敗しました。正しいJSONファイルを選択してください。');
    }
  };
  reader.readAsText(file);
});

// ----- PNG Export (即ダウンロード: 1×・トリミングあり) -----
document.getElementById('btn-export-png').addEventListener('click', () => {
  exportPng(1, true);
});

function exportPng(multiplier, trim) {
  const name   = document.getElementById('filename-input').value || '間取り図';
  const wasVis = gridVisible;
  gridVisible  = false;

  // ズーム・パン状態に関わらず正確なバウンディングボックスを得るため
  // ビューポートを一時的にリセットする
  const wasVP = [...canvas.viewportTransform];
  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);

  let opts = { format: 'png', multiplier };

  if (trim) {
    const contentObjs = canvas.getObjects().filter(o => !o._isGrid && !o._isPreview);
    if (contentObjs.length > 0) {
      const pad = 24;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      contentObjs.forEach(obj => {
        const b = obj.getBoundingRect(true);
        minX = Math.min(minX, b.left);
        minY = Math.min(minY, b.top);
        maxX = Math.max(maxX, b.left + b.width);
        maxY = Math.max(maxY, b.top + b.height);
      });
      opts.left   = minX - pad;
      opts.top    = minY - pad;
      opts.width  = (maxX + pad) - opts.left;
      opts.height = (maxY + pad) - opts.top;
    }
  }

  const dataURL = canvas.toDataURL(opts);

  // ビューポートを復元
  canvas.setViewportTransform(wasVP);
  gridVisible = wasVis;
  drawGrid();
  downloadDataURL(`${name}.png`, dataURL);
  showToast('画像をダウンロードしました');
}


function downloadBlob(name, data, mime) {
  const a    = document.createElement('a');
  const blob = new Blob([data], { type: mime });
  a.href     = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadDataURL(name, dataURL) {
  const a    = document.createElement('a');
  a.href     = dataURL;
  a.download = name;
  a.click();
}

// ----- Toast notification -----
function showToast(message, type = 'success', duration = 2500) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = type === 'success' ? '✓' : '✕';

  const text = document.createElement('span');
  text.textContent = message;

  toast.appendChild(icon);
  toast.appendChild(text);
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

// ----- Welcome overlay -----
function updateWelcomeOverlay(n) {
  const el = document.getElementById('welcome-overlay');
  if (!el) return;
  if (n === 0) {
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

document.getElementById('welcome-btn-template').addEventListener('click', () => {
  document.getElementById('welcome-overlay').classList.add('hidden');
  document.getElementById('btn-template').click();
});

document.getElementById('welcome-btn-dismiss').addEventListener('click', () => {
  document.getElementById('welcome-overlay').classList.add('hidden');
});

// -------------------------------------------------------
// Undo/Redo buttons
// -------------------------------------------------------
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);

// -------------------------------------------------------
// Grid / Snap toggles
// -------------------------------------------------------
document.getElementById('toggle-grid').addEventListener('change', (e) => {
  gridVisible = e.target.checked;
  drawGrid();
});
document.getElementById('toggle-snap').addEventListener('change', (e) => {
  snapEnabled = e.target.checked;
});

// -------------------------------------------------------
// Templates
// -------------------------------------------------------
// テンプレートの部屋サイズは 1グリッド=455mm（半間）に基づく実寸スケール
// 畳数計算: w × h × (0.455²/1.62) = w × h × 0.1277
// 6畳=8×6, 8畳=9×7, 10畳=10×8, 14畳=14×8
const TEMPLATES = [
  {
    id: '1k', name: '1K', desc: '約22㎡ · 1部屋',
    rooms: [
      // 洋室 8×6 → 3.64m×2.73m = 9.94㎡ = 6.1畳
      { label:'洋室',     abbrev:'洋室', tatami:'6畳', x:0, y:0,  w:8, h:6 },
      { label:'キッチン', abbrev:'K',    tatami:'',    x:0, y:6,  w:8, h:3 },
      { label:'浴室',     abbrev:'浴',   tatami:'',    x:8, y:0,  w:4, h:4, fill:'#dbeafe' },
      { label:'トイレ',   abbrev:'ト',   tatami:'',    x:8, y:4,  w:2, h:4 },
      { label:'洗面所',   abbrev:'洗',   tatami:'',    x:10,y:4,  w:2, h:4 },
      { label:'玄関',     abbrev:'玄関', tatami:'',    x:0, y:9,  w:12,h:2, fill:'#f3f0e8' },
    ]
  },
  {
    id: '1ldk', name: '1LDK', desc: '約35㎡ · 1部屋+LDK',
    rooms: [
      // LDK 9×7 → 4.10m×3.19m = 13.05㎡ = 8.1畳
      { label:'LDK',    abbrev:'LDK',  tatami:'8畳', x:0, y:0,  w:9,  h:7 },
      // 洋室 8×6 → 9.94㎡ = 6.1畳
      { label:'洋室',   abbrev:'洋室', tatami:'6畳', x:0, y:7,  w:8,  h:6 },
      { label:'浴室',   abbrev:'浴',   tatami:'',    x:9, y:0,  w:4,  h:4, fill:'#dbeafe' },
      { label:'洗面所', abbrev:'洗',   tatami:'',    x:9, y:4,  w:4,  h:3 },
      { label:'トイレ', abbrev:'ト',   tatami:'',    x:9, y:7,  w:4,  h:6 },
      { label:'玄関',   abbrev:'玄関', tatami:'',    x:0, y:13, w:13, h:2, fill:'#f3f0e8' },
    ]
  },
  {
    id: '2ldk', name: '2LDK', desc: '約45㎡ · 2部屋+LDK',
    rooms: [
      // LDK 10×8 → 4.55m×3.64m = 16.56㎡ = 10.2畳
      { label:'LDK',    abbrev:'LDK',  tatami:'10畳', x:0,  y:0,  w:10, h:8 },
      // 洋室 7×7 → 3.19m×3.19m = 10.16㎡ = 6.3畳
      { label:'洋室①', abbrev:'洋①',  tatami:'6畳',  x:0,  y:8,  w:7,  h:7 },
      { label:'洋室②', abbrev:'洋②',  tatami:'6畳',  x:7,  y:8,  w:7,  h:7 },
      { label:'浴室',   abbrev:'浴',   tatami:'',     x:10, y:0,  w:4,  h:4, fill:'#dbeafe' },
      { label:'洗面所', abbrev:'洗',   tatami:'',     x:10, y:4,  w:4,  h:2 },
      { label:'トイレ', abbrev:'ト',   tatami:'',     x:10, y:6,  w:4,  h:2 },
      { label:'玄関',   abbrev:'玄関', tatami:'',     x:0,  y:15, w:14, h:2, fill:'#f3f0e8' },
    ]
  },
  {
    id: '3ldk', name: '3LDK', desc: '約65㎡ · 3部屋+LDK',
    rooms: [
      // LDK 14×8 → 6.37m×3.64m = 23.2㎡ = 14.3畳
      { label:'LDK',    abbrev:'LDK',  tatami:'14畳', x:0,  y:0,  w:14, h:8 },
      // 洋室 6×8 → 2.73m×3.64m = 9.94㎡ = 6.1畳
      { label:'洋室①', abbrev:'洋①',  tatami:'6畳',  x:0,  y:8,  w:6,  h:8 },
      { label:'洋室②', abbrev:'洋②',  tatami:'6畳',  x:6,  y:8,  w:6,  h:8 },
      { label:'洋室③', abbrev:'洋③',  tatami:'6畳',  x:12, y:8,  w:6,  h:8 },
      { label:'浴室',   abbrev:'浴',   tatami:'',     x:14, y:0,  w:4,  h:4, fill:'#dbeafe' },
      { label:'洗面所', abbrev:'洗',   tatami:'',     x:14, y:4,  w:4,  h:2 },
      { label:'トイレ', abbrev:'ト',   tatami:'',     x:14, y:6,  w:4,  h:2 },
      { label:'玄関',   abbrev:'玄関', tatami:'',     x:0,  y:16, w:18, h:2, fill:'#f3f0e8' },
    ]
  },
];

function buildTemplateSVG(tpl) {
  const PAD = 8, PW = 220, PH = 170;
  let maxX = 0, maxY = 0;
  tpl.rooms.forEach(r => { maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h); });
  const scale = Math.min((PW - PAD * 2) / maxX, (PH - PAD * 2) / maxY);
  const ox = PAD + ((PW - PAD * 2) - maxX * scale) / 2;
  const oy = PAD + ((PH - PAD * 2) - maxY * scale) / 2;

  let defs = '<defs>';
  let rects = '', texts = '';

  tpl.rooms.forEach((r, i) => {
    const rx = ox + r.x * scale;
    const ry = oy + r.y * scale;
    const rw = r.w * scale;
    const rh = r.h * scale;
    const text = r.abbrev || r.label;
    // フォントサイズ: 短縮ラベルが収まる最大サイズ（上限10px）
    const fs = Math.min(10, (rw - 2) / text.length, (rh - 2) * 0.7);
    const clipId = `tc${i}`;
    defs += `<clipPath id="${clipId}"><rect x="${(rx+1).toFixed(1)}" y="${(ry+1).toFixed(1)}" width="${(rw-2).toFixed(1)}" height="${(rh-2).toFixed(1)}"/></clipPath>`;
    rects += `<rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${rw.toFixed(1)}" height="${rh.toFixed(1)}" fill="${r.fill || '#ffffff'}" stroke="#374151" stroke-width="1"/>`;
    const tx = (rx + rw / 2).toFixed(1);
    const ty = (ry + rh / 2 + fs * 0.38).toFixed(1);
    texts += `<text clip-path="url(#${clipId})" x="${tx}" y="${ty}" text-anchor="middle" font-size="${fs.toFixed(1)}" fill="#374151" font-family="sans-serif">${text}</text>`;
  });

  defs += '</defs>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${PH}" viewBox="0 0 ${PW} ${PH}">${defs}${rects}${texts}</svg>`;
}

function applyTemplate(tpl) {
  document.getElementById('modal-template').style.display = 'none';

  const nonGrid = canvas.getObjects().filter(o => !o._isGrid);
  if (nonGrid.length > 0) {
    if (!confirm('現在のキャンバスをクリアしてテンプレートを適用しますか？')) return;
    nonGrid.forEach(o => canvas.remove(o));
  }

  // テンプレート全体をキャンバス中央に配置
  let maxX = 0, maxY = 0;
  tpl.rooms.forEach(r => { maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h); });
  const tplW = maxX * GRID_SIZE;
  const tplH = maxY * GRID_SIZE;
  const vpt = canvas.viewportTransform;
  const visW = canvas.width  / vpt[0];
  const visH = canvas.height / vpt[3];
  const offsetX = snap(Math.max(GRID_SIZE * 2, (visW - tplW) / 2));
  const offsetY = snap(Math.max(GRID_SIZE * 2, (visH - tplH) / 2));

  historyPaused = true;
  tpl.rooms.forEach(r => {
    const rect = addRoom(
      offsetX + r.x * GRID_SIZE,
      offsetY + r.y * GRID_SIZE,
      r.w * GRID_SIZE,
      r.h * GRID_SIZE,
      r.label, r.tatami || ''
    );
    if (r.fill) rect.set({ fill: r.fill });
  });
  historyPaused = false;

  canvas.discardActiveObject();
  canvas.renderAll();
  saveHistory();
  setTool('select');
}

document.getElementById('btn-template').addEventListener('click', () => {
  const grid = document.getElementById('template-grid');
  grid.innerHTML = '';
  TEMPLATES.forEach(tpl => {
    const card = document.createElement('div');
    card.className = 'template-card';
    card.innerHTML =
      buildTemplateSVG(tpl) +
      `<div class="template-card-name">${tpl.name}</div>` +
      `<div class="template-card-desc">${tpl.desc}</div>`;
    card.addEventListener('click', () => applyTemplate(tpl));
    grid.appendChild(card);
  });
  document.getElementById('modal-template').style.display = 'flex';
});

document.getElementById('modal-template-cancel').addEventListener('click', () => {
  document.getElementById('modal-template').style.display = 'none';
});

// -------------------------------------------------------
// Init
// -------------------------------------------------------
setTool('select');
syncUndoButtons();

// -------------------------------------------------------
// Phase 5: AI Upload & Gemini Integration
// -------------------------------------------------------

const GEMINI_MODEL = 'gemini-2.5-flash';

// 20×20 整数グリッド座標系で出力させる
const GEMINI_PROMPT = `あなたは建築図面解析AIです。添付の手描き間取り図を解析し、指定のJSON形式で出力してください。

【座標系】
画像全体を 20×20 のグリッドに分割して考えてください。
- x: 左端=0、右端=20（整数のみ）
- y: 上端=0、下端=20（整数のみ）
- 部屋の x/y は左上角のグリッド座標、w/h はグリッド単位のサイズ

【出力例】
LDK（左上）＋寝室（右上）＋浴室（右下）＋玄関（下中央）の場合：
{
  "rooms": [
    { "label": "LDK",  "tatami": "12畳", "x": 0,  "y": 0,  "w": 10, "h": 8 },
    { "label": "寝室", "tatami": "6畳",  "x": 10, "y": 0,  "w": 10, "h": 8 },
    { "label": "浴室", "tatami": "",     "x": 14, "y": 8,  "w": 6,  "h": 6 },
    { "label": "玄関", "tatami": "",     "x": 8,  "y": 14, "w": 4,  "h": 6 }
  ],
  "doors": [
    { "x": 9, "y": 2, "angle": 90 }
  ],
  "windows": [
    { "x": 2, "y": 0, "w": 4, "angle": 0 }
  ],
  "stairs": []
}

【ルール】
- rooms: すべての部屋・空間を漏れなく検出。label は日本語（不明なら「部屋」）。tatami は畳数や面積（不明なら ""）。部屋同士が重ならないよう注意。
- doors: ドアのヒンジ側グリッド座標。angle は 0/90/180/270。
- windows: 窓の左端グリッド座標と幅 w。angle は 0（横壁）または 90（縦壁）。
- stairs: 階段の左上グリッド座標とサイズ。direction は "up" または "dn"。
- 壁は出力不要（部屋の輪郭から自明なため）。
- 検出できない要素は空配列。`;

// Gemini structured output 用 JSON Schema
const GEMINI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    rooms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label:  { type: 'string' },
          tatami: { type: 'string' },
          x: { type: 'integer' }, y: { type: 'integer' },
          w: { type: 'integer' }, h: { type: 'integer' },
        },
        required: ['label', 'tatami', 'x', 'y', 'w', 'h'],
      },
    },
    doors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          x: { type: 'integer' }, y: { type: 'integer' },
          angle: { type: 'integer' },
        },
        required: ['x', 'y', 'angle'],
      },
    },
    windows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          x: { type: 'integer' }, y: { type: 'integer' },
          w: { type: 'integer' }, angle: { type: 'integer' },
        },
        required: ['x', 'y', 'w', 'angle'],
      },
    },
    stairs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          x: { type: 'integer' }, y: { type: 'integer' },
          w: { type: 'integer' }, h: { type: 'integer' },
          direction: { type: 'string' },
        },
        required: ['x', 'y', 'w', 'h', 'direction'],
      },
    },
  },
  required: ['rooms', 'doors', 'windows', 'stairs'],
};

// ----- API Key management -----
function getApiKey()      { return localStorage.getItem('gemini-api-key') || ''; }
function storeApiKey(key) { localStorage.setItem('gemini-api-key', key.trim()); }

function promptApiKey() {
  return new Promise((resolve, reject) => {
    const modal     = document.getElementById('modal-apikey');
    const input     = document.getElementById('apikey-input');
    const btnOk     = document.getElementById('modal-apikey-ok');
    const btnCancel = document.getElementById('modal-apikey-cancel');

    input.value = getApiKey();
    modal.style.display = 'flex';
    setTimeout(() => input.focus(), 50);

    function onOk() {
      const key = input.value.trim();
      if (!key) { input.focus(); return; }
      storeApiKey(key);
      modal.style.display = 'none';
      cleanup();
      resolve(key);
    }
    function onCancel() {
      modal.style.display = 'none';
      cleanup();
      reject(new Error('cancelled'));
    }
    function cleanup() {
      btnOk.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onEnter);
    }
    function onEnter(e) { if (e.key === 'Enter') onOk(); }

    btnOk.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
    input.addEventListener('keydown', onEnter);
  });
}

document.getElementById('btn-api-settings').addEventListener('click', () => {
  promptApiKey().catch(() => {});
});

// ----- Upload overlay -----
let selectedImageFile = null;

function initUploadMode() {
  const overlay      = document.getElementById('upload-overlay');
  const dropzone     = document.getElementById('upload-dropzone');
  const fileInput    = document.getElementById('file-input-image');
  const btnPick      = document.getElementById('btn-pick-image');
  const btnSkip      = document.getElementById('btn-skip-upload');
  const btnChange    = document.getElementById('btn-change-image');
  const btnAnalyze   = document.getElementById('btn-analyze');
  const idleView     = document.getElementById('upload-idle');
  const previewView  = document.getElementById('upload-preview');
  const previewImg   = document.getElementById('preview-img');

  overlay.style.display = 'flex';

  btnPick.addEventListener('click',   () => fileInput.click());
  btnChange.addEventListener('click', () => fileInput.click());
  btnSkip.addEventListener('click',   () => { overlay.style.display = 'none'; });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) showPreview(file);
  });

  // Drag & drop
  dropzone.addEventListener('dragover',  (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', ()  => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) showPreview(file);
  });

  function showPreview(file) {
    selectedImageFile = file;
    const url = URL.createObjectURL(file);
    previewImg.src = url;
    idleView.style.display    = 'none';
    previewView.style.display = 'block';
  }

  btnAnalyze.addEventListener('click', async () => {
    if (!selectedImageFile) return;
    let apiKey = getApiKey();
    if (!apiKey) {
      try { apiKey = await promptApiKey(); }
      catch { return; }
    }
    await runAnalysis(selectedImageFile, apiKey);
  });
}

// ----- Gemini API call -----
async function runAnalysis(file, apiKey) {
  const analyzingModal = document.getElementById('modal-analyzing');
  analyzingModal.style.display = 'flex';

  try {
    const base64   = await fileToBase64(file);
    const mimeType = file.type || 'image/jpeg';
    const text     = await callGemini(apiKey, base64, mimeType);
    const data     = parseFloorPlanJson(text);

    document.getElementById('upload-overlay').style.display = 'none';
    analyzingModal.style.display = 'none';

    placeFloorPlanObjects(data);
    saveHistory();

  } catch (err) {
    analyzingModal.style.display = 'none';
    if (err.message === 'cancelled') return;
    if (err.message === 'invalid_key') {
      alert('API キーが無効です。設定を確認してください。');
      promptApiKey().catch(() => {});
    } else if (err.message === 'quota_exceeded') {
      alert('Gemini API の利用上限に達しています。\n\nしばらく待ってから再試行するか、Google AI Studio でクォータをご確認ください。');
    } else {
      alert(`解析に失敗しました。\n\n${err.message}`);
    }
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = (e) => resolve(e.target.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function callGemini(apiKey, base64, mimeType) {
  const url  = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      parts: [
        { inlineData: { mimeType, data: base64 } },
        { text: GEMINI_PROMPT }
      ]
    }],
    generationConfig: {
      temperature:      0,
      responseMimeType: 'application/json',
      responseSchema:   GEMINI_RESPONSE_SCHEMA,
    },
  };

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new Error('invalid_key');
  }
  if (res.status === 429) {
    throw new Error('quota_exceeded');
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `HTTP ${res.status}`);
  }

  const json = await res.json();
  return json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function parseFloorPlanJson(text) {
  // structured output なので通常はそのままパース可能、念のためフェンス除去も行う
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const match   = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AIの応答からJSONを解析できませんでした。\n\n応答内容:\n' + text.slice(0, 300));
  return JSON.parse(match[0]);
}

// ----- Place AI objects onto canvas (20×20 grid coordinate system) -----
function placeFloorPlanObjects(data) {
  const G   = 20;   // grid divisions
  const PAD = 40;
  const cw  = canvas.width;
  const ch  = canvas.height;
  const ux  = (cw - PAD * 2) / G;  // pixels per grid unit (x)
  const uy  = (ch - PAD * 2) / G;  // pixels per grid unit (y)

  const gx = (v) => PAD + v * ux;
  const gy = (v) => PAD + v * uy;
  const gw = (v) => Math.max(v * ux, MIN_ROOM_SIZE);
  const gh = (v) => Math.max(v * uy, MIN_ROOM_SIZE);

  historyPaused = true;

  // Rooms
  (data.rooms || []).forEach(r => {
    addRoom(gx(r.x), gy(r.y), gw(r.w), gh(r.h), r.label || '部屋', r.tatami || '');
  });

  // Doors
  (data.doors || []).forEach(d => {
    addDoor(gx(d.x), gy(d.y));
    const obj = canvas.getActiveObject();
    if (obj && d.angle) obj.set({ angle: d.angle });
  });

  // Windows — scale width to match grid units
  (data.windows || []).forEach(w => {
    const targetW = gw(w.w || 2);
    const defaultW = GRID_SIZE * 5;
    addWindow(gx(w.x), gy(w.y));
    const obj = canvas.getActiveObject();
    if (obj) {
      obj.set({ scaleX: targetW / defaultW });
      if (w.angle) obj.set({ angle: w.angle });
    }
  });

  // Stairs — scale to match grid units
  (data.stairs || []).forEach(s => {
    const targetW  = gw(s.w || 3);
    const targetH  = gh(s.h || 5);
    const defaultW = GRID_SIZE * 5;
    const defaultH = GRID_SIZE * 8;
    const dir      = s.direction === 'dn' ? 'dn' : 'up';
    addStairs(gx(s.x), gy(s.y), dir);
    const obj = canvas.getActiveObject();
    if (obj) obj.set({ scaleX: targetW / defaultW, scaleY: targetH / defaultH });
  });

  historyPaused = false;
  updateObjectCount();
  canvas.discardActiveObject();
  canvas.renderAll();
}

// ----- Activate upload mode if URL param is set -----
if (new URLSearchParams(window.location.search).get('mode') === 'upload') {
  initUploadMode();
}
