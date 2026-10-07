#!/usr/bin/env node
/* ============================================================================
   bake-emerald-assets.js

   Descarga los gráficos originales de Pokémon Esmeralda desde el proyecto de
   descompilación pret/pokeemerald, los decodifica (PNG indexado 4bpp + paletas
   JASC-PAL + tilemaps GBA) y genera `emerald-assets.css`: un único archivo con
   los assets embebidos como data URIs y la paleta del juego como variables.

   Uso:  node tools/bake-emerald-assets.js
         node tools/bake-emerald-assets.js --terrain long_grass --frame 4

   Los PNG intermedios se dejan en `emerald-assets/` para poder inspeccionarlos.

   NOTA LEGAL: los gráficos son propiedad de Nintendo / Game Freak / The Pokémon
   Company. pret/pokeemerald es una descompilación con fines de investigación.
   Sirven para un proyecto personal; no los redistribuyas públicamente.
   ========================================================================== */

'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('./gba-png.js');
const { Canvas, setPx, getPx, blit, upscale, crop, contentBox, toCanvas, hex } = G;

const REPO = 'https://raw.githubusercontent.com/pret/pokeemerald/master';
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, 'emerald-assets', '_src');
const OUTDIR = path.join(ROOT, 'emerald-assets');
const CSSOUT = path.join(ROOT, 'emerald-assets.css');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const TERRAIN = arg('terrain', 'tall_grass');   // tall_grass | long_grass | sand | rock | cave | ...
const FRAME = arg('frame', '1');                // 1..20, marcos de ventana de Esmeralda
const BG_W = +arg('width', 320);
const BG_H = +arg('height', 150);               // encuadre ancho: a 200 la arena queda medio vacía
const GROUND_FRAC = 0.16;                       // centro de plataforma, desde abajo

/* Índices de la paleta del marco que se dejan transparentes. El 0 es el color
   transparente del GBA. En el marco 1 los anillos, de fuera hacia dentro, son:
     0 = #62c562 (transparente)   1 = #293131   2 = #4a4a6a   3 = #736a83
   Los anillos 1 y 2 forman el reborde oscuro exterior. Se PUEDEN pelar con
   `--frame-strip 0,1,2`, pero no se hace por defecto: ese reborde es lo que da
   contraste contra el fondo oscuro de la página, y sin él las ventanas quedan
   planas y desvaídas. */
const FRAME_STRIP = String(arg('frame-strip', '0')).split(',').map(Number);

/* ==========================================================================
   Descarga con caché
   ========================================================================== */
fs.mkdirSync(CACHE, { recursive: true });
function src(repoPath) {
  const dest = path.join(CACHE, repoPath.replace(/\//g, '__'));
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return fs.readFileSync(dest);
  const r = spawnSync('curl', ['-sSL', '--max-time', '30', '-o', dest, REPO + '/' + repoPath], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(dest) || !fs.statSync(dest).size)
    throw new Error('no se pudo descargar ' + repoPath + ' ' + (r.stderr || ''));
  console.log('   descargado', repoPath);
  return fs.readFileSync(dest);
}
const srcPng = p => G.pngDecode(src(p));

/* ==========================================================================
   Terreno de combate: tiles.png + map.bin + palette.pal

   Los bancos de paleta del tilemap apuntan a slots de VRAM, no a offsets del
   fichero .pal; en los terrenos de Esmeralda las sub-paletas coinciden, así
   que basta mapear banco -> sub-paleta por orden de aparición.
   ========================================================================== */
function renderTerrain() {
  const tiles = srcPng(`graphics/battle_environment/${TERRAIN}/tiles.png`);
  const pal = G.readPalBuf(src(`graphics/battle_environment/${TERRAIN}/palette.pal`));
  const map = src(`graphics/battle_environment/${TERRAIN}/map.bin`);

  const banks = [...new Set(Array.from({ length: map.length / 2 },
    (_, i) => (map.readUInt16LE(i * 2) >> 12) & 15))].sort((a, b) => a - b);
  const subs = Math.max(1, Math.floor(pal.length / 16));
  const bankToSub = {};
  banks.forEach((b, i) => { bankToSub[b] = Math.min(i, subs - 1); });

  const mapW = 32, mapH = (map.length / 2) / mapW, tpr = tiles.width / 8;
  const c = Canvas(mapW * 8, mapH * 8);
  for (let ty = 0; ty < mapH; ty++)
    for (let tx = 0; tx < mapW; tx++) {
      const e = map.readUInt16LE((ty * mapW + tx) * 2);
      const tile = e & 0x3ff, hf = (e >> 10) & 1, vf = (e >> 11) & 1;
      const sub = bankToSub[(e >> 12) & 15];
      if (sub === undefined) continue;
      const sx = (tile % tpr) * 8, sy = ((tile / tpr) | 0) * 8;
      for (let py = 0; py < 8; py++)
        for (let px = 0; px < 8; px++) {
          const v = tiles.indices[(sy + (vf ? 7 - py : py)) * tiles.width + sx + (hf ? 7 - px : px)];
          if (v === 0) continue;                          // índice 0 = transparente
          setPx(c, tx * 8 + px, ty * 8 + py, pal[sub * 16 + v] || [255, 0, 255]);
        }
    }
  return c;
}

/* Plataforma del rival. El campo son franjas horizontales uniformes, así que
   una columna de campo puro da el perfil de colores de fondo; lo que no está en
   ese perfil es plataforma. De esos píxeles se toma la mayor componente conexa,
   para no arrastrar el arco de la plataforma del jugador. */
function extractPlatform(terrain) {
  const SCAN_H = 96;
  const field = new Set();
  for (let y = 0; y < SCAN_H; y++) {
    const p = getPx(terrain, 4, y);
    if (p[3]) field.add(p.slice(0, 3).join(','));
  }
  const W = terrain.w;
  const isPlat = new Uint8Array(W * SCAN_H);
  for (let y = 0; y < SCAN_H; y++)
    for (let x = 0; x < W; x++) {
      const p = getPx(terrain, x, y);
      if (p[3] && !field.has(p.slice(0, 3).join(','))) isPlat[y * W + x] = 1;
    }

  const seen = new Uint8Array(W * SCAN_H);
  let best = null;
  for (let sy = 0; sy < SCAN_H; sy++)
    for (let sx = 0; sx < W; sx++) {
      const s0 = sy * W + sx;
      if (!isPlat[s0] || seen[s0]) continue;
      const stack = [s0]; seen[s0] = 1;
      let n = 0, x0 = W, y0 = SCAN_H, x1 = -1, y1 = -1;
      while (stack.length) {
        const i = stack.pop(), x = i % W, y = (i / W) | 0;
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= SCAN_H) continue;
            const j = ny * W + nx;
            if (isPlat[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
          }
      }
      if (!best || n > best.n) best = { n, x0, y0, x1, y1 };
    }
  if (!best) throw new Error('no se encontró plataforma en el terreno ' + TERRAIN);

  const w = best.x1 - best.x0 + 1, h = best.y1 - best.y0 + 1;
  const c = Canvas(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = getPx(terrain, best.x0 + x, best.y0 + y);
      if (p[3] && !field.has(p.slice(0, 3).join(','))) setPx(c, x, y, p);
    }
  return { platform: c, box: { x0: best.x0, y0: best.y0, w, h, px: best.n } };
}

/* Perfil vertical del campo, extendido a cualquier alto. El campo de Esmeralda
   es un ciclo de 4 filas (1 clara + 3 de base), en degradado hacia el horizonte. */
function fieldProfile(terrain, height) {
  const rows = [];
  for (let y = 0; y < 96; y++) {
    const p = getPx(terrain, 4, y);
    rows.push(p[3] ? p.slice(0, 3) : [213, 246, 213]);
  }
  const out = [];
  for (let y = 0; y < height; y++) out.push(rows[y < 96 ? y : 92 + (y % 4)]);
  return out;
}

/* ==========================================================================
   Construcción
   ========================================================================== */
const assets = {};
const meta = {};
function emit(name, canvas) {
  const png = G.pngEncode(canvas.w, canvas.h, canvas.d);
  fs.writeFileSync(path.join(OUTDIR, name + '.png'), png);
  assets[name] = 'data:image/png;base64,' + png.toString('base64');
  meta[name] = { w: canvas.w, h: canvas.h, bytes: png.length };
  console.log(`   ${name.padEnd(16)} ${(canvas.w + 'x' + canvas.h).padEnd(10)} ${png.length} bytes`);
}

console.log('\n=== 1/4  terreno de combate (' + TERRAIN + ') ===');
const terrain = renderTerrain();
const { platform, box } = extractPlatform(terrain);
console.log('   plataforma', JSON.stringify(box));

console.log('\n=== 2/4  fondo compuesto ' + BG_W + 'x' + BG_H + ' ===');
const bg = Canvas(BG_W, BG_H);
const profile = fieldProfile(terrain, BG_H);
for (let y = 0; y < BG_H; y++)
  for (let x = 0; x < BG_W; x++) setPx(bg, x, y, profile[y]);
const groundY = Math.round(BG_H * (1 - GROUND_FRAC));
const platTop = groundY - Math.round(platform.h / 2);
blit(bg, platform, Math.round(BG_W * 0.25 - platform.w / 2), platTop);
blit(bg, platform, Math.round(BG_W * 0.75 - platform.w / 2), platTop);
emit('bg', bg);
console.log('   línea de suelo y=' + groundY + ' (' + (GROUND_FRAC * 100).toFixed(0) + '% desde abajo)');

console.log('\n=== 3/4  healthboxes, barras y cursores ===');
for (const [name, file] of [['hb_opponent', 'healthbox_singles_opponent'],
                            ['hb_player', 'healthbox_singles_player']]) {
  const c = toCanvas(srcPng('graphics/battle_interface/' + file + '.png'), 0);
  const b = contentBox(c);
  emit(name, upscale(crop(c, b.x0, b.y0, b.w, b.h), 2));
}
/* etiqueta "HP" y colores exactos de la barra, a la misma escala x2 */
const hp = srcPng('graphics/battle_interface/hpbar.png');
const hpc = toCanvas(hp, 0);
const hpb = contentBox(crop(hpc, 0, 0, 24, 8));
emit('hp_label', upscale(crop(hpc, hpb.x0, hpb.y0, hpb.w, hpb.h), 2));

{
  const c = toCanvas(srcPng('graphics/interface/arrow_cursor.png'), 0);
  const b = contentBox(c);
  emit('cursor', upscale(crop(c, b.x0, b.y0, b.w, b.h), 2));
}
{
  /* down_arrow.png son 6 fotogramas de 8x8 apilados (la flecha rebota) y la
     figura cruza el primer y el segundo tile: se recorta el primer fotograma
     limitando el análisis a las dos primeras filas de tiles. */
  const c = toCanvas(srcPng('graphics/fonts/down_arrow.png'), 0);
  const first = crop(c, 0, 0, c.w, 16);
  const b = contentBox(first);
  emit('arrow_down', upscale(crop(first, b.x0, b.y0, b.w, b.h), 2));
}

/* ==========================================================================
   4. Marco de ventana + paleta de la interfaz

   El índice 0 de los marcos es el color transparente del GBA (en el marco 1 es
   un verde #62c562): si se hornea opaco aparece un borde verde alrededor de
   cada ventana. Por eso va con índice 0 transparente.
   ========================================================================== */
console.log('\n=== 4/4  marco de ventana ' + FRAME + ' + paleta ===');
const framePng = srcPng('graphics/text_window/' + FRAME + '.png');
const frame = toCanvas(framePng, FRAME_STRIP);
console.log('   anillos vaciados: ' +
  FRAME_STRIP.map(function (i) { return i + '=' + hex(framePng.palette[i] || [0, 0, 0]); }).join(', '));
emit('frame3x', upscale(frame, 3));
emit('frame2x', upscale(frame, 2));
emit('frame1x', frame);

/* color interior = el dominante del tile central; borde = el dominante del
   anillo exterior, descartando el transparente y el interior */
const tally = (pred) => {
  const cnt = {};
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 24; x++) {
      const v = framePng.indices[y * 24 + x];
      if (pred(x, y, v)) cnt[v] = (cnt[v] || 0) + 1;
    }
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  return top ? +top[0] : 0;
};
const innerIdx = tally((x, y) => x >= 8 && x < 16 && y >= 8 && y < 16);
/* se descartan los anillos vaciados: --em-frame-edge tiene que ser el color del
   borde que de verdad se ve, porque de él sale también el fondo de la página */
const edgeIdx = tally((x, y, v) =>
  !(x >= 6 && x < 18 && y >= 6 && y < 18) && FRAME_STRIP.indexOf(v) === -1 && v !== innerIdx);
const FRAME_INNER = hex(framePng.palette[innerIdx]);
const FRAME_EDGE = hex(framePng.palette[edgeIdx]);
console.log('   transparente(0)=' + hex(framePng.palette[0]) +
            '  interior=' + FRAME_INNER + '  borde=' + FRAME_EDGE);

/* paleta de texto estándar de las ventanas de Esmeralda:
   1 = fondo, 2 = texto, 3 = sombra del texto, 4 = rojo, 6 = verde, 5 = naranja */
const tp = G.readPalBuf(src('graphics/text_window/text_pal1.pal'));
const TEXT = {
  bg: hex(tp[1]), ink: hex(tp[2]), shadow: hex(tp[3]),
  red: hex(tp[4]), orange: hex(tp[5]), green: hex(tp[6])
};
console.log('   texto:', JSON.stringify(TEXT));

/* colores de barra de HP/EXP, de las paletas de hpbar.png y expbar.png */
const expPal = srcPng('graphics/battle_interface/expbar.png').palette;
const HPCOL = {
  frame: hex(hp.palette[6]), inner: hex(hp.palette[2]),
  emptyTop: hex(hp.palette[5]), emptyBot: hex(hp.palette[6]),
  greenTop: hex(hp.palette[11]), greenBot: hex(hp.palette[10]),
  yellowTop: hex(hp.palette[13]), yellowBot: hex(hp.palette[12]),
  redTop: hex(hp.palette[15]), redBot: hex(hp.palette[14]),
  expFill: hex(expPal[11])
};

/* ==========================================================================
   CSS
   ========================================================================== */
const imgVars = Object.keys(assets)
  .map(k => `  --em-${k.replace(/_/g, '-')}: url("${assets[k]}");`).join('\n');
const sizeVars = Object.keys(meta)
  .map(k => `  --em-${k.replace(/_/g, '-')}-w: ${meta[k].w}px;\n  --em-${k.replace(/_/g, '-')}-h: ${meta[k].h}px;`).join('\n');

const css = `/* ============================================================================
   emerald-assets.css  ·  GENERADO por tools/bake-emerald-assets.js
   No editar a mano: vuelve a ejecutar el generador.

   Gráficos originales de Pokémon Esmeralda extraídos de pret/pokeemerald.
   Propiedad de Nintendo / Game Freak / The Pokémon Company.
   terreno=${TERRAIN}  marco=${FRAME}  fondo=${BG_W}x${BG_H}
   ========================================================================== */
:root{
  /* ---------- imágenes ---------- */
${imgVars}

  /* ---------- tamaños nativos, ya escalados ---------- */
${sizeVars}

  /* ---------- geometría del fondo (alinea sprites y plataformas) ---------- */
  --em-bg-ratio: ${BG_W} / ${BG_H};
  --em-ground: ${(GROUND_FRAC * 100).toFixed(1)}%;
  --em-slot-l: 25%;
  --em-slot-r: 75%;

  /* ---------- marco de ventana elegido ---------- */
  --em-frame-inner: ${FRAME_INNER};
  --em-frame-edge: ${FRAME_EDGE};

  /* ---------- paleta de texto de las ventanas (text_pal1.pal) ---------- */
  --em-bg-box: ${TEXT.bg};
  --em-ink: ${TEXT.ink};
  --em-ink-shadow: ${TEXT.shadow};
  --em-red: ${TEXT.red};
  --em-orange: ${TEXT.orange};
  --em-green: ${TEXT.green};

  /* ---------- barras de HP / EXP (hpbar.png, expbar.png) ---------- */
  --em-hp-frame: ${HPCOL.frame};
  --em-hp-inner: ${HPCOL.inner};
  --em-hp-empty-top: ${HPCOL.emptyTop};
  --em-hp-empty-bot: ${HPCOL.emptyBot};
  --em-hp-green-top: ${HPCOL.greenTop};
  --em-hp-green-bot: ${HPCOL.greenBot};
  --em-hp-yellow-top: ${HPCOL.yellowTop};
  --em-hp-yellow-bot: ${HPCOL.yellowBot};
  --em-hp-red-top: ${HPCOL.redTop};
  --em-hp-red-bot: ${HPCOL.redBot};
  --em-exp-fill: ${HPCOL.expFill};
}
`;
fs.writeFileSync(CSSOUT, css, 'utf8');
const total = Object.values(meta).reduce((a, m) => a + m.bytes, 0);
console.log('\n=== listo ===');
console.log('   ' + path.relative(ROOT, CSSOUT) + '  (' + (fs.statSync(CSSOUT).size / 1024).toFixed(1) + ' KB)');
console.log('   PNG sueltos en ' + path.relative(ROOT, OUTDIR) + '/  (' + (total / 1024).toFixed(1) + ' KB)');
