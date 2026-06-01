/* ============================================================================
   Consilia — faux facsimile generator
   The real reader shows data/{viaf}/{volume}/{stem}.jpg page scans.  Those
   high-res scans are not committed to the repo, so this renders a deterministic,
   period-styled stand-in (a 1575 Venetian two-column legal print) for any page
   stem — enough to show the facsimile panel's design and that it tracks
   navigation.  If a real <img> at the expected path loads, the reader uses it
   instead (see index.html).
   ============================================================================ */
(function () {
  // little seeded PRNG so each page stem renders a stable page
  function rng(seed) {
    let s = 0; for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  const INK = '#43372a', INK2 = '#5a4a38', PAGE = '#e7d7b8', PAGE2 = '#d8c49e';

  function facsimileSVG(stem) {
    const r = rng(stem || 'x');
    const W = 720, H = 1000;
    const folio = (parseInt(String(stem).replace(/\D/g, ''), 10) || 1);
    const colTop = 150, colBot = 922, colH = colBot - colTop;
    const lineGap = 17.5, lines = Math.floor(colH / lineGap);
    const cols = [{ x: 72, w: 270 }, { x: 378, w: 270 }];

    let body = '';

    // foxing / age spots
    for (let i = 0; i < 22; i++) {
      const cx = 40 + r() * (W - 80), cy = 40 + r() * (H - 80), rr = 4 + r() * 22;
      body += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rr.toFixed(1)}" fill="#b59b6e" opacity="${(0.03 + r() * 0.05).toFixed(3)}"/>`;
    }

    // running head + rule
    const heads = ['BALDI · CONSILIA', 'CONSILIORVM · LIB · I', 'BALDI VBALDI', 'PARS · PRIMA'];
    const head = heads[folio % heads.length];
    body += `<text x="${W / 2}" y="96" text-anchor="middle" font-family="Georgia, serif" font-size="20" letter-spacing="3" fill="${INK}" opacity="0.82">${head}</text>`;
    body += `<line x1="72" y1="118" x2="${W - 72}" y2="118" stroke="${INK}" stroke-width="1" opacity="0.4"/>`;
    // folio number top-outer
    body += `<text x="${W - 72}" y="96" text-anchor="end" font-family="Georgia, serif" font-size="17" fill="${INK}" opacity="0.7">${folio}</text>`;

    // column rule between
    body += `<line x1="360" y1="${colTop}" x2="360" y2="${colBot}" stroke="${INK}" stroke-width="0.8" opacity="0.18"/>`;

    cols.forEach((col, ci) => {
      let y = colTop, ln = 0;
      // decorated initial at very top of first column
      if (ci === 0) {
        const cap = 'CDQHSAIPVRE'[folio % 11];
        body += `<rect x="${col.x}" y="${y - 2}" width="46" height="46" fill="none" stroke="${INK}" stroke-width="1.4" opacity="0.55"/>`;
        body += `<text x="${col.x + 23}" y="${y + 34}" text-anchor="middle" font-family="Georgia, serif" font-weight="bold" font-size="40" fill="${INK}">${cap}</text>`;
        // first 3 lines wrap around the initial
        for (let k = 0; k < 3; k++) {
          const ix = col.x + 54, iw = col.w - 54;
          drawLine(ix, y + 6 + k * lineGap, iw * (0.9 + r() * 0.1));
          ln++;
        }
        y += 3 * lineGap + 6;
      }
      for (; ln < lines; ln++) {
        // paragraph breaks: shorter last line + small indent next
        const lastOfPara = r() < 0.11;
        let w = col.w * (lastOfPara ? (0.3 + r() * 0.35) : (0.92 + r() * 0.08));
        let x = col.x;
        // occasional rubric-ish heavier line (section opening)
        const rubric = r() < 0.06;
        drawLine(x, y, w, rubric);
        y += lineGap;
        if (lastOfPara) { y += 3; }
        if (y > colBot) break;
      }
    });

    // catchword bottom-right
    body += `<text x="${W - 72}" y="954" text-anchor="end" font-family="Georgia, serif" font-style="italic" font-size="14" fill="${INK}" opacity="0.6">Consi-</text>`;
    // signature mark bottom-left
    body += `<text x="72" y="954" font-family="Georgia, serif" font-size="13" fill="${INK}" opacity="0.5">${String.fromCharCode(65 + (folio % 6))}${(folio % 4) + 1}</text>`;

    function drawLine(x, yy, w, heavy) {
      // build a "line of type" out of 4-9 word-blocks with small gaps
      const words = 4 + Math.floor(r() * 6);
      let cx = x, remaining = w, out = '';
      const h = heavy ? 4.6 : 3.4;
      for (let i = 0; i < words && remaining > 6; i++) {
        const wl = Math.min(remaining, 10 + r() * 34);
        out += `<rect x="${cx.toFixed(1)}" y="${(yy).toFixed(1)}" width="${wl.toFixed(1)}" height="${h}" rx="1" fill="${heavy ? INK : INK2}" opacity="${heavy ? 0.8 : (0.55 + r() * 0.2).toFixed(2)}"/>`;
        cx += wl + 4 + r() * 4;
        remaining -= wl + 6;
      }
      body += out;
    }

    return `data:image/svg+xml;utf8,` + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}'>
        <defs>
          <radialGradient id='pg' cx='42%' cy='34%' r='78%'>
            <stop offset='0%' stop-color='${PAGE}'/>
            <stop offset='72%' stop-color='${PAGE}'/>
            <stop offset='100%' stop-color='${PAGE2}'/>
          </radialGradient>
          <linearGradient id='gut' x1='0' x2='1'>
            <stop offset='0%' stop-color='#00000000'/>
            <stop offset='100%' stop-color='#2a1c0c22'/>
          </linearGradient>
        </defs>
        <rect width='${W}' height='${H}' fill='url(#pg)'/>
        <rect x='0' y='0' width='34' height='${H}' fill='url(#gut)'/>
        ${body}
      </svg>`);
  }

  window.facsimileSVG = facsimileSVG;
})();
