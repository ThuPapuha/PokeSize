#!/usr/bin/env node
/* ============================================================================
   bake-dex.js

   Descarga la altura oficial de las 1025 especies de la PokéAPI y genera
   `dex-heights.js`, una tabla que el juego carga de golpe.

   ¿Para qué? Para elegir el siguiente Pokémon de la cadena hace falta saber su
   altura ANTES de pedirlo, o el juego tiene que ir pidiendo Pokémon al azar y
   descartando los que no encajan. Con 1025 especies eso falla de verdad: con
   Eternatus (20 m) como referencia solo 56 de 1024 valen, y 12 intentos
   aleatorios se quedan cortos la mitad de las veces, lo que produce rondas
   imposibles de acertar. Con la tabla, el candidato se elige directo y solo se
   hace una petición por Pokémon.

   Uso:  node tools/bake-dex.js
   ========================================================================== */

'use strict';
const fs = require('fs');
const path = require('path');

const MAX = +(process.argv[2] || 1025);
const CONC = 10;
const OUT = path.resolve(__dirname, '..', 'dex-heights.js');

const heights = new Array(MAX).fill(0);
const failed = [];
let next = 1, done = 0;

async function worker() {
  while (next <= MAX) {
    const id = next++;
    try {
      const r = await fetch('https://pokeapi.co/api/v2/pokemon/' + id);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      heights[id - 1] = d.height;                // en decímetros, como da la API
      if (++done % 100 === 0) process.stdout.write('   ' + done + '/' + MAX + '\r');
    } catch (e) {
      failed.push(id + ': ' + e.message);
    }
  }
}

(async () => {
  console.log('descargando alturas de ' + MAX + ' especies...');
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log('   ' + done + '/' + MAX + ' listo        ');

  if (failed.length) {
    console.error('\nfallaron ' + failed.length + ' peticiones; no se escribe nada:');
    failed.slice(0, 10).forEach(f => console.error('   ' + f));
    process.exit(1);
  }
  const zeros = heights.reduce((a, h, i) => h ? a : a.concat(i + 1), []);
  if (zeros.length) {
    console.error('\naltura 0 en ids ' + zeros.join(',') + ' (dividiría por cero); abortando');
    process.exit(1);
  }

  const body =
`/* ============================================================================
   dex-heights.js  ·  GENERADO por tools/bake-dex.js
   No editar a mano: vuelve a ejecutar el generador.

   Altura oficial de cada especie en DECÍMETROS, tal como la da la PokéAPI.
   El índice es (id nacional - 1), así que la tabla es contigua de 1 a ${MAX}.
   ========================================================================== */
window.DEX_HEIGHTS = [
${heights.map((h, i) => (i % 20 === 0 ? '  ' : '') + h).join(',').replace(/(([^,]*,){20})/g, '$1\n')}
];
`;
  fs.writeFileSync(OUT, body, 'utf8');

  const m = heights.map(h => h / 10).sort((a, b) => a - b);
  console.log('\n' + path.relative(path.resolve(__dirname, '..'), OUT) +
              '  (' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB)');
  console.log('   rango ' + m[0] + ' m - ' + m[m.length - 1] + ' m, mediana ' + m[(m.length / 2) | 0] + ' m');
})();
