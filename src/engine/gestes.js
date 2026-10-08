// Le document défile nativement. Sa position choisit la halte ; le rig conserve ses trajets.
// La hauteur en svh reste stable quand la barre d'adresse mobile se replie.
export function brancherGestes({ actif, geste, saut, dernier, pointeur }) {
  let cible = 0;
  const fin = () => Math.max(1, document.scrollingElement.scrollHeight - document.documentElement.clientHeight);
  function lire() {
    if (!actif()) return;
    cible = Math.max(0, Math.min(dernier, Math.round(document.scrollingElement.scrollTop / fin() * dernier)));
  }
  function aligner(i) {
    cible = i;
    window.scrollTo({ top: fin() * i / dernier, behavior: 'instant' });
  }
  window.addEventListener('scroll', lire, { passive: true });
  // Aucun scrollTo au resize : le repli de la barre d’adresse doit laisser finir le geste natif.

  window.addEventListener('keydown', (e) => {
    if (!actif() || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
    let dir = 0;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown') dir = 1;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') dir = -1;
    else if (e.key === ' ' || e.key === 'Spacebar') {
      if (t?.closest('button, a, summary, [role="button"]')) return;
      dir = e.shiftKey ? -1 : 1;
    } else if (e.key === 'Home') { e.preventDefault(); saut(0); return; }
    else if (e.key === 'End') { e.preventDefault(); saut(dernier); return; }
    if (!dir) return;
    e.preventDefault();
    if (!e.repeat) geste(dir, 'clavier');
  });

  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    pointeur((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  }, { passive: true });
  document.addEventListener('pointerleave', () => pointeur(0, 0));
  return { aligner, get cible() { return cible; } };
}
