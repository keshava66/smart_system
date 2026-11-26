// @vitest-environment jsdom
// Data Studio tooltips: the explorer tree waits a moment before showing one,
// everything else shows straight away.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { TipLayer } = await import('../src/pages/dataStudio/sf_pg/sf_pg_pane');

let host;
let root;
const tip = () => document.querySelector('[role="tooltip"]');
const over = (el) => act(() => { el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, clientX: 5, clientY: 5 })); });
const out = (el, to) => act(() => { el.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: to })); });

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it('delays tips in the tree, and not elsewhere', () => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(
    <TipLayer>
      <div data-tip-delay><button id="a" title="Refresh objects" /><button id="b" title="Hide explorer" /></div>
      <button id="c" title="Run" />
      <div data-tip-delay><button id="d" title="Edit rows" /></div>
    </TipLayer>,
  ));
  const [a, b, c] = ['a', 'b', 'c'].map((id) => document.getElementById(id));

  over(a);
  expect(tip().getAttribute('aria-hidden')).toBe('true');
  act(() => vi.advanceTimersByTime(499));
  expect(tip().getAttribute('aria-hidden')).toBe('true');
  act(() => vi.advanceTimersByTime(1));
  expect(tip().getAttribute('aria-hidden')).toBe('false');
  expect(tip().textContent).toBe('Refresh objects');

  out(a, b);
  over(b);                                   // already showing one: the next one comes at once
  expect(tip().textContent).toBe('Hide explorer');
  expect(tip().getAttribute('aria-hidden')).toBe('false');

  out(b, host);
  act(() => vi.advanceTimersByTime(1000));
  over(a);
  out(a, host);                              // left before the delay ran out: nothing shows
  act(() => vi.advanceTimersByTime(1000));
  expect(tip().getAttribute('aria-hidden')).toBe('true');

  out(c, host);
  act(() => vi.advanceTimersByTime(1000));
  over(document.getElementById('d'));         // the results area waits too
  expect(tip().getAttribute('aria-hidden')).toBe('true');
  act(() => vi.advanceTimersByTime(500));
  expect(tip().textContent).toBe('Edit rows');
  out(document.getElementById('d'), host);
  act(() => vi.advanceTimersByTime(1000));

  over(c);                                   // outside the tree: no wait
  expect(tip().getAttribute('aria-hidden')).toBe('false');
  expect(tip().textContent).toBe('Run');
});
