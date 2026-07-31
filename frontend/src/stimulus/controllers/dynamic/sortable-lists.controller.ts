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
  monitorForElements,
  type ElementEventPayloadMap,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { Controller } from '@hotwired/stimulus';
import { FetchRequest } from '@rails/request.js';
import { announce } from '@primer/live-region-element';
import { BatchSelection, type SelectionAnchor } from 'core-common/batch-selection';
import { closestInteractiveElement } from 'core-common/interactive-element-helper';
import { debugLog } from 'core-app/shared/helpers/debug_output';
import { OPToastEvent } from 'core-app/shared/components/toaster/toast-event';
import { flipMove } from 'core-stimulus/helpers/flip-helper';
import { parseTemplate } from 'url-template';
import {
  buildMoveFormData,
  isSortableItemData,
  resolveDropIntent,
  type RootAwareChild,
  type SortableListData,
  type SortableListsRoot,
} from './sortable-lists/drag-and-drop';
import {
  captureRowPositions,
  isMovableItem,
  reorderRows,
  resolveDirectionalPreviousItemId,
  resolveItemId,
  resolveItemLabel,
  resolveItemPosition,
  resolveItemType,
  resolveMoveAvailability,
  restoreRowPositions,
  rowOf,
  rowsRemainAt,
  sortableListsBusyAttribute,
  type MoveAvailability,
  type MoveDirection,
} from './sortable-lists/list-dom';
import {
  applySelectionPresentation,
  listBoundaryItem,
  liveMovableIds,
  neighbourItem,
  orderedItemElements,
  orderedSelectedIds,
  resolveCandidate,
  resolveRangeIds,
  type SelectionCandidate,
} from './sortable-lists/selection';

type CleanupFn = () => void;
type ElementDropPayload = ElementEventPayloadMap['onDrop'];
type MoveResult = { ok:true }|{ ok:false; showToast:boolean };
interface MoveAnnouncementContext { label:string|null; listName:string|null; crossList:boolean }

export default class SortableListsController extends Controller<HTMLElement> implements SortableListsRoot {
  static outlets = ['sortable-lists--list', 'sortable-lists--item', 'sortable-lists--scrollable'];

  static targets = ['selectionCount'];

  static values = {
    moveUrlTemplate: String,
    moveUrlTemplates: Object,
    optimistic: { type: Boolean, default: false },
    selectionEnabled: { type: Boolean, default: false },
    announcementScope: { type: String, default: 'js.sortable_lists.selection' },
    selectionDescriptionId: { type: String, default: '' },
  };

  declare readonly sortableListsListOutlets:import('./sortable-lists/list.controller').default[];
  declare readonly sortableListsItemOutlets:(RootAwareChild & { focusItem():void })[];
  declare readonly sortableListsScrollableOutlets:RootAwareChild[];

  declare readonly moveUrlTemplateValue:string;
  declare readonly hasMoveUrlTemplateValue:boolean;
  declare readonly moveUrlTemplatesValue:Record<string, string>;
  declare readonly hasMoveUrlTemplatesValue:boolean;
  declare readonly optimisticValue:boolean;
  declare readonly selectionEnabledValue:boolean;
  declare readonly announcementScopeValue:string;
  declare readonly selectionDescriptionIdValue:string;
  declare readonly selectionCountTarget:HTMLElement;
  declare readonly hasSelectionCountTarget:boolean;

  private readonly selection = new BatchSelection();

  private monitorCleanupFn?:CleanupFn;
  private healScheduled = false;

  // The count last spoken to assistive technology, so renderSelection can
  // decide on its own whether a change is worth announcing rather than
  // trusting each call site to remember. A plain click through the backlog
  // replaces the selection on almost every gesture; announcing that on top
  // of the details pane it also opens would be noise unless the number of
  // selected cards actually moved.
  private lastAnnouncedSelectionCount = 0;

  connect():void {
    this.monitorCleanupFn = monitorForElements({
      canMonitor: ({ source }) => !this.busy
        && isSortableItemData(source.data)
        && source.data.rootElement === this.element,
      onDrop: (args) => {
        void this.handleDrop(args);
      },
    });
    this.element.addEventListener('turbo:morph-element', this.scheduleRegistrationHeal);
    // Capture phase, at the root: a modified gesture has to be consumed before
    // the card's own navigation listener sees it, and doing that here does not
    // depend on which controller connected first.
    this.element.addEventListener('click', this.onSelectionClick, true);
    this.element.addEventListener('keydown', this.onSelectionKeydown, true);
  }

  disconnect():void {
    this.element.removeEventListener('turbo:morph-element', this.scheduleRegistrationHeal);
    this.element.removeEventListener('click', this.onSelectionClick, true);
    this.element.removeEventListener('keydown', this.onSelectionKeydown, true);
    this.monitorCleanupFn?.();
    this.monitorCleanupFn = undefined;
  }

  // A morph desyncs the children's drag-and-drop state in two ways. Stimulus
  // outlet-connected callbacks do not fire reliably for elements a morph
  // replaces, so those children never receive the root reference and refuse
  // every drag and drop (canDrag/canDrop gate on it). And Pragmatic DnD tracks
  // drop targets in both a marker attribute and a WeakMap registration, which
  // a morph can strip or orphan; an element left with the attribute but no
  // registration silently aborts Pragmatic's drop-target search, killing
  // every row rendered underneath it. Re-hand the root and re-register all
  // children once per morph batch — reregistration restores attribute and
  // registration together (which is why the morph attribute preservation
  // deliberately lets the marker be stripped), and the outlet getters query
  // the DOM live, so they see even the children whose connected callbacks
  // were skipped. The microtask runs before any further drag event can
  // observe the desync, so a morph mid-drag stays safe too.
  private scheduleRegistrationHeal = ():void => {
    if (this.healScheduled) {
      return;
    }

    this.healScheduled = true;
    queueMicrotask(() => {
      this.healScheduled = false;
      const children = [
        ...this.sortableListsListOutlets,
        ...this.sortableListsItemOutlets,
        ...this.sortableListsScrollableOutlets,
      ];
      children.forEach((child) => {
        // Outlet selectors are document-scoped, so a broad selector can match
        // another root's children; repair only the ones this root owns.
        if (!this.element.contains(child.element)) {
          return;
        }

        child.connectRoot(this);
        child.reregister();
      });

      // Reconciliation happens once per morph batch rather than per
      // disconnect: a morph can replace a row with a fresh element for the
      // same work package, and reacting to the disconnect alone would drop a
      // member that is about to come straight back.
      // Presentation is re-synced on every morph regardless of whether prune
      // dropped anything: a morph can strip or preserve the marker attribute
      // independently of the model, so the DOM has to be brought back in
      // line either way. Routing through renderSelection rather than calling
      // applySelectionPresentation and renderSelectionCount directly means a
      // prune that actually removes a selected member announces the new
      // count through the same rule as every other selection change, instead
      // of a second, easily-missed announcement path.
      if (this.selectionEnabled) {
        this.selection.prune(liveMovableIds(this.element));
        this.renderSelection();
      }
    });
  };

  sortableListsListOutletConnected(list:RootAwareChild):void {
    list.connectRoot(this);
  }

  sortableListsListOutletDisconnected(list:RootAwareChild):void {
    list.disconnectRoot();
  }

  sortableListsItemOutletConnected(item:RootAwareChild):void {
    item.connectRoot(this);
  }

  sortableListsItemOutletDisconnected(item:RootAwareChild):void {
    item.disconnectRoot();
  }

  sortableListsScrollableOutletConnected(scrollable:RootAwareChild):void {
    scrollable.connectRoot(this);
  }

  sortableListsScrollableOutletDisconnected(scrollable:RootAwareChild):void {
    scrollable.disconnectRoot();
  }

  get busy():boolean {
    return this.element.hasAttribute(sortableListsBusyAttribute);
  }

  get selectionEnabled():boolean {
    return this.selectionEnabledValue;
  }

  // Live ordered membership, for AGILE-278's batch move.
  selectedIds():string[] {
    return orderedSelectedIds(this.element, this.selection.ids);
  }

  collapseSelectionForDrag(itemElement:HTMLElement):void {
    // Collapsing a wider selection onto the dragged card and selecting the
    // dragged card are different things; only the first is in scope here.
    // With nothing selected there is nothing to collapse, so a drag must not
    // manufacture a one-card batch the user never asked for.
    if (!this.selectionEnabled || this.selection.size === 0) {
      return;
    }

    const candidate = resolveCandidate(this.element, itemElement);
    if (!candidate?.movable) {
      return;
    }

    this.selection.replace(candidate.id, candidate.listKey);
    this.renderSelection();
  }

  // Availability mirrors executability: a direction is offered exactly when the
  // move resolver can produce a target for it. This keeps the menu honest about
  // truncated lists, where a one-step move across the hidden block is not
  // addressable. Null means the item is not in an owned list (yet). The result
  // is a snapshot for menu gating; the click path re-resolves the live DOM.
  moveAvailability(itemElement:HTMLElement):MoveAvailability|null {
    const list = this.ownerListOf(itemElement);

    return list ? resolveMoveAvailability({ itemElement, rowsContainer: list.rowsContainer }) : null;
  }

  moveInDirection(itemElement:HTMLElement, direction:MoveDirection):void {
    // Defence in depth. The menu is rendered server-side from a permission
    // check that does not know about per-work-package movability, so a stale
    // or over-permissive menu must not be able to execute a move the server
    // will refuse.
    if (this.busy || !isMovableItem(itemElement)) {
      return;
    }

    const list = this.ownerListOf(itemElement);
    if (!list) {
      return;
    }

    const itemId = resolveItemId(itemElement);
    if (!itemId) {
      return;
    }

    const previousItemId = resolveDirectionalPreviousItemId({ itemElement, direction, rowsContainer: list.rowsContainer });
    if (previousItemId === undefined) {
      return;
    }

    const moveUrl = this.resolveMoveUrl({ itemId, type: resolveItemType(itemElement) });
    const sourceRow = rowOf(list.rowsContainer, itemElement);
    if (!moveUrl || !sourceRow) {
      return;
    }

    void this.performMove({
      sourceRow,
      rowsContainer: list.rowsContainer,
      listData: list.listData,
      previousItemId,
      moveUrl,
    });
  }

  // The list element an item currently belongs to, for the confinement field
  // on the drag payload; null outside any registered list.
  ownerListElementOf(itemElement:HTMLElement):HTMLElement|null {
    return this.ownerListOf(itemElement)?.element ?? null;
  }

  // The owning list of an item is the innermost list outlet containing its
  // element: in nested topologies (a section item hosting a field list) the
  // item is contained by every ancestor list, and only the innermost one
  // holds its row.
  private ownerListOf(itemElement:HTMLElement) {
    const containing = this.sortableListsListOutlets.filter((list) => list.element.contains(itemElement));

    return containing.find((list) => !containing.some((other) => other !== list && list.element.contains(other.element))) ?? null;
  }

  ownerRowsContainer(itemElement:HTMLElement):HTMLElement|null {
    return this.ownerListOf(itemElement)?.rowsContainer ?? null;
  }

  private async handleDrop({ location, source }:ElementDropPayload) {
    if (this.busy) {
      debugLog('sortable-lists: ignoring drop, a move is already in progress');
      return;
    }

    if (!isSortableItemData(source.data) || !(source.element instanceof HTMLElement)) {
      debugLog('sortable-lists: ignoring drop, source is not a sortable item', source.data);
      return;
    }

    if (!this.element.contains(source.element)) {
      debugLog('sortable-lists: ignoring drop, source does not belong to this root');
      return;
    }

    const moveUrl = this.resolveMoveUrl({ itemId: source.data.itemId, type: source.data.type });
    if (!moveUrl) {
      debugLog('sortable-lists: ignoring drop, no move URL for item', source.data.itemId);
      return;
    }

    const intent = resolveDropIntent({
      location,
      root: this.element,
      sourceData: source.data,
    });
    if (!intent) {
      debugLog('sortable-lists: ignoring drop, it did not resolve to a move');
      return;
    }

    const sourceList = this.ownerListOf(source.element);
    const sourceRow = sourceList ? rowOf(sourceList.rowsContainer, source.element) : null;
    if (!sourceRow) {
      debugLog('sortable-lists: ignoring drop, could not resolve the source row element');
      return;
    }

    await this.performMove({
      sourceRow,
      rowsContainer: intent.rowsContainer,
      listData: intent.listData,
      previousItemId: intent.previousItemId,
      moveUrl,
    });
  }

  // Optimistically reorder a single row, persist the move, and roll the row
  // back (with a FLIP animation and an error toast) if the server rejects it.
  // Shared by drag drops and programmatic menu moves.
  private async performMove({
    sourceRow,
    rowsContainer,
    listData,
    previousItemId,
    moveUrl,
  }:{
    sourceRow:HTMLElement;
    rowsContainer:HTMLElement;
    listData:SortableListData;
    previousItemId:string|null;
    moveUrl:string;
  }):Promise<void> {
    const rows = [sourceRow];
    // Captured before the reorder: afterwards the row already belongs to the
    // target list, so source-relative facts would be lost.
    const announcementContext:MoveAnnouncementContext = {
      label: resolveItemLabel(sourceRow),
      listName: listData.name,
      crossList: sourceRow.parentElement !== rowsContainer,
    };
    const rollback = captureRowPositions(rows);
    reorderRows({ rows, rowsContainer, previousItemId });

    // The reorder resolving back to the source's current DOM position means
    // the move is a no-op — nothing to persist, so no request. Comparing DOM
    // placement (not predecessor ids) keeps non-item rows such as truncation
    // markers out of the equation.
    if (rowsRemainAt(rollback)) {
      debugLog('sortable-lists: ignoring move, the item landed at its original position');
      return;
    }

    this.announceMove(announcementContext, sourceRow, rowsContainer);

    const optimisticPlacement = captureRowPositions(rows);

    const result = await this.moveItem({ listData, previousItemId, moveUrl });

    if (!result.ok) {
      let rolledBack = false;
      try {
        // A concurrent morph that removed or repositioned the rows carries
        // fresher server state than the pre-move snapshot; roll back only
        // while the rows still sit where the optimistic move put them.
        if (rowsRemainAt(optimisticPlacement)) {
          flipMove(rows, () => restoreRowPositions(rollback));
          // restoreRowPositions silently skips rows whose captured parent
          // disconnected, so verify the postcondition instead of trusting
          // the absence of an exception.
          rolledBack = rowsRemainAt(rollback);
        }
      } catch (error) {
        debugLog('Failed to roll back sortable list item move', error);
      }

      if (result.showToast) {
        this.dispatchErrorToast();
        this.announceMoveFailure(announcementContext, rolledBack);
      }
    }
  }

  // The template must expand to a same-origin relative URL: the expansion is
  // reduced to path + search + hash, so an absolute template's origin would
  // be dropped silently.
  private resolveMoveUrl({ itemId, type }:{ itemId:string; type:string|null }):string|null {
    const template = this.moveUrlTemplateFor(type);
    if (!template) {
      return null;
    }

    const expanded = parseTemplate(template).expand({ id: itemId });
    const url = new URL(expanded, window.location.href);
    // Only consumers whose success response is event-only (Backlogs) opt in;
    // morph-reconciled surfaces need the server to stream the canonical order.
    if (this.optimisticValue) {
      url.searchParams.set('optimistic', 'true');
    }

    return `${url.pathname}${url.search}${url.hash}`;
  }

  // The dragged item's type keys the template: the move endpoint belongs to
  // the item being moved, not to the destination list.
  private moveUrlTemplateFor(type:string|null):string|null {
    if (type !== null && this.hasMoveUrlTemplatesValue && this.moveUrlTemplatesValue[type]) {
      return this.moveUrlTemplatesValue[type];
    }

    return this.hasMoveUrlTemplateValue ? this.moveUrlTemplateValue : null;
  }

  private async moveItem({
    listData,
    previousItemId,
    moveUrl,
  }:{
    listData:SortableListData;
    previousItemId:string|null;
    moveUrl:string;
  }):Promise<MoveResult> {
    const request = new FetchRequest(
      'put',
      moveUrl,
      {
        body: buildMoveFormData({
          listId: listData.listId,
          previousItemId,
          type: listData.type,
        }),
        responseKind: 'turbo-stream',
      },
    );

    this.setBusy(true);
    try {
      const response = await request.perform();

      if (!response.ok) {
        debugLog(`Failed to move sortable list item: ${response.statusCode}`);
      }

      return response.ok
        ? { ok: true }
        : { ok: false, showToast: response.statusCode !== 422 };
    } catch (error) {
      debugLog('Failed to move sortable list item due to request error', error);
      return { ok: false, showToast: true };
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy:boolean):void {
    if (busy) {
      this.element.setAttribute(sortableListsBusyAttribute, 'true');
    } else {
      this.element.removeAttribute(sortableListsBusyAttribute);
    }
  }

  private dispatchErrorToast():void {
    window.dispatchEvent(new CustomEvent(OPToastEvent, {
      detail: {
        message: I18n.t('js.error.internal'),
        type: 'error',
      },
    }));
  }

  // The one meaningful message for the whole optimistic move; spoken from the
  // global live region, in sync with what sighted users see. Failure paths
  // append their own message below. A 422 stays silent here: its error flash
  // is streamed by the server and self-announces (matching the toast rule).
  private announceMove(context:MoveAnnouncementContext, sourceRow:HTMLElement, rowsContainer:HTMLElement):void {
    const placement = resolveItemPosition({ row: sourceRow, rowsContainer });
    if (!placement) {
      return;
    }

    // Resolved outside the options object literal below: nested inside it,
    // the call's generic return type would be inferred from the object's
    // contextual `TranslateOptions` index signature (`any`) instead of its
    // own `string` default.
    const label = context.label ?? I18n.t('js.sortable_lists.announcements.fallback_item_label');
    const listName = context.listName ?? I18n.t('js.sortable_lists.announcements.fallback_list_name');
    const message = context.crossList
      ? I18n.t('js.sortable_lists.announcements.moved_to_list', {
        label,
        list: listName,
        position: placement.position,
        total: placement.total,
      })
      : I18n.t('js.sortable_lists.announcements.moved', {
        label,
        position: placement.position,
        total: placement.total,
      });

    void announce(message, { politeness: 'polite' });
  }

  private announceMoveFailure(context:MoveAnnouncementContext, rolledBack:boolean):void {
    const label = context.label ?? I18n.t('js.sortable_lists.announcements.fallback_item_label');
    const message = rolledBack
      ? I18n.t('js.sortable_lists.announcements.move_failed_rolled_back', { label })
      : I18n.t('js.sortable_lists.announcements.move_failed_check_position');

    void announce(message, { politeness: 'assertive' });
  }

  private readonly onSelectionClick = (event:MouseEvent):void => {
    if (!this.selectionEnabled) {
      return;
    }

    const modified = event.shiftKey || event.metaKey || event.ctrlKey;
    const candidate = this.candidateForGesture(event.target);
    if (!candidate) {
      return;
    }

    if (!modified) {
      if (this.busy) {
        return;
      }

      // An ordinary click deliberately collapses the batch onto the clicked
      // card and is then allowed through, so the details pane still opens.
      // That collapse applies whether or not the card itself is selectable:
      // the card only joins the batch when it is movable, but a non-movable
      // card must not be able to leave an unrelated batch selected behind it.
      if (candidate.movable) {
        this.selection.replace(candidate.id, candidate.listKey);
        this.renderSelection();
      } else {
        this.selection.clear();
        this.renderSelection();
      }
      return;
    }

    // Consumed here regardless of `busy`: letting a modified gesture fall
    // through to the card's own click handler while a move is in flight
    // would open the details pane on a click the user meant as a selection
    // toggle, as an unrequested navigation once the card's own click delay
    // elapses.
    event.preventDefault();
    event.stopPropagation();

    if (this.busy) {
      return;
    }

    if (!candidate.movable) {
      this.announceSelection('not_selectable');
      return;
    }

    if (event.shiftKey) {
      this.extendSelectionTo(candidate);
    } else {
      this.selection.toggle(candidate.id, candidate.listKey);
      this.renderSelection();
    }
  };

  // Interactive descendants keep their own behaviour: a link inside a card is
  // a link first, and a selection gesture never steals it. The walk stops at
  // the focus host rather than the row when the gesture landed inside it,
  // because the host is itself allowed to be focusable — Backlogs cards
  // carry tabindex — and would otherwise disqualify every gesture that
  // landed on the card at all. But no consumer today renders a focus host
  // nested inside the item rather than being the item itself; once one does,
  // a gesture landing elsewhere on the row (outside the host's own subtree)
  // could never reach it by walking up through parentElement, and the walk
  // would run past the item into unrelated ancestors instead of stopping.
  // Falling back to the item element for that case keeps the walk bounded
  // to the row either way.
  private candidateForGesture(target:EventTarget|null):SelectionCandidate|null {
    const candidate = resolveCandidate(this.element, target);
    if (!candidate) {
      return null;
    }

    if (!(target instanceof Element)) {
      return candidate;
    }

    const boundary = candidate.focusHost.contains(target) ? candidate.focusHost : candidate.itemElement;
    const interactive = closestInteractiveElement(target, boundary);

    return interactive ? null : candidate;
  }

  private readonly onSelectionKeydown = (event:KeyboardEvent):void => {
    if (!this.selectionEnabled) {
      return;
    }

    const candidate = this.candidateForGesture(event.target);
    if (!candidate) {
      return;
    }

    switch (event.key) {
      case ' ':
        this.handleSpace(event, candidate);
        break;
      case 'ArrowDown':
      case 'ArrowUp':
        this.handleArrow(event, candidate, event.key === 'ArrowDown' ? 1 : -1);
        break;
      case 'Home':
      case 'End':
        this.handleBoundary(event, candidate, event.key === 'Home' ? 'first' : 'last');
        break;
      case 'a':
      case 'A':
        this.handleSelectAll(event, candidate);
        break;
      case 'Escape':
        this.handleEscape(event);
        break;
      default:
        // Enter and Shift+Enter belong to the card's own activation handler.
        break;
    }
  };

  private handleSpace(event:KeyboardEvent, candidate:SelectionCandidate):void {
    event.preventDefault();

    if (this.busy) {
      return;
    }

    if (!candidate.movable) {
      this.announceSelection('not_selectable');
      return;
    }

    if (event.shiftKey) {
      this.extendSelectionTo(candidate);
    } else {
      this.selection.toggle(candidate.id, candidate.listKey);
      this.renderSelection();
    }
  }

  // Consumed unconditionally once the gesture lands on a candidate: leaving
  // the key unconsumed at a list boundary (the first card on ArrowUp, the
  // last on ArrowDown) falls through to the browser's own scrolling, moving
  // the page while focus stays put. Nothing beyond this point mutates state
  // when there is nowhere to go, so the no-op case still does not select or
  // move focus — it only stops the scroll.
  private handleArrow(event:KeyboardEvent, candidate:SelectionCandidate, offset:1|-1):void {
    event.preventDefault();

    const next = neighbourItem(this.element, candidate.itemElement, offset);
    if (!next) {
      return;
    }

    if (this.busy) {
      return;
    }

    this.focusAndMaybeExtend(event, next);
  }

  // Same reasoning as handleArrow: consumed as soon as the gesture lands on a
  // candidate, including both boundary no-ops below (no movable card at all,
  // or focus already sitting on the edge), so Home/End never scrolls the page
  // out from under a card that cannot move any further.
  private handleBoundary(event:KeyboardEvent, candidate:SelectionCandidate, edge:'first'|'last'):void {
    event.preventDefault();

    const target = listBoundaryItem(this.element, candidate.itemElement, edge);
    if (!target) {
      return;
    }

    // Focus already sitting on the boundary is only a no-op for the
    // unmodified key: with Shift held, the range still has to resize out to
    // that boundary even though focus itself has nowhere left to move.
    if (target === candidate.itemElement && !event.shiftKey) {
      return;
    }

    if (this.busy) {
      return;
    }

    this.focusAndMaybeExtend(event, target);
  }

  private focusAndMaybeExtend(event:KeyboardEvent, target:HTMLElement):void {
    this.focusItemElement(target);

    if (!event.shiftKey) {
      return;
    }

    const candidate = resolveCandidate(this.element, target);
    if (candidate) {
      this.extendSelectionTo(candidate);
    }
  }

  // Focus is applied through the item's own outlet so the consumer decides
  // which element inside the row actually holds the tab stop.
  private focusItemElement(target:HTMLElement):void {
    const outlet = this.sortableListsItemOutlets.find((item) => item.element === target);

    if (outlet) {
      outlet.focusItem();
    } else {
      target.focus();
    }
  }

  // Root-wide, unlike range selection: a range is confined to one list
  // because "between these two cards" is only meaningful within a single
  // list, but "everything movable" has an unambiguous meaning across the
  // whole Backlogs root, and that is what select-all is for.
  private handleSelectAll(event:KeyboardEvent, candidate:SelectionCandidate):void {
    if (!event.metaKey && !event.ctrlKey) {
      return;
    }

    event.preventDefault();

    if (this.busy) {
      return;
    }

    const ids = [...liveMovableIds(this.element)];
    const anchor:SelectionAnchor|null = candidate.movable
      ? { id: candidate.id, listKey: candidate.listKey }
      : this.firstMovableCandidate();

    this.selection.selectAll(ids, anchor);
    this.renderSelection();
  }

  // The design's anchor fallback when the focused card cannot itself anchor
  // the batch: the first movable card in document order, resolved through
  // resolveCandidate like every other candidate rather than re-deriving its
  // list key from the DOM by hand.
  private firstMovableCandidate():SelectionAnchor|null {
    for (const element of orderedItemElements(this.element)) {
      const candidate = resolveCandidate(this.element, element);
      if (candidate?.movable) {
        return { id: candidate.id, listKey: candidate.listKey };
      }
    }

    return null;
  }

  private handleEscape(event:KeyboardEvent):void {
    // BatchSelection#toggle re-bases the anchor even on a deselect, so a
    // Space that empties the visible selection can still leave an anchor
    // behind; Escape has to drop that too, or a later Shift gesture would
    // range from a card the user believes they already cleared.
    const hadSelection = this.selection.size > 0;
    if (!hadSelection && this.selection.anchor === null) {
      return;
    }

    event.preventDefault();
    this.selection.clear();
    // Only a visible selection going away is worth announcing; dropping a
    // stale, invisible anchor alone leaves the count unchanged, so
    // renderSelection stays silent on its own.
    this.renderSelection();
  }

  private extendSelectionTo(candidate:SelectionCandidate):void {
    const { anchor } = this.selection;

    if (!anchor) {
      this.renderRangeRestart(candidate);
      return;
    }

    const range = resolveRangeIds(this.element, anchor, candidate);

    if (range.ok) {
      this.selection.range(range.ids);
      this.renderSelection();
      return;
    }

    if (range.reason === 'crossList') {
      this.renderRangeRestart(candidate);
      return;
    }

    // Same list, unrepresentable span: a truncated block or an immovable
    // card sits in the way, and the user needs to know which — expanding the
    // list can surface a truncated block, but it can never make a locked
    // card movable, so the two reasons speak different messages.
    this.announceSelection(range.reason === 'locked' ? 'range_blocked' : 'range_unavailable');
  }

  // A Shift gesture asks for a range; collapsing it to a single card instead
  // (no anchor yet to range from, or the anchor sits in a different list) is
  // a real answer the user needs to hear even when the resulting count
  // happens to match what was already selected. That is deliberately
  // different from the count rule renderSelection otherwise applies
  // everywhere else: an ordinary plain click that leaves the count unchanged
  // stays silent because the details pane it also opens is its own
  // feedback, but a Shift gesture that fails to form a range has no other
  // feedback at all, so this always speaks — and never with the plain count
  // sentence, which would not tell the user their range was not honoured.
  private renderRangeRestart(candidate:SelectionCandidate):void {
    this.selection.replace(candidate.id, candidate.listKey);
    this.syncSelectionPresentation();
    this.lastAnnouncedSelectionCount = this.selection.size;
    this.announceSelection('range_restarted');
  }

  // The default place that decides whether a selection change is announced:
  // every call site but renderRangeRestart's narrow exception below funnels
  // through here rather than passing its own opinion, so a future call site
  // cannot forget to. The rule is the count, not the gesture — a change in
  // how many cards are selected is always announced, and a gesture that
  // leaves the count where it was (an ordinary click replacing a one-card
  // selection with a different one-card selection, say) stays silent, since
  // that same click already opens the details pane.
  private renderSelection():void {
    this.syncSelectionPresentation();

    const { size } = this.selection;
    if (size === this.lastAnnouncedSelectionCount) {
      return;
    }

    this.lastAnnouncedSelectionCount = size;
    this.announceSelection(size === 0 ? 'cleared' : 'selected');
  }

  private syncSelectionPresentation():void {
    applySelectionPresentation(this.element, this.selection.ids, this.selectionDescriptionIdValue);
    this.renderSelectionCount();
  }

  private renderSelectionCount():void {
    if (!this.hasSelectionCountTarget) {
      return;
    }

    const { size } = this.selection;
    this.selectionCountTarget.textContent = size > 1 ? this.selectionMessage('selected') : '';
    this.selectionCountTarget.hidden = size <= 1;
  }

  private announceSelection(key:'selected'|'cleared'|'not_selectable'|'range_unavailable'|'range_blocked'|'range_restarted'):void {
    void announce(this.selectionMessage(key), { politeness: 'polite' });
  }

  // The scope is a value rather than a constant so the shared controller can
  // speak the consumer's vocabulary: Backlogs says "work package", not "item".
  private selectionMessage(key:string):string {
    return I18n.t(`${this.announcementScopeValue}.${key}`, { count: this.selection.size });
  }
}
