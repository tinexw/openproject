//-- copyright
// OpenProject is an open source project management software.
// Copyright (C) the OpenProject GmbH
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License version 3.
//
// OpenProject is a fork of ChiliProject, which is a fork of Redmine. The copyright follows:
// Copyright (C) 2006-2013 Jean-Philippe Lang
// Copyright (C) 2010-2013 the ChiliProject Team
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.
//
// See COPYRIGHT and LICENSE files for more details.
//++

import { LiveRegionElement } from '@primer/live-region-element';
import { type MockInstance } from 'vitest';
import type { SelectionHost } from './selection-orchestrator';

// No Stimulus application, no outlets, no controller lifecycle: the whole
// point of the host port is that selection can be driven over a plain DOM.
describe('SelectionOrchestrator', () => {
  // Imported dynamically, after the mock above registers: spec files share
  // one module registry (the runner does not isolate them), so a static
  // import here would bind whatever another spec already pulled in — with
  // the real platform helper baked in.
  let SelectionOrchestrator:typeof import('./selection-orchestrator').SelectionOrchestrator;
  let batchSelectedAttribute:string;

  beforeAll(async () => {
    ({ SelectionOrchestrator } = await import('./selection-orchestrator'));
    ({ batchSelectedAttribute } = await import('./selection'));
  });

  let root:HTMLElement;
  let announceSpy:MockInstance<typeof LiveRegionElement.prototype.announce>;
  let busy = false;
  let focused:HTMLElement|null = null;

  function hostFor(element:HTMLElement):SelectionHost {
    return {
      rootElement: element,
      get busy() { return busy; },
      announcementScope: 'js.sortable_lists.selection',
      descriptionId: 'selection-description',
      focusItem: (item) => { focused = item; },
    };
  }

  beforeEach(() => {
    busy = false;
    focused = null;
    root = document.createElement('div');
    root.setAttribute('data-controller', 'sortable-lists');
    root.innerHTML = `
      <div data-controller="sortable-lists--list"
           data-sortable-lists--list-type-value="sprint"
           data-sortable-lists--list-id-value="7">
        <ul>
          <li data-controller="sortable-lists--item" data-sortable-lists--item-id-value="1"></li>
          <li data-controller="sortable-lists--item" data-sortable-lists--item-id-value="2"></li>
          <li data-controller="sortable-lists--item" data-sortable-lists--item-id-value="3"></li>
        </ul>
      </div>
      <div data-controller="sortable-lists--list"
           data-sortable-lists--list-type-value="sprint"
           data-sortable-lists--list-id-value="8">
        <ul>
          <li data-controller="sortable-lists--item" data-sortable-lists--item-id-value="4"></li>
          <li data-controller="sortable-lists--item" data-sortable-lists--item-id-value="5"></li>
        </ul>
      </div>
    `;
    document.body.append(root, document.createElement('live-region'));
    announceSpy = vi.spyOn(LiveRegionElement.prototype, 'announce');
    // The real platform helper runs; only the signal it reads is stubbed, so
    // these cases cover the helper's own parsing too.
    pretendPlatform('Windows');
    window.I18n.store({
      en: {
        js: {
          sortable_lists: {
            selection: {
              cleared: 'Selection cleared.',
              not_selectable: 'Selection unchanged. This item cannot be selected.',
              range_blocked: 'Selection unchanged. That range contains an item that cannot be moved.',
              range_restarted: { one: 'Could not extend the range. 1 item selected.', other: 'Could not extend the range. %{count} items selected.' },
              range_unavailable: 'Selection unchanged. Expand this list to select that range.',
              selected: { one: '1 item selected.', other: '%{count} items selected.' },
            },
          },
        },
      },
    });
  });

  afterEach(() => {
    root.remove();
    document.querySelector('live-region')?.remove();
    announceSpy.mockRestore();
  });

  // navigator.platform and userAgentData are read-only accessors, so the
  // stub is installed per test and torn down with the fixture.
  function pretendPlatform(platform:string):void {
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform },
      configurable: true,
    });
  }

  const item = (id:string) => root.querySelector<HTMLElement>(`[data-sortable-lists--item-id-value="${id}"]`)!;
  const isSelected = (element:HTMLElement) => element.hasAttribute(batchSelectedAttribute);
  const clickOn = (element:HTMLElement, init:MouseEventInit = {}) => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, 'target', { value: element });
    return event;
  };

  it('selects the clicked card without any Stimulus wiring', () => {
    const orchestrator = new SelectionOrchestrator(hostFor(root));

    orchestrator.handleClick(clickOn(item('1')));

    expect(isSelected(item('1'))).toBe(true);
    expect(orchestrator.selectedIds()).toEqual(['1']);
  });

  it('extends a range from the anchor', () => {
    const orchestrator = new SelectionOrchestrator(hostFor(root));

    orchestrator.handleClick(clickOn(item('1')));
    orchestrator.handleClick(clickOn(item('3'), { shiftKey: true }));

    expect(orchestrator.selectedIds()).toEqual(['1', '2', '3']);
  });

  // The host decides where focus lands, so the orchestrator only asks.
  it('routes focus through the host rather than touching the element', () => {
    const orchestrator = new SelectionOrchestrator(hostFor(root));
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: item('1') });

    orchestrator.handleKeydown(event);

    expect(focused).toBe(item('2'));
  });

  it('reads busy from the host and refuses to mutate while a move is in flight', () => {
    const orchestrator = new SelectionOrchestrator(hostFor(root));
    busy = true;

    orchestrator.handleClick(clickOn(item('1')));

    expect(orchestrator.selectedIds()).toEqual([]);
  });

  // Presentation is markup that would otherwise outlive its meaning; the
  // model is left alone because whatever restores the page builds a fresh
  // orchestrator anyway.
  it('clears presentation without disturbing the model', () => {
    const orchestrator = new SelectionOrchestrator(hostFor(root));
    orchestrator.handleClick(clickOn(item('1')));

    orchestrator.clearPresentation();

    expect(isSelected(item('1'))).toBe(false);
    expect(orchestrator.selectedIds()).toEqual(['1']);
  });

  // Falling through mid-move would let the card's own click delay open the
  // details pane on a card the batch was not allowed to follow, leaving the
  // pane and the list disagreeing about what the user picked.
  it('consumes a plain click while a move is in flight', () => {
    const orchestrator = new SelectionOrchestrator(hostFor(root));
    orchestrator.handleClick(clickOn(item('1')));
    busy = true;

    const event = clickOn(item('2'));
    orchestrator.handleClick(event);

    expect(event.defaultPrevented).toBe(true);
    expect(orchestrator.selectedIds()).toEqual(['1']);
  });

  describe('announcements', () => {
    const spoken = () => announceSpy.mock.calls.map((call) => call[0]);

    // A Shift gesture that resizes a range to a different set of the same
    // size changed something the user needs to hear; it has no details pane
    // to serve as its own feedback.
    it('announces a range that swaps membership at the same size', () => {
      const orchestrator = new SelectionOrchestrator(hostFor(root));
      orchestrator.handleClick(clickOn(item('2')));
      orchestrator.handleClick(clickOn(item('3'), { shiftKey: true }));
      announceSpy.mockClear();

      orchestrator.handleClick(clickOn(item('1'), { shiftKey: true }));

      expect(orchestrator.selectedIds()).toEqual(['1', '2']);
      expect(spoken()).toEqual(['2 items selected.']);
    });

    // The baseline is what the previous render painted, not what it last
    // announced. Tracking the announcement instead would leave a stale
    // baseline behind a silent navigation render, making the next genuine
    // no-op look like a change.
    it('stays silent when a selection gesture changes nothing after a silent click', () => {
      const orchestrator = new SelectionOrchestrator(hostFor(root));
      orchestrator.handleClick(clickOn(item('1')));
      orchestrator.handleClick(clickOn(item('2')));
      announceSpy.mockClear();

      orchestrator.handleClick(clickOn(item('2'), { shiftKey: true }));

      expect(orchestrator.selectedIds()).toEqual(['2']);
      expect(spoken()).toEqual([]);
    });

    // A plain click already opens the details pane, which is its own
    // feedback; announcing the same count again on every click through the
    // backlog would be noise.
    it('stays silent on a plain click that swaps a one-card selection', () => {
      const orchestrator = new SelectionOrchestrator(hostFor(root));
      orchestrator.handleClick(clickOn(item('1')));
      announceSpy.mockClear();

      orchestrator.handleClick(clickOn(item('2')));

      expect(orchestrator.selectedIds()).toEqual(['2']);
      expect(spoken()).toEqual([]);
    });

    it('still announces a plain click that changes the count', () => {
      const orchestrator = new SelectionOrchestrator(hostFor(root));
      orchestrator.handleClick(clickOn(item('1')));
      orchestrator.handleClick(clickOn(item('3'), { shiftKey: true }));
      announceSpy.mockClear();

      orchestrator.handleClick(clickOn(item('2')));

      expect(spoken()).toEqual(['1 item selected.']);
    });
  });

  describe('keyboard and pointer edge cases', () => {
    const keydownOn = (element:HTMLElement, key:string, init:KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      Object.defineProperty(event, 'target', { value: element });
      return event;
    };

    // Consuming the key with nothing to select is a black hole: nothing
    // selected, nothing announced, and the browser's own select-all blocked.
    it('leaves Ctrl/Cmd+A alone when nothing is selectable', () => {
      root.querySelectorAll('[data-sortable-lists--item-id-value]')
        .forEach((el) => el.setAttribute('data-sortable-lists--item-mobility-value', 'fixed'));
      const orchestrator = new SelectionOrchestrator(hostFor(root));
      const event = keydownOn(item('1'), 'a', { metaKey: true });

      orchestrator.handleKeydown(event);

      expect(event.defaultPrevented).toBe(false);
      expect(orchestrator.selectedIds()).toEqual([]);
    });

    it('still consumes Ctrl/Cmd+A when there is something to select', () => {
      const orchestrator = new SelectionOrchestrator(hostFor(root));
      const event = keydownOn(item('1'), 'a', { metaKey: true });

      orchestrator.handleKeydown(event);

      expect(event.defaultPrevented).toBe(true);
      // Root-wide, unlike a range: "everything orderable" has an unambiguous
      // meaning across every list the root owns.
      expect(orchestrator.selectedIds()).toEqual(['1', '2', '3', '4', '5']);
    });

    // Holding Space would otherwise toggle the card over and over, with a
    // contradictory announcement for each flip.
    it('ignores a repeated Space keydown', () => {
      const orchestrator = new SelectionOrchestrator(hostFor(root));
      orchestrator.handleKeydown(keydownOn(item('1'), ' '));

      orchestrator.handleKeydown(keydownOn(item('1'), ' ', { repeat: true }));

      expect(orchestrator.selectedIds()).toEqual(['1']);
    });

    // Every other entry point refuses a fixed card; this one skipped the
    // check and could paint a card the rest of the UI insists is unselectable.
    it('refuses to extend a range onto a fixed card', () => {
      item('2').setAttribute('data-sortable-lists--item-mobility-value', 'fixed');
      const orchestrator = new SelectionOrchestrator(hostFor(root));

      orchestrator.handleKeydown(keydownOn(item('1'), 'ArrowDown', { shiftKey: true }));

      expect(isSelected(item('2'))).toBe(false);
      expect(orchestrator.selectedIds()).toEqual([]);
    });

    // Ctrl-click is the secondary click on Apple platforms, opening the
    // card's contextual menu. It must not toggle — and must not fall through
    // to the ordinary-click path either, which would replace the batch.
    it('ignores Ctrl-click entirely on Apple platforms', () => {
      pretendPlatform('macOS');
      const orchestrator = new SelectionOrchestrator(hostFor(root));
      orchestrator.handleClick(clickOn(item('1')));

      const event = clickOn(item('2'), { ctrlKey: true });
      orchestrator.handleClick(event);

      expect(orchestrator.selectedIds()).toEqual(['1']);
      expect(isSelected(item('2'))).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    });

    it('still treats Ctrl-click as multi-select elsewhere', () => {
      pretendPlatform('Windows');
      const orchestrator = new SelectionOrchestrator(hostFor(root));
      orchestrator.handleClick(clickOn(item('1')));

      orchestrator.handleClick(clickOn(item('2'), { ctrlKey: true }));

      expect(orchestrator.selectedIds()).toEqual(['1', '2']);
    });
  });

  // collapseForDrag stamps the anchor at drag start, so a cross-list drop
  // leaves it naming the source list. Without a rebind the next Shift in the
  // destination reads as cross-list and restarts instead of extending.
  it('extends a range after the anchored card moved to another list', () => {
    const orchestrator = new SelectionOrchestrator(hostFor(root));
    const moved = item('1');
    orchestrator.handleClick(clickOn(moved));

    root.querySelector('[data-sortable-lists--list-id-value="8"] ul')!.prepend(moved);
    orchestrator.reconcile();
    orchestrator.handleClick(clickOn(item('4'), { shiftKey: true }));

    expect(orchestrator.selectedIds()).toEqual(['1', '4']);
  });

  it('drops members that a morph removed from the document', () => {
    const orchestrator = new SelectionOrchestrator(hostFor(root));
    orchestrator.handleClick(clickOn(item('1')));
    orchestrator.handleClick(clickOn(item('2'), { metaKey: true }));
    item('1').remove();

    orchestrator.reconcile();

    expect(orchestrator.selectedIds()).toEqual(['2']);
    expect(announceSpy).toHaveBeenCalled();
  });
});
