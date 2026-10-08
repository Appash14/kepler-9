// L'interface en DOM par-dessus la scène : chargement, cartes des haltes, rail, boutons, fondu.
// Le DOM n'est touché que quand une valeur change.
import gsap from 'gsap';

const fmt = (n, dec) => n.toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec });

export function creerInterface({ haltes, reduit, surSaut, surGeste }) {
  const $ = (s, r = document) => r.querySelector(s);
  const app = $('#app');
  const cartes = Object.fromEntries(haltes.map((h) => [h.id, document.getElementById(h.id)]));
  const liens = [...document.querySelectorAll('.rail a[data-halte]')];
  const prec = $('.commandes .prec'), suiv = $('.commandes .suiv'), indice = $('.commandes .indice');
  const fondu = $('.fondu');
  const barre = $('.chargement-barre span'), pct = $('.chargement .pct'), msg = $('.chargement .msg');
  let carteVisible = null, railI = -1, railVers = -1, railU = -1, dernierPct = -1;

  // position de chaque carte (gauche ou droite) selon la halte
  for (const h of haltes) {
    const c = cartes[h.id];
    if (!c) continue;
    c.classList.add(h.carte === 'droite' ? 'carte-droite' : 'carte-gauche');
    c.setAttribute('aria-hidden', 'true');
    c.inert = true;
  }

  liens.forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const i = haltes.findIndex((h) => h.id === a.dataset.halte);
    if (i >= 0) surSaut(i, 'rail');
  }));
  prec.addEventListener('click', () => surGeste(-1, 'bouton'));
  suiv.addEventListener('click', () => surGeste(1, 'bouton'));
  document.querySelectorAll('[data-aller]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    const i = haltes.findIndex((h) => h.id === b.dataset.aller);
    if (i >= 0) surSaut(i, 'lien');
  }));

  function progression(p, texte) {
    const v = Math.round(Math.min(1, Math.max(0, p)) * 100);
    if (v === dernierPct && !texte) return;
    dernierPct = v;
    barre.style.transform = `scaleX(${v / 100})`;
    pct.textContent = String(v);
    if (texte) msg.textContent = texte;
  }

  function pret() {
    progression(1, 'en orbite');
    app.classList.add('is-ready');
    app.classList.remove('is-loading');
  }

  function decompte(el) {
    const v = el.querySelector('.valeur');
    if (!v || v.dataset.n == null) return;
    const n = parseFloat(v.dataset.n), dec = +(v.dataset.dec || 0);
    if (reduit || !n) { v.textContent = fmt(n, dec); return; }
    const o = { x: 0 };
    gsap.to(o, { x: n, duration: 1.4, delay: 0.35, ease: 'power2.out', onUpdate: () => { v.textContent = fmt(o.x, dec); } });
  }

  function montrerCarte(id) {
    if (carteVisible === id) return;
    if (carteVisible) cacherCarte();
    const c = cartes[id];
    if (!c) return;
    carteVisible = id;
    app.dataset.carte = c.classList.contains('carte-droite') ? 'droite' : 'gauche';
    c.classList.add('est-visible');
    c.setAttribute('aria-hidden', 'false');
    c.inert = false;
    const titre = c.querySelector('h2'), texte = c.querySelectorAll('.texte, .chiffre, .suite');
    gsap.killTweensOf([c, titre, ...texte]);
    if (reduit) {
      gsap.fromTo(c, { opacity: 0 }, { opacity: 1, duration: 0.5 });
    } else {
      const droite = c.classList.contains('carte-droite');
      gsap.set(c, { opacity: 1 });
      // marge négative à droite : un mot long (« L'observatoire ») déborde de la carte sans être coupé ;
      // en haut et en bas aussi : l'interligne serré (0,88) laisse les jambages (y, g, p, q) et les accents
      // sortir de la boîte du titre, il ne faut pas les rogner
      gsap.fromTo(titre, { clipPath: droite ? 'inset(-20% -60% -30% 100%)' : 'inset(-20% 100% -30% 0%)', x: droite ? 18 : -18 },
        { clipPath: 'inset(-20% -60% -30% 0%)', x: 0, duration: 1.1, ease: 'expo.out' });
      gsap.fromTo(texte, { opacity: 0, filter: 'blur(5px)' },
        { opacity: 1, filter: 'blur(0px)', duration: 0.9, delay: 0.28, stagger: 0.12, ease: 'power2.out' });
    }
    decompte(c);
  }

  function cacherCarte() {
    if (!carteVisible) return;
    const c = cartes[carteVisible];
    carteVisible = null;
    c.setAttribute('aria-hidden', 'true');
    c.inert = true;
    gsap.killTweensOf(c);
    gsap.to(c, { opacity: 0, duration: reduit ? 0.2 : 0.35, ease: 'power1.out', onComplete: () => c.classList.remove('est-visible') });
  }

  function rail(i, vers, u) {
    const uq = vers >= 0 ? Math.round(u * 50) / 50 : -1;
    if (i === railI && vers === railVers && uq === railU) return;
    railI = i; railVers = vers; railU = uq;
    liens.forEach((a, k) => {
      a.classList.toggle('est-actif', k === i && vers < 0);
      a.classList.toggle('est-vise', k === vers);
      a.classList.toggle('est-passe', k < (vers >= 0 ? Math.min(i, vers) : i));
      if (k === i && vers < 0) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current');
    });
    app.style.setProperty('--trajet', vers >= 0 ? String(uq) : '0');
    prec.disabled = i <= 0 && vers < 0;
    suiv.disabled = i >= haltes.length - 1 && vers < 0;
  }

  let indiceCache = false;
  function premierGeste() {
    if (indiceCache) return;
    indiceCache = true;
    indice.classList.add('est-parti');
  }

  function fonduNoir(on, duree = 0.35) {
    return new Promise((ok) => {
      gsap.killTweensOf(fondu);
      gsap.to(fondu, { opacity: on ? 1 : 0, duration: duree, ease: on ? 'power2.in' : 'power2.out', onComplete: ok });
    });
  }

  function focusTitre(id) {
    const h = cartes[id] && cartes[id].querySelector('h2');
    if (!h) return;
    h.setAttribute('tabindex', '-1');
    h.focus({ preventScroll: true });
  }

  return { progression, pret, montrerCarte, cacherCarte, rail, premierGeste, fonduNoir, focusTitre, get carteVisible() { return carteVisible; } };
}
