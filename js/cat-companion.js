/* Shared website mascot. Sprite frames and timings are from VVcat_Web_Assets. */
(() => {
  'use strict';

  const cell = 240;
  const motions = {
    idle: { row: 0, times: [1260, 220, 110, 160, 120, 580], repeatFrom: 0 },
    lift: { row: 2, times: [90, 100, 120, 120, 120, 150], repeatFrom: 2 },
    edge: { row: 4, times: [90, 100, 110, 130, 130, 190] },
  };

  function mount(cat, { header, footer, storageKey }) {
    const panel = cat.querySelector('.vvcat-panel');
    const figure = cat.querySelector('.vvcat-figure');
    const dockButton = cat.querySelector('.vvcat-dock');
    const edgeTab = cat.querySelector('.vvcat-tab');
    const canvas = cat.querySelector('.vvcat-sprite');
    const context = canvas.getContext('2d');
    const sheet = new Image();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const viewportWidth = () => document.documentElement.clientWidth;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    let ready = false;
    let timer = 0;
    let drag = null;
    let moved = false;

    function play(name, complete) {
      window.clearTimeout(timer);
      if (!ready) { complete?.(); return; }
      const { row, times, repeatFrom } = motions[name];
      let index = reducedMotion.matches && name === 'edge' ? times.length - 1 : 0;
      function draw() {
        canvas.dataset.frame = String(index + 1);
        context.clearRect(0, 0, cell, cell);
        context.drawImage(sheet, index % 3 * cell, (row + Math.floor(index / 3)) * cell, cell, cell, 0, 0, cell, cell);
        if (reducedMotion.matches) { complete?.(); return; }
        timer = window.setTimeout(() => {
          index++;
          if (index === times.length) {
            if (repeatFrom === undefined) { complete?.(); return; }
            index = repeatFrom;
          }
          draw();
        }, times[index]);
      }
      canvas.dataset.motion = name;
      draw();
    }

    function position(left, top) {
      const minTop = header.getBoundingClientRect().height + 6;
      const maxTop = window.innerHeight - footer.getBoundingClientRect().height - cat.offsetHeight - 4;
      const maxLeft = Math.max(4, viewportWidth() - cat.offsetWidth - 4);
      cat.style.left = `${clamp(left, 4, maxLeft)}px`;
      cat.style.top = `${clamp(top, minTop, Math.max(minTop, maxTop))}px`;
      cat.style.right = cat.style.bottom = 'auto';
    }

    function fitDock() {
      const edge = cat.dataset.dock;
      if (!edge) {
        cat.style.removeProperty('--vvcat-offset');
        return;
      }
      const left = edge === 'left' ? 0 : viewportWidth() - cat.offsetWidth;
      cat.style.setProperty('--vvcat-offset', `${left - parseFloat(cat.style.left)}px`);
    }

    function dock(edge, animate = false, moveFocus = false) {
      cat.removeAttribute('data-docking');
      if (edge) {
        if (!cat.style.left) {
          const { left, top } = cat.getBoundingClientRect();
          position(left, top);
        }
        cat.dataset.dock = cat.dataset.edge = edge;
        if (animate && ready && !reducedMotion.matches) cat.setAttribute('data-docking', '');
        play('edge', () => cat.removeAttribute('data-docking'));
      } else {
        delete cat.dataset.dock;
        play('idle');
      }
      fitDock();
      panel.inert = Boolean(edge);
      edgeTab.inert = !edge;
      if (moveFocus) (edge ? edgeTab : dockButton).focus({ preventScroll: true });
    }

    function savePosition() {
      const left = parseFloat(cat.style.left);
      const top = parseFloat(cat.style.top);
      try { localStorage.setItem(storageKey, JSON.stringify({ left, top, edge: cat.dataset.dock })); } catch (_) { /* Storage is optional. */ }
    }

    edgeTab.inert = true;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
        position(saved.left, saved.top);
        if (saved.edge === 'left' || saved.edge === 'right') dock(saved.edge);
      }
    } catch (_) { /* Invalid or unavailable storage. */ }

    dockButton.addEventListener('click', () => {
      const rect = cat.getBoundingClientRect();
      dock(rect.left + rect.width / 2 < viewportWidth() / 2 ? 'left' : 'right', true, true);
      savePosition();
    });
    edgeTab.addEventListener('click', () => {
      dock(null, false, true);
      savePosition();
    });

    figure.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      const { left, top } = cat.getBoundingClientRect();
      moved = false;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left, top };
      figure.setPointerCapture(event.pointerId);
    });
    figure.addEventListener('pointermove', event => {
      if (drag?.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!moved) {
        if (Math.hypot(dx, dy) < 6) return;
        moved = true;
        cat.classList.add('is-dragging');
        play('lift');
      }
      position(drag.left + dx, drag.top + dy);
    });
    function finishDrag(event) {
      if (drag?.id !== event.pointerId) return;
      drag = null;
      cat.classList.remove('is-dragging');
      if (!moved) return;
      let edge = null;
      if (event.type === 'pointerup') {
        if (event.clientX <= 42) edge = 'left';
        else if (event.clientX >= viewportWidth() - 42) edge = 'right';
      }
      if (edge) dock(edge, true, panel.contains(document.activeElement));
      else play('idle');
      savePosition();
    }
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) figure.addEventListener(type, finishDrag);
    figure.addEventListener('click', event => {
      if (moved && event.detail) event.preventDefault();
      moved = false;
    });
    figure.addEventListener('dragstart', event => event.preventDefault());

    function fitToViewport() {
      if (!cat.style.left || !cat.offsetWidth) return;
      position(parseFloat(cat.style.left), parseFloat(cat.style.top));
      fitDock();
    }
    window.addEventListener('resize', fitToViewport);
    const observer = new ResizeObserver(fitToViewport);
    for (const element of [cat, header, footer]) observer.observe(element);
    reducedMotion.addEventListener('change', () => {
      if (cat.dataset.dock) dock(cat.dataset.dock);
      else play(drag && moved ? 'lift' : 'idle');
    });
    sheet.addEventListener('load', () => {
      if (!context || sheet.naturalWidth !== cell * 3 || sheet.naturalHeight !== cell * 6) return;
      ready = true;
      cat.classList.add('vvcat-ready');
      if (cat.dataset.dock) dock(cat.dataset.dock);
      else play(drag && moved ? 'lift' : 'idle');
    }, { once: true });
    sheet.src = canvas.dataset.sprite;
  }

  window.VvcatCompanion = { mount };
})();
