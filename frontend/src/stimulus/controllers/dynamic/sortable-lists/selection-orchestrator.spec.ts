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
import { SelectionOrchestrator, type SelectionHost } from './selection-orchestrator';
import { batchSelectedAttribute } from './selection';

// No Stimulus application, no outlets, no controller lifecycle: the whole
// point of the host port is that selection can be driven over a plain DOM.
describe('SelectionOrchestrator', () => {
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
    `;
    document.body.append(root, document.createElement('live-region'));
    announceSpy = vi.spyOn(LiveRegionElement.prototype, 'announce');
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
    vi.restoreAllMocks();
  });

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
