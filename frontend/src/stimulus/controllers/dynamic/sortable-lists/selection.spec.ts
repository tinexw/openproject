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

import {
  applySelectionPresentation,
  batchSelectedAttribute,
  listBoundaryItem,
  liveMovableIds,
  neighbourItem,
  orderedSelectedIds,
  resolveCandidate,
  resolveRangeIds,
} from './selection';

describe('sortable-lists selection adapter', () => {
  let root:HTMLElement;

  // Two lists. Sprint 7 holds movable 1 and 2, a truncation marker, and
  // movable 3. Sprint 8 holds movable 4 and non-movable 5.
  beforeEach(() => {
    root = document.createElement('div');
    root.setAttribute('data-controller', 'sortable-lists');
    root.innerHTML = `
      <div data-controller="sortable-lists--list"
           data-sortable-lists--list-type-value="sprint"
           data-sortable-lists--list-id-value="7">
        <ul>
          <li data-controller="sortable-lists--item" data-sortable-lists--item-id-value="1"><span>one</span></li>
          <li data-controller="sortable-lists--item" data-sortable-lists--item-id-value="2"></li>
          <li data-sortable-lists-prev-item-id="2" data-sortable-lists-omitted-count="9"></li>
          <li data-controller="sortable-lists--item" data-sortable-lists--item-id-value="3"></li>
        </ul>
      </div>
      <div data-controller="sortable-lists--list"
           data-sortable-lists--list-type-value="sprint"
           data-sortable-lists--list-id-value="8">
        <ul>
          <li data-controller="sortable-lists--item" data-sortable-lists--item-id-value="4"></li>
          <li data-controller="sortable-lists--item" data-sortable-lists--item-id-value="5"
              data-sortable-lists--item-movable-value="false"></li>
        </ul>
      </div>
    `;
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
  });

  const itemFor = (id:string) => root.querySelector<HTMLElement>(`[data-sortable-lists--item-id-value="${id}"]`)!;
  const candidateFor = (id:string) => resolveCandidate(root, itemFor(id))!;

  it('resolves a candidate from a descendant of the item', () => {
    const candidate = resolveCandidate(root, itemFor('1').querySelector('span'));

    expect(candidate).toEqual({
      itemElement: itemFor('1'),
      focusHost: itemFor('1'),
      id: '1',
      listKey: 'sprint:7',
      movable: true,
    });
  });

  // The focus host is where the consumer put the tab stop. It is also the
  // boundary the interactive-descendant check stops at, so a focusable host
  // does not disqualify its own card from being selected.
  it('reports the focus target as the focus host when there is one', () => {
    const card = document.createElement('div');
    card.setAttribute('data-sortable-lists--item-target', 'focus');
    card.tabIndex = 0;
    itemFor('2').appendChild(card);

    expect(resolveCandidate(root, card)!.focusHost).toBe(card);
  });

  it('resolves a non-movable candidate', () => {
    expect(candidateFor('5').movable).toBe(false);
  });

  it('does not resolve a truncation marker as a candidate', () => {
    const marker = root.querySelector<HTMLElement>('[data-sortable-lists-prev-item-id]')!;

    expect(resolveCandidate(root, marker)).toBeNull();
  });

  it('does not resolve anything outside the root', () => {
    expect(resolveCandidate(root, document.body)).toBeNull();
  });

  it('orders selected ids by live document order across lists', () => {
    expect(orderedSelectedIds(root, new Set(['4', '1', '3']))).toEqual(['1', '3', '4']);
  });

  it('lists only live movable ids', () => {
    expect([...liveMovableIds(root)]).toEqual(['1', '2', '3', '4']);
  });

  it('resolves an ascending range within one list', () => {
    const anchor = { id: '1', listKey: 'sprint:7' };

    expect(resolveRangeIds(root, anchor, candidateFor('2'))).toEqual(['1', '2']);
  });

  it('resolves a descending range within one list', () => {
    const anchor = { id: '2', listKey: 'sprint:7' };

    expect(resolveRangeIds(root, anchor, candidateFor('1'))).toEqual(['1', '2']);
  });

  it('rejects a range that would cross a truncation marker', () => {
    const anchor = { id: '2', listKey: 'sprint:7' };

    expect(resolveRangeIds(root, anchor, candidateFor('3'))).toBeNull();
  });

  it('rejects a range that would cross a list boundary', () => {
    const anchor = { id: '3', listKey: 'sprint:7' };

    expect(resolveRangeIds(root, anchor, candidateFor('4'))).toBeNull();
  });

  it('rejects a range whose anchor id was never a row in this list', () => {
    const anchor = { id: '99', listKey: 'sprint:7' };

    expect(resolveRangeIds(root, anchor, candidateFor('2'))).toBeNull();
  });

  // Refused, not trimmed: a non-movable card in the span makes the whole
  // range unrepresentable, so this must stay `toBeNull()` rather than an
  // array with the non-movable card filtered out.
  it('refuses a range that would include a non-movable card', () => {
    const anchor = { id: '4', listKey: 'sprint:8' };

    expect(resolveRangeIds(root, anchor, candidateFor('5'))).toBeNull();
  });

  // list-dom's contract lets a row wrap its item instead of being it (see
  // rowOf / resolveItemElement). The range walk has to honour that rather
  // than assume the row and the item are the same element.
  it('resolves a range across rows that wrap their item element', () => {
    const wrappingRoot = document.createElement('div');
    wrappingRoot.setAttribute('data-controller', 'sortable-lists');
    wrappingRoot.innerHTML = `
      <div data-controller="sortable-lists--list"
           data-sortable-lists--list-type-value="sprint"
           data-sortable-lists--list-id-value="20">
        <ul>
          <li><div data-controller="sortable-lists--item" data-sortable-lists--item-id-value="20"></div></li>
          <li><div data-controller="sortable-lists--item" data-sortable-lists--item-id-value="21"></div></li>
          <li><div data-controller="sortable-lists--item" data-sortable-lists--item-id-value="22"></div></li>
        </ul>
      </div>
    `;
    document.body.appendChild(wrappingRoot);

    try {
      const wrappedItemFor = (id:string) => wrappingRoot.querySelector<HTMLElement>(
        `[data-sortable-lists--item-id-value="${id}"]`,
      )!;
      const anchor = { id: '20', listKey: 'sprint:20' };
      const candidate = resolveCandidate(wrappingRoot, wrappedItemFor('22'))!;

      expect(resolveRangeIds(wrappingRoot, anchor, candidate)).toEqual(['20', '21', '22']);
    } finally {
      wrappingRoot.remove();
    }
  });

  // The rows-container guard only does real work once the container comes
  // from the list rather than from the candidate's own parent (see
  // resolveRangeIds): a candidate whose item lives outside the list's rows
  // container has no row to find there.
  it('rejects a range when the candidate item sits outside the rows container', () => {
    const list = root.querySelector<HTMLElement>('[data-sortable-lists--list-id-value="7"]')!;
    const strayItem = document.createElement('div');
    strayItem.setAttribute('data-controller', 'sortable-lists--item');
    strayItem.setAttribute('data-sortable-lists--item-id-value', '30');
    list.appendChild(strayItem);

    const anchor = { id: '1', listKey: 'sprint:7' };
    const candidate = resolveCandidate(root, strayItem)!;

    expect(resolveRangeIds(root, anchor, candidate)).toBeNull();
  });

  it('applies and clears the batch presentation', () => {
    applySelectionPresentation(root, new Set(['1', '3']), 'selected-description');

    expect(itemFor('1').hasAttribute(batchSelectedAttribute)).toBe(true);
    expect(itemFor('2').hasAttribute(batchSelectedAttribute)).toBe(false);

    applySelectionPresentation(root, new Set(['3']), 'selected-description');

    expect(itemFor('1').hasAttribute(batchSelectedAttribute)).toBe(false);
    expect(itemFor('3').hasAttribute(batchSelectedAttribute)).toBe(true);
  });

  // Membership has to reach assistive technology per card, not only through
  // the running count: `aria-selected` is unavailable here because a card
  // containing interactive descendants is not a listbox option. The
  // description belongs on the focus host, not the item element: an
  // accessible description is computed from the focused element's own
  // `aria-describedby`, never inherited from an ancestor, and in Backlogs
  // the item element (the row) never receives focus — the card inside it
  // does. A focus host distinct from the item is added here so the
  // assertions below can tell the two apart.
  it('describes a selected card and stops describing a deselected one', () => {
    const focusHost = document.createElement('div');
    focusHost.setAttribute('data-sortable-lists--item-target', 'focus');
    itemFor('1').appendChild(focusHost);

    applySelectionPresentation(root, new Set(['1']), 'selected-description');

    expect(focusHost.getAttribute('aria-describedby')).toBe('selected-description');
    expect(itemFor('1').hasAttribute('aria-describedby')).toBe(false);

    applySelectionPresentation(root, new Set(), 'selected-description');

    expect(focusHost.hasAttribute('aria-describedby')).toBe(false);
  });

  // Re-applying the same selection must not grow the token list: nothing
  // here prunes duplicates on read, so a repeated apply is the only thing
  // that can catch a regression of the write-time de-duplication.
  it('does not accumulate duplicate description tokens on repeated apply', () => {
    applySelectionPresentation(root, new Set(['1']), 'selected-description');
    applySelectionPresentation(root, new Set(['1']), 'selected-description');

    expect(itemFor('1').getAttribute('aria-describedby')).toBe('selected-description');
  });

  it('leaves a description the card already had', () => {
    itemFor('1').setAttribute('aria-describedby', 'card-hint');

    applySelectionPresentation(root, new Set(['1']), 'selected-description');
    expect(itemFor('1').getAttribute('aria-describedby')).toBe('card-hint selected-description');

    applySelectionPresentation(root, new Set(), 'selected-description');
    expect(itemFor('1').getAttribute('aria-describedby')).toBe('card-hint');
  });

  it('skips the description wiring when no description element is configured', () => {
    applySelectionPresentation(root, new Set(['1']), '');

    expect(itemFor('1').hasAttribute('aria-describedby')).toBe(false);
    expect(itemFor('1').hasAttribute(batchSelectedAttribute)).toBe(true);
  });

  it('finds the next and previous item within one list', () => {
    expect(neighbourItem(root, itemFor('1'), 1)).toBe(itemFor('2'));
    expect(neighbourItem(root, itemFor('2'), -1)).toBe(itemFor('1'));
  });

  it('does not step across a list boundary', () => {
    expect(neighbourItem(root, itemFor('3'), 1)).toBeNull();
  });

  // Deliberately not filtered by movability, unlike listBoundaryItem below:
  // the design's keyboard table only qualifies Home/End as landing on a
  // movable card, not the plain arrow step.
  it('steps onto a non-movable card with the arrow', () => {
    expect(neighbourItem(root, itemFor('4'), 1)).toBe(itemFor('5'));
  });

  it('finds the first and last item of the containing list', () => {
    expect(listBoundaryItem(root, itemFor('2'), 'first')).toBe(itemFor('1'));
    expect(listBoundaryItem(root, itemFor('2'), 'last')).toBe(itemFor('3'));
  });

  // Sprint 8 holds movable 4 and non-movable 5 (see the fixture comment
  // above): the trailing non-movable card must not become the End target.
  it('skips a non-movable card at the list boundary', () => {
    expect(listBoundaryItem(root, itemFor('4'), 'last')).toBe(itemFor('4'));
  });

  it('returns null when no movable card remains in the list', () => {
    itemFor('4').setAttribute('data-sortable-lists--item-movable-value', 'false');

    expect(listBoundaryItem(root, itemFor('4'), 'first')).toBeNull();
    expect(listBoundaryItem(root, itemFor('4'), 'last')).toBeNull();
  });
});
