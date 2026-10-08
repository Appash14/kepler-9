// Démarrage : aucune dépendance lourde ici. On choisit entre la 3D et la version texte, on devine
// le niveau de qualité, puis on charge le moteur (three.js et la suite) dans un second paquet.
import '@fontsource-variable/big-shoulders/opsz.css';
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import './style.css';

const params = new URLSearchParams(location.search);
const app = document.getElementById('app');
const test = params.has('test');

// ?test-mobile=1 : imite un téléphone d'entrée de gamme sur n'importe quel navigateur (shaders en
// mediump, profondeur 16 bits, DPR 1, niveau bas, sans filtrage linéaire des textures flottantes)
const testMobile = params.has('test-mobile');
if (testMobile) {
  const masquees = ['OES_texture_float_linear'];
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!C) continue;
    const ge = C.prototype.getExtension, gs = C.prototype.getSupportedExtensions;
    C.prototype.getExtension = function (nom) { return masquees.includes(nom) ? null : ge.call(this, nom); };
    C.prototype.getSupportedExtensions = function () { return (gs.call(this) || []).filter((n) => !masquees.includes(n)); };
  }
}

const RAISONS = {
  gl: 'Ce navigateur ne sait pas afficher la 3D (WebGL 2).',
  ctx: 'L’affichage 3D s’est interrompu en route.',
  charge: 'Le chargement de la scène a échoué.',
  lent: 'La scène tournait trop lentement sur cet appareil.',
  choix: 'Version texte, comme demandé.',
  test: 'Repli déclenché pour un test.',
};

function sonde() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const rendu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    const perte = gl.getExtension('WEBGL_lose_context');
    if (perte) perte.loseContext();
    return { rendu };
  } catch (e) {
    return null;
  }
}

function niveauAuto(rendu) {
  const q = params.get('q');
  if (q && /^(high|mid|low)$/.test(q)) return q;
  if (testMobile) return 'low';
  const tactile = matchMedia('(pointer: coarse)').matches;
  const petit = Math.min(screen.width, screen.height) < 600;
  if (/swiftshader|llvmpipe|software|softpipe/i.test(rendu)) return 'low';
  if (tactile && petit) return 'low';
  if (tactile) return 'mid';
  if (/intel|mali|adreno|powervr|apple gpu/i.test(rendu) || (navigator.hardwareConcurrency || 8) <= 4) return 'mid';
  return 'high';
}

function repli(raison) {
  if (test) {
    console.error('[station] repli demandé :', raison);
    window.__repli = raison;
    return;
  }
  const u = new URL(location.href);
  u.searchParams.set('lite', '1');
  u.searchParams.set('repli', raison);
  location.replace(u.toString());
}

function versionTexte(raison) {
  app.classList.remove('is-3d', 'is-loading');
  app.classList.add('is-lite');
  const el = document.querySelector('.repli-raison');
  if (raison && RAISONS[raison] && el) {
    el.hidden = false;
    el.textContent = `${RAISONS[raison]} Voici la station en texte, halte par halte. `;
    if (raison !== 'gl') {
      const a = document.createElement('a');
      a.href = location.pathname + location.hash;
      a.textContent = 'Revenir à la 3D';
      el.append(a);
    }
  }
}

const info = params.has('lite') ? null : sonde();
if (!info) {
  versionTexte(params.get('repli') || (params.has('lite') ? null : 'gl'));
} else {
  app.classList.add('is-3d', 'is-loading');
  window.addEventListener('error', (e) => { if (window.__station) window.__station.etat.erreurs.push(String(e.message)); });
  import('./app.js')
    .then((m) => m.demarrer({ niveauNom: niveauAuto(info.rendu), params, repli }))
    .catch((e) => { console.error('[station]', e); repli('charge'); });
}
