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
const GRID_MM         = 910;   // 1グリッド = 910mm（日本建築モジュール）
const TATAMI_SQM      = 1.62;  // 1畳 = 1.62㎡（公団畳基準）
const ZOOM_STEP       = 0.1;
const ZOOM_MIN        = 0.2;
const ZOOM_MAX        = 4.0;
const GRID_COLOR      = '#c8c4bc';
const GRID_COLOR_MAJOR= '#aeaaa0';
const MIN_ROOM_SIZE   = GRID_SIZE * 2;  // 40px minimum

// -------------------------------------------------------
// State
// -------------------------------------------------------
let currentTool  = 'select';
let snapEnabled  = true;
let gridVisible  = true;
let undoStack    = [];
let redoStack    = [];
let historyPaused= false;
let uidCounter   = 0;
let isDirty      = false;

// Drawing state (drag-to-draw)
const draw = { active: false, preview: null, startPt: null };

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
// Grid
// -------------------------------------------------------
let gridLines = [];

function drawGrid() {
  gridLines.forEach(l => { l._isGrid = true; canvas.remove(l); });
  gridLines = [];
  if (!gridVisible) { canvas.renderAll(); return; }

  const zoom = canvas.getZoom();
  const vpt  = canvas.viewportTransform;
  const w    = canvas.getWidth();
  const h    = canvas.getHeight();
  const left = -vpt[4] / zoom;
  const top  = -vpt[5] / zoom;
  const startX = Math.floor(left / GRID_SIZE) * GRID_SIZE;
  const startY = Math.floor(top  / GRID_SIZE) * GRID_SIZE;
  const endX   = startX + w / zoom + GRID_SIZE;
  const endY   = startY + h / zoom + GRID_SIZE;

  for (let x = startX; x <= endX; x += GRID_SIZE) {
    const major = (x / GRID_SIZE) % 5 === 0;
    const l = new fabric.Line([x, startY, x, endY], {
      stroke: major ? GRID_COLOR_MAJOR : GRID_COLOR,
      strokeWidth: major ? 0.8 : 0.5,
      selectable: false, evented: false,
      excludeFromExport: true, _isGrid: true,
    });
    canvas.add(l);
    canvas.sendToBack(l);
    gridLines.push(l);
  }
  for (let y = startY; y <= endY; y += GRID_SIZE) {
    const major = (y / GRID_SIZE) % 5 === 0;
    const l = new fabric.Line([startX, y, endX, y], {
      stroke: major ? GRID_COLOR_MAJOR : GRID_COLOR,
      strokeWidth: major ? 0.8 : 0.5,
      selectable: false, evented: false,
      excludeFromExport: true, _isGrid: true,
    });
    canvas.add(l);
    canvas.sendToBack(l);
    gridLines.push(l);
  }
  canvas.renderAll();
}

drawGrid();
// 初期状態をスタックに積んでおく（最初のUndoが空キャンバスに戻れるように）
undoStack.push(captureState());

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
  return JSON.stringify(canvas.toJSON(['data', '_uid', '_linkedLabelId', '_linkedRectId', '_isGrid']));
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
  wall: '壁', door: 'ドア', window: '窓', stairs: '階段', text: 'テキスト',
  toilet: 'トイレ', bathtub: 'バスタブ', sink: '流し台',
  refrigerator: '冷蔵庫', washer: '洗濯機', stove: 'コンロ',
};

function setTool(name) {
  // Cancel any active drawing
  cancelDrawing();
  cancelWall();
  cancelPolyDraw();

  currentTool = name;

  document.querySelectorAll('.tool-btn[data-tool]').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === name);
  });

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
}

document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

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
}

function finishRoomDraw(pt) {
  if (!draw.active) return;
  const x = Math.min(draw.startPt.x, pt.x);
  const y = Math.min(draw.startPt.y, pt.y);
  const w = Math.abs(pt.x - draw.startPt.x);
  const h = Math.abs(pt.y - draw.startPt.y);

  canvas.remove(draw.preview);
  draw.active  = false;
  draw.preview = null;
  draw.startPt = null;

  if (w < MIN_ROOM_SIZE || h < MIN_ROOM_SIZE) return;

  addRoom(x, y, w, h);
  saveHistory();
}

function cancelDrawing() {
  if (draw.preview) { canvas.remove(draw.preview); canvas.renderAll(); }
  draw.active  = false;
  draw.preview = null;
  draw.startPt = null;
}

// -------------------------------------------------------
// Room object: Rect + IText (linked, not grouped)
// -------------------------------------------------------
function addRoom(x, y, w, h, labelText = '部屋', tatamiText = '') {
  const id = uid();

  const rect = new fabric.Rect({
    left: x, top: y, width: w, height: h,
    fill: '#ffffff', stroke: '#1a1a1a', strokeWidth: 2,
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
    fontSize:   13,
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

// Keep label centered on rect during move/scale/rotate
// getCenterPoint() is rotation-aware and always returns the visual center
function syncLabel(rectObj) {
  if (!rectObj._linkedLabelId) return;
  const lbl = canvas.getObjects().find(o => o._uid === rectObj._linkedLabelId);
  if (!lbl) return;
  const center = rectObj.getCenterPoint();
  lbl.set({ left: center.x, top: center.y });
  canvas.renderAll();
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
  if (e.target.data?.type === 'room') syncLabel(e.target);
});

// スケール中：ラベル同期のみ（スナップはしない）
// ※スケール途中に scaleX/Y を書き換えると Fabric.js の内部状態と衝突し
//   オブジェクトが飛ぶため、修正は mouse:up 後の object:modified で行う
canvas.on('object:scaling', (e) => {
  if (e.target.data?.type === 'room') syncLabel(e.target);
});

// 回転中：ラベル同期のみ（角度スナップは canvas.snapAngle に委譲）
canvas.on('object:rotating', (e) => {
  if (e.target.data?.type === 'room') syncLabel(e.target);
});

// マウスアップ後：スナップ・ラベル同期・履歴保存・パネル更新を一括処理
canvas.on('object:modified', (e) => {
  const obj = e.target;
  if (!obj || obj._isGrid) return;

  if (snapEnabled) {
    // 位置スナップ
    obj.set({
      left: snap(obj.left),
      top:  snap(obj.top),
    });

    // サイズスナップ（Line・テキスト以外）
    if (obj.type !== 'line' && obj.type !== 'i-text' && obj.type !== 'text') {
      const snappedW = Math.max(snap(obj.getScaledWidth()),  MIN_ROOM_SIZE);
      const snappedH = Math.max(snap(obj.getScaledHeight()), MIN_ROOM_SIZE);
      obj.set({
        scaleX: snappedW / obj.width,
        scaleY: snappedH / obj.height,
      });
    }

    canvas.renderAll();
  }

  if (obj.data?.type === 'room') syncLabel(obj);

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

// Delete room label when rect is removed
canvas.on('object:removed', (e) => {
  const obj = e.target;
  if (obj.data?.type === 'room' && obj._linkedLabelId) {
    const lbl = canvas.getObjects().find(o => o._uid === obj._linkedLabelId);
    if (lbl) canvas.remove(lbl);
  }
  updateObjectCount();
});

// -------------------------------------------------------
// Wall — drag to draw a single line segment
// -------------------------------------------------------
function startWallDraw(pt) {
  draw.startPt = pt;
  draw.preview = new fabric.Line([pt.x, pt.y, pt.x, pt.y], {
    stroke: '#1a1a1a', strokeWidth: 3,
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
    stroke: '#1a1a1a', strokeWidth: 3,
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
    fill: '#ffffff', stroke: '#1a1a1a', strokeWidth: 2,
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
    fontSize: 13, fontFamily: 'Inter, sans-serif',
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
// Door — click to place (quarter-circle swing symbol)
// -------------------------------------------------------
function addDoor(x, y) {
  const s = GRID_SIZE * 4; // 80px

  // Pie-slice path: hinge at (0,0), panel → (0,s), arc → (s,0), close
  // sweep-flag=0 (CCW in SVG) → 90° arc sweeping through bottom-right quadrant
  const door = new fabric.Path(
    `M 0 0 L 0 ${s} A ${s} ${s} 0 0 0 ${s} 0 Z`,
    {
      left:          x,
      top:           y,
      fill:          'rgba(186, 230, 253, 0.35)',
      stroke:        '#1a1a1a',
      strokeWidth:   2,
      strokeUniform: true, lockScalingFlip: true,
      data: { type: 'door', size: s },
      _uid: uid(),
    }
  );
  canvas.add(door);
  canvas.setActiveObject(door);
  updateObjectCount();
  canvas.renderAll();
  saveHistory();
}

// -------------------------------------------------------
// Window — click to place (wall-span rectangle with glass lines)
// -------------------------------------------------------
function addWindow(x, y) {
  const W = GRID_SIZE * 5; // 100px wide
  const H = GRID_SIZE;     // 20px  tall

  // Three objects: outer rect + two inner lines
  // Coordinates are absolute; Fabric.js centers the group automatically
  const outer = new fabric.Rect({
    left: 0, top: 0, width: W, height: H,
    fill: '#e0f2fe', stroke: '#1a1a1a', strokeWidth: 2,
    strokeUniform: true,
    originX: 'left', originY: 'top',
  });
  const lnTop = new fabric.Line([2, H * 0.33, W - 2, H * 0.33], {
    stroke: '#64748b', strokeWidth: 1, strokeUniform: true,
  });
  const lnBot = new fabric.Line([2, H * 0.67, W - 2, H * 0.67], {
    stroke: '#64748b', strokeWidth: 1, strokeUniform: true,
  });

  const grp = new fabric.Group([outer, lnTop, lnBot], {
    left: x, top: y,
    data: { type: 'window' },
    _uid: uid(),
    subTargetCheck: false,
    strokeUniform: true, lockScalingFlip: true,
  });
  canvas.add(grp);
  canvas.setActiveObject(grp);
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
  // Middle-mouse pan
  if (e.e.button === 1 || (e.e.button === 0 && e.e.altKey)) {
    startPan(e); return;
  }

  const pt = getPointer(e);

  switch (currentTool) {
    case 'room':
      if (!e.target) startRoomDraw(pt);
      break;
    case 'wall':
      if (!e.target) startWallDraw(pt);
      break;
    case 'door':
      if (!e.target) addDoor(pt.x, pt.y);
      setTool('select');
      break;
    case 'window':
      if (!e.target) addWindow(pt.x, pt.y);
      setTool('select');
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
  if (currentTool === 'room') updateRoomDraw(pt);
  if (currentTool === 'wall') updateWallDraw(pt);
  if (currentTool === 'poly') updatePolyGuide(pt);
});

canvas.on('mouse:up', (e) => {
  if (isPanning) { stopPan(); return; }
  const pt = getPointer(e);
  if (currentTool === 'room') finishRoomDraw(pt);
  if (currentTool === 'wall') finishWallDraw(pt);
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

document.getElementById('tool-delete').addEventListener('click', deleteSelected);

// -------------------------------------------------------
// Properties panel
// -------------------------------------------------------
const $propsEmpty   = document.getElementById('props-empty');
const $propsContent = document.getElementById('props-content');
const $propLabel    = document.getElementById('prop-label');
const $propTatami   = document.getElementById('prop-tatami');
const $propAngle    = document.getElementById('prop-angle');
const $typeBadge    = document.getElementById('prop-type-badge');

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
  $propAngle.step        = freeRotation ? 1   : 90;
  $propAngle.placeholder = freeRotation ? '0' : '0 / 90 / 180 / 270';
  $propAngle.value       = Math.round(obj.angle || 0);

  // Show/hide room fields
  const isRoom = objType === 'room';
  document.getElementById('prop-room-fields').style.display = isRoom ? 'block' : 'none';
  if (isRoom) {
    $propLabel.value  = obj.data.label  || '';
    $propTatami.value = obj.data.tatami || '';
    updateScaleInfo(obj);
  }
  document.getElementById('prop-scale-info').style.display = isRoom ? 'block' : 'none';

  // Show/hide stairs fields
  const isStairs = objType === 'stairs';
  document.getElementById('prop-stairs-fields').style.display = isStairs ? 'block' : 'none';
  if (isStairs) {
    const dir = obj.data?.direction || 'up';
    document.getElementById('btn-stairs-direction').textContent =
      dir === 'up' ? 'UP ↑（クリックで DN に切替）' : 'DN ↓（クリックで UP に切替）';
  }

  // Swatches
  syncFillSwatches(obj.fill);
  syncStrokeSwatches(obj.stroke);
}

function clearPropsPanel() {
  $propsEmpty.style.display   = 'block';
  $propsContent.style.display = 'none';
}

// Room label / tatami
$propLabel.addEventListener('input', () => {
  const obj = canvas.getActiveObject();
  if (!obj || obj.data?.type !== 'room') return;
  obj.data.label = $propLabel.value;
  updateRoomLabelText(obj);
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
    `${wStr}m × ${hStr}m ≈ ${sqmStr}㎡ / 約${tatamiStr}畳`;
}

document.getElementById('btn-apply-scale').addEventListener('click', () => {
  const obj = canvas.getActiveObject();
  if (!obj || obj.data?.type !== 'room') return;
  const wM = (obj.getScaledWidth()  / GRID_SIZE * GRID_MM / 1000);
  const hM = (obj.getScaledHeight() / GRID_SIZE * GRID_MM / 1000);
  const sqm = wM * hM;
  const tatami = sqm / TATAMI_SQM;
  const value = `約${tatami.toFixed(1)}畳 / ${sqm.toFixed(1)}㎡`;
  $propTatami.value   = value;
  obj.data.tatami     = value;
  updateRoomLabelText(obj);
  saveHistory();
});

$propTatami.addEventListener('input', () => {
  const obj = canvas.getActiveObject();
  if (!obj || obj.data?.type !== 'room') return;
  obj.data.tatami = $propTatami.value;
  updateRoomLabelText(obj);
});

function updateRoomLabelText(rectObj) {
  if (!rectObj._linkedLabelId) return;
  const lbl = canvas.getObjects().find(o => o._uid === rectObj._linkedLabelId);
  if (!lbl) return;
  lbl.set({ text: buildRoomLabel(rectObj.data.label, rectObj.data.tatami) });
  canvas.renderAll();
}

// Stairs direction toggle
document.getElementById('btn-stairs-direction').addEventListener('click', () => flipStairsDirection());

// Rotation（パネル手入力）
$propAngle.addEventListener('change', () => {
  const obj = canvas.getActiveObject();
  if (!obj) return;
  let angle = +$propAngle.value % 360;
  if (angle < 0) angle += 360;
  if (SNAP90_TYPES.has(obj.data?.type || obj.type)) {
    angle = Math.round(angle / 90) * 90;
    $propAngle.value = angle;
  }
  obj.set({ angle });
  // object:modified を手動発火して統合ハンドラ（スナップ・履歴）を呼ぶ
  canvas.fire('object:modified', { target: obj });
});

// 90° 回転ボタン（↺ ↻）
function rotateBy90(dir) {
  const obj = canvas.getActiveObject();
  if (!obj) return;
  const current = obj.angle || 0;
  const next    = ((current + dir * 90) % 360 + 360) % 360;
  obj.set({ angle: next });
  $propAngle.value = next;
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
  $propAngle.value = snapped;
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


// Fill swatches
document.getElementById('prop-fill-colors').addEventListener('click', (e) => {
  const sw = e.target.closest('.prop-color-swatch');
  if (!sw) return;
  document.querySelectorAll('#prop-fill-colors .prop-color-swatch')
    .forEach(s => s.classList.remove('selected'));
  sw.classList.add('selected');
  const obj = canvas.getActiveObject();
  if (!obj) return;
  obj.set({ fill: sw.dataset.color });
  canvas.renderAll();
  canvas.fire('object:modified', { target: obj });
});

// Stroke swatches
document.getElementById('prop-stroke-colors').addEventListener('click', (e) => {
  const sw = e.target.closest('.prop-color-swatch');
  if (!sw) return;
  document.querySelectorAll('#prop-stroke-colors .prop-color-swatch')
    .forEach(s => s.classList.remove('selected'));
  sw.classList.add('selected');
  const obj = canvas.getActiveObject();
  if (!obj) return;
  obj.set({ stroke: sw.dataset.color });
  canvas.renderAll();
  canvas.fire('object:modified', { target: obj });
});

function syncFillSwatches(color) {
  document.querySelectorAll('#prop-fill-colors .prop-color-swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === color);
  });
}

function syncStrokeSwatches(color) {
  document.querySelectorAll('#prop-stroke-colors .prop-color-swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === color);
  });
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

  if (k === 'delete' || k === 'backspace') { deleteSelected(); return; }
  if (k === 'escape') {
    cancelDrawing();
    cancelWall();
    cancelPolyDraw();
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
            clones.push(cloned);
            done++;
            if (done === objs.length) finalizeDuplicate(clones);
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
    canvas.toJSON(['data', '_uid', '_linkedLabelId', '_linkedRectId']), null, 2
  );
  downloadBlob(`${name}.json`, json, 'application/json');
  isDirty = false;
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
  gridLines.forEach(l => canvas.remove(l));
  gridLines    = [];

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
      opts.left   = Math.max(0, minX - pad);
      opts.top    = Math.max(0, minY - pad);
      opts.width  = Math.min(canvas.width  - opts.left, maxX + pad - opts.left);
      opts.height = Math.min(canvas.height - opts.top,  maxY + pad - opts.top);
    }
  }

  const dataURL = canvas.toDataURL(opts);
  gridVisible   = wasVis;
  drawGrid();
  downloadDataURL(`${name}.png`, dataURL);
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
const TEMPLATES = [
  {
    id: '1k', name: '1K', desc: '約20㎡ · 1部屋',
    rooms: [
      { label:'洋室',     abbrev:'洋室',  tatami:'6畳', x:0, y:0, w:8, h:6 },
      { label:'キッチン', abbrev:'K',     tatami:'',    x:0, y:6, w:5, h:3 },
      { label:'浴室',     abbrev:'浴',    tatami:'',    x:5, y:6, w:3, h:3, fill:'#dbeafe' },
      { label:'玄関',     abbrev:'玄関',  tatami:'',    x:0, y:9, w:8, h:2, fill:'#f3f0e8' },
    ]
  },
  {
    id: '1ldk', name: '1LDK', desc: '約30㎡ · 1部屋+LDK',
    rooms: [
      { label:'LDK',    abbrev:'LDK', tatami:'8畳', x:0, y:0,  w:10, h:7 },
      { label:'洋室',   abbrev:'洋室', tatami:'6畳', x:0, y:7,  w:6,  h:5 },
      { label:'浴室',   abbrev:'浴',  tatami:'',    x:6, y:7,  w:4,  h:3, fill:'#dbeafe' },
      { label:'洗面所', abbrev:'洗',  tatami:'',    x:6, y:10, w:2,  h:2 },
      { label:'トイレ', abbrev:'ト',  tatami:'',    x:8, y:10, w:2,  h:2 },
      { label:'玄関',   abbrev:'玄関', tatami:'',   x:0, y:12, w:10, h:2, fill:'#f3f0e8' },
    ]
  },
  {
    id: '2ldk', name: '2LDK', desc: '約50㎡ · 2部屋+LDK',
    rooms: [
      { label:'LDK',    abbrev:'LDK', tatami:'10畳', x:0, y:0,  w:12, h:7 },
      { label:'洋室①', abbrev:'洋①', tatami:'6畳',  x:0, y:7,  w:6,  h:6 },
      { label:'洋室②', abbrev:'洋②', tatami:'6畳',  x:6, y:7,  w:6,  h:6 },
      { label:'浴室',   abbrev:'浴',  tatami:'',     x:0, y:13, w:4,  h:3, fill:'#dbeafe' },
      { label:'洗面所', abbrev:'洗',  tatami:'',     x:4, y:13, w:3,  h:3 },
      { label:'トイレ', abbrev:'ト',  tatami:'',     x:7, y:13, w:2,  h:3 },
      { label:'玄関',   abbrev:'玄関', tatami:'',    x:9, y:13, w:3,  h:3, fill:'#f3f0e8' },
    ]
  },
  {
    id: '3ldk', name: '3LDK', desc: '約70㎡ · 3部屋+LDK',
    rooms: [
      { label:'LDK',    abbrev:'LDK', tatami:'14畳', x:0,  y:0,  w:14, h:7 },
      { label:'洋室①', abbrev:'洋①', tatami:'6畳',  x:0,  y:7,  w:5,  h:6 },
      { label:'洋室②', abbrev:'洋②', tatami:'6畳',  x:5,  y:7,  w:5,  h:6 },
      { label:'洋室③', abbrev:'洋③', tatami:'6畳',  x:10, y:7,  w:4,  h:6 },
      { label:'浴室',   abbrev:'浴',  tatami:'',     x:0,  y:13, w:4,  h:3, fill:'#dbeafe' },
      { label:'洗面所', abbrev:'洗',  tatami:'',     x:4,  y:13, w:3,  h:3 },
      { label:'トイレ', abbrev:'ト',  tatami:'',     x:7,  y:13, w:3,  h:3 },
      { label:'玄関',   abbrev:'玄関', tatami:'',    x:10, y:13, w:4,  h:3, fill:'#f3f0e8' },
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
