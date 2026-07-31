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

import type { SelectionAnchor } from 'core-common/batch-selection';
import { attributeTokenList } from 'core-app/shared/helpers/dom-helpers';
import {
  isMovableItem,
  resolveItemElement,
  resolveItemId,
  rowOf,
  sortableItemSelector,
  sortableListSelector,
} from './list-dom';

// Batch membership. Deliberately distinct from `aria-current`, which marks the
// work package the current navigation state represents: a card may be either,
// both, or neither.
export const batchSelectedAttribute = 'data-batch-selected';

export interface SelectionCandidate {
  itemElement:HTMLElement;
  // The element the consumer made focusable, which is also the boundary an
  // interactive-descendant check stops at: the host itself is allowed to be
  // focusable (Backlogs cards carry tabindex), while anything interactive
  // *inside* it keeps its own behaviour.
  focusHost:HTMLElement;
  id:string;
  listKey:string;
  movable:boolean;
}

export const itemFocusTargetSelector = '[data-sortable-lists--item-target~="focus"]';

// An opaque, stable-enough identity for one list, used only to decide whether
// a range stays inside the list it started in. The DOM id is preferred because
// it survives a morph; the type/id pair is the fallback for consumers that
// render no id.
function listKeyOf(listElement:HTMLElement):string {
  if (listElement.id !== '') {
    return listElement.id;
  }

  const type = listElement.getAttribute('data-sortable-lists--list-type-value') ?? '';
  const id = listElement.getAttribute('data-sortable-lists--list-id-value') ?? '';

  return `${type}:${id}`;
}

function ownerList(root:HTMLElement, itemElement:HTMLElement):HTMLElement|null {
  const list = itemElement.closest<HTMLElement>(sortableListSelector);

  return list && root.contains(list) ? list : null;
}

// Rows sit inside a child rows container (mirrors the list controller's own
// `rowsContainer` getter, `:scope > ul` with the list element as fallback). A
// row is any direct child of that container, not necessarily an item element
// itself: list-dom's contract lets a row wrap its item, so this must not be
// derived from the item's own parent.
function listRowsContainer(list:HTMLElement):HTMLElement {
  return list.querySelector<HTMLElement>(':scope > ul') ?? list;
}

// The id of the item a row holds, whether the row is the item element or
// merely contains it.
function rowItemId(row:Element):string|null {
  const item = resolveItemElement(row);

  return item ? resolveItemId(item) : null;
}

export function orderedItemElements(root:HTMLElement):HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(sortableItemSelector));
}

/**
 * The item a gesture landed on, or null when the gesture did not land on one.
 *
 * A structural row such as a truncation marker is not an item and therefore
 * not a candidate at all: it is neither selectable nor a thing whose selection
 * could be refused.
 */
export function resolveCandidate(root:HTMLElement, target:EventTarget|null):SelectionCandidate|null {
  if (!(target instanceof Element) || !root.contains(target)) {
    return null;
  }

  const itemElement = target.closest<HTMLElement>(sortableItemSelector);
  const id = itemElement ? resolveItemId(itemElement) : null;
  if (!itemElement || !id || !root.contains(itemElement)) {
    return null;
  }

  const list = ownerList(root, itemElement);
  if (!list) {
    return null;
  }

  return {
    itemElement,
    focusHost: itemElement.querySelector<HTMLElement>(itemFocusTargetSelector) ?? itemElement,
    id,
    listKey: listKeyOf(list),
    movable: isMovableItem(itemElement),
  };
}

// Live document order, resolved at action time rather than stored: a morph can
// reorder rows underneath a selection that was formed minutes ago.
export function orderedSelectedIds(root:HTMLElement, ids:ReadonlySet<string>):string[] {
  return orderedItemElements(root)
    .map((item) => resolveItemId(item))
    .filter((id):id is string => id !== null && ids.has(id));
}

export function liveMovableIds(root:HTMLElement):Set<string> {
  const ids = new Set<string>();

  for (const item of orderedItemElements(root)) {
    const id = resolveItemId(item);
    if (id && isMovableItem(item)) {
      ids.add(id);
    }
  }

  return ids;
}

// Why a range could not be resolved. `crossList` covers the anchor and
// candidate living in different lists, where "between these two cards" has
// no meaning. `unavailable` covers every other structural reason the span
// cannot be walked — most commonly a truncation marker inside it, but also
// the defensive cases where a row cannot be found at all — and is the one
// remediable by expanding the list. `locked` is the one that is not: a card
// the user may not move sits in the span, and no amount of expanding the
// list changes that.
export type RangeUnavailableReason = 'crossList'|'unavailable'|'locked';

export type RangeResolution =
  | { ok:true; ids:string[] }
  | { ok:false; reason:RangeUnavailableReason };

/**
 * The contiguous, movable range between the anchor and the candidate, or a
 * reason the range cannot be expressed.
 *
 * A range is refused rather than trimmed when it would cross a list boundary,
 * a truncation marker, or a card the user may not move: silently selecting
 * something narrower than the user gestured at would be worse than refusing.
 */
export function resolveRangeIds(
  root:HTMLElement,
  anchor:SelectionAnchor,
  candidate:SelectionCandidate,
):RangeResolution {
  if (anchor.listKey !== candidate.listKey) {
    return { ok: false, reason: 'crossList' };
  }

  const list = ownerList(root, candidate.itemElement);
  if (!list) {
    return { ok: false, reason: 'unavailable' };
  }

  const rowsContainer = listRowsContainer(list);
  const rows = Array.from(rowsContainer.children);
  const anchorRow = rows.find((row) => rowItemId(row) === anchor.id);
  // Meaningful only because rowsContainer came from the list rather than from
  // the candidate's own parent: a candidate whose item sits outside the rows
  // container (nested in some other part of the list) has no row here.
  const candidateRow = rowOf(rowsContainer, candidate.itemElement);
  if (!anchorRow || !candidateRow) {
    return { ok: false, reason: 'unavailable' };
  }

  const from = rows.indexOf(anchorRow);
  const to = rows.indexOf(candidateRow);
  const span = rows.slice(Math.min(from, to), Math.max(from, to) + 1);

  const ids:string[] = [];
  for (const row of span) {
    const item = resolveItemElement(row);
    const id = item ? resolveItemId(item) : null;
    // A structural row inside the span (a truncation marker) is a hard
    // boundary, and so is a card the user cannot move — but the two are not
    // interchangeable to the user, who can resolve the first by expanding the
    // list and can never resolve the second at all.
    if (!item || !id) {
      return { ok: false, reason: 'unavailable' };
    }

    if (!isMovableItem(item)) {
      return { ok: false, reason: 'locked' };
    }

    ids.push(id);
  }

  return { ok: true, ids };
}

/**
 * Marks the selected items and describes them to assistive technology.
 *
 * `describedById` points at an element the consumer renders once, holding the
 * word for "selected". Referencing one shared element keeps membership
 * announced per card without `aria-selected`, which is unavailable because a
 * card containing interactive descendants is not a listbox option. Pass an
 * empty string to skip the description entirely.
 *
 * `data-batch-selected` is written on the item element (the row in
 * Backlogs), matching the stylesheet it paints. `aria-describedby` is
 * written on the focus host instead: an accessible description is computed
 * from the focused element's own attribute, never inherited from an
 * ancestor, and the item element is not necessarily what receives focus —
 * see `itemFocusTargetSelector`.
 */
export function applySelectionPresentation(
  root:HTMLElement,
  ids:ReadonlySet<string>,
  describedById:string,
):void {
  for (const item of orderedItemElements(root)) {
    const id = resolveItemId(item);
    const focusHost = item.querySelector<HTMLElement>(itemFocusTargetSelector) ?? item;

    if (id && ids.has(id)) {
      item.setAttribute(batchSelectedAttribute, '');
      addDescription(focusHost, describedById);
    } else {
      item.removeAttribute(batchSelectedAttribute);
      removeDescription(focusHost, describedById);
    }
  }
}

// The card may already be described by something of its own, so the shared
// reference is added to and removed from the token list rather than replacing
// it wholesale.
function addDescription(item:HTMLElement, describedById:string):void {
  if (describedById === '') {
    return;
  }

  attributeTokenList(item, 'aria-describedby').add(describedById);
}

function removeDescription(item:HTMLElement, describedById:string):void {
  if (describedById === '') {
    return;
  }

  const describedBy = attributeTokenList(item, 'aria-describedby');
  describedBy.remove(describedById);

  // `remove` leaves an empty attribute behind rather than dropping it, and a
  // card that describes nothing should carry no `aria-describedby` at all.
  if (describedBy.length === 0) {
    item.removeAttribute('aria-describedby');
  }
}

// Focus movement is list-local: arrows walk the Backlogs list the user is in
// rather than tunnelling into the next one.
function listItems(root:HTMLElement, from:HTMLElement):HTMLElement[] {
  const list = ownerList(root, from);

  return list ? Array.from(list.querySelectorAll<HTMLElement>(sortableItemSelector)) : [];
}

// Arrows step through the list as rendered, non-movable cards included: the
// design's keyboard table does not qualify them, and a card in the way is
// still a real card to land on. This is deliberately not symmetric with
// listBoundaryItem below, which does filter — keep it that way rather than
// "fixing" it to match.
export function neighbourItem(root:HTMLElement, from:HTMLElement, offset:1|-1):HTMLElement|null {
  const items = listItems(root, from);
  const index = items.indexOf(from);

  if (index === -1) {
    return null;
  }

  return items[index + offset] ?? null;
}

// Unlike neighbourItem, Home/End are specified to land on the first/last
// *movable* card in the list: the design's keyboard table reads "Focus the
// first/last loaded movable card in the list". A trailing or leading
// non-movable card (a locked item, say) is skipped rather than becoming the
// jump target.
export function listBoundaryItem(
  root:HTMLElement,
  from:HTMLElement,
  edge:'first'|'last',
):HTMLElement|null {
  const items = listItems(root, from).filter(isMovableItem);

  if (items.length === 0) {
    return null;
  }

  return edge === 'first' ? items[0] : items[items.length - 1];
}
