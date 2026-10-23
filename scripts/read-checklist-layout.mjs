// Read-only geometry probe for an owned isolated desktop test. This module never
// starts or connects to an application, reads user data or changes the page.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function readChecklistLayout(page, label = '') {
  const isolated = process.env.RUNBOOK_TEST_DATA_DIR;
  assert.ok(isolated && path.isAbsolute(isolated), 'Owned isolated desktop data directory required');
  assert.equal(path.resolve(isolated), path.resolve(process.env.RUNBOOK_DATA_DIR ?? ''));
  assert.equal(path.dirname(path.resolve(isolated)).toLowerCase(), path.resolve('target').toLowerCase());
  assert.match(path.basename(isolated), /^desktop-smoke-[A-Za-z0-9_-]+$/);
  return page.evaluate(label => {
    function describe(element) {
      if (!element) return null;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return {
        tag: element.tagName, id: element.id, className: element.className,
        role: element.getAttribute('role'), label: element.getAttribute('aria-label'),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom },
        clientWidth: element.clientWidth, clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop, scrollLeft: element.scrollLeft,
        overflow: style.overflow, overflowY: style.overflowY, height: style.height,
        minHeight: style.minHeight, position: style.position,
      };
    }
    const ancestors = [];
    for (let element = document.activeElement; element; element = element.parentElement) ancestors.push(describe(element));
    const selectors = ['html', 'body', '#root', '.checklist-app', '.app-sidebar', '.app-brand', '.app-main', '.app-topbar', '.workspace-page', '.workspace-titlebar', '.workspace-scroll', '.document-column', '.variable-popover'];
    const viewport = window.visualViewport;
    return {
      label, window: { scrollX, scrollY, innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio },
      visualViewport: viewport ? { width: viewport.width, height: viewport.height, offsetTop: viewport.offsetTop, pageTop: viewport.pageTop, scale: viewport.scale } : null,
      scrollingElement: describe(document.scrollingElement),
      elements: Object.fromEntries(selectors.map(selector => [selector, describe(document.querySelector(selector))])),
      activeAncestors: ancestors,
    };
  }, label);
}
