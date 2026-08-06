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

import { BatchSelection, type SelectionAnchor, type SelectionKey } from 'core-common/batch-selection';
import { announce } from '@primer/live-region-element';
import { resolveItemId, resolveItemType } from './list-dom';
import {
  applySelectionPresentation,
  listBoundaryItem,
  liveOrderableItems,
  liveOrderableKeys,
  neighbourItem,
  orderedItemElements,
  orderedSelectedItems,
  resolveCandidate,
  resolveRangeItems,
  type SelectionCandidate,
} from './selection';
import { closestInteractiveElement } from 'core-common/interactive-element-helper';
import { isApplePlatform } from 'core-stimulus/helpers/platform';

/**
 * What the orchestrator needs from whatever hosts it.
 *
 * Deliberately narrow, and deliberately free of Stimulus: the orchestrator
 * reads root state and asks for focus, and knows nothing about outlets,
 * values or controller lifecycle. That is what lets it be constructed over a
 * synthetic DOM in a spec with no Stimulus application at all.
 */
export interface SelectionHost {
  readonly rootElement:HTMLElement;
  readonly busy:boolean;
  readonly announcementScope:string;
  readonly descriptionId:string;
  // Routed rather than called directly so the consumer decides which element
  // inside a row actually holds the tab stop.
  focusItem(itemElement:HTMLElement):void;
  // The rows container of the item's owning list. Asked of the host so that
  // ranges and moves agree on what a list's rows are, rather than each
  // deriving it.
  ownerRowsContainer(itemElement:HTMLElement):HTMLElement|null;
}

/**
 * Batch selection: gestures in, model and presentation out.
 *
 * Owns gesture interpretation, keyboard navigation, announcements and the
 * DOM presentation of membership. It does not own dragging, moves or Turbo
 * healing — those stay with the root controller, which constructs one of
 * these only when its consumer opted into selection at all.
 */
export class SelectionOrchestrator {
  private readonly selection = new BatchSelection();

  // What the previous render painted, updated after every render including
  // the silent ones. Comparing against the last *announced* membership would
  // drift: a silent navigation render in between leaves a stale baseline, so
  // the next genuine no-op would look like a change and speak.
  private lastRenderedKeys:ReadonlySet<SelectionKey> = new Set();

  constructor(private readonly host:SelectionHost) {}

  // Live ordered membership, for AGILE-278's batch move.
  selectedIds():string[] {
    return orderedSelectedItems(this.host.rootElement, this.selection.keys).map((item) => item.id);
  }

  // A menu move relocates exactly one card, so it collapses the batch the
  // same way a drag does. Same rule, different surface: the two must not
  // disagree about what a single-card move means for a wider selection.
  collapseForMove(itemElement:HTMLElement):void {
    this.collapseForDrag(itemElement);
  }

  collapseForDrag(itemElement:HTMLElement):void {
    // Collapsing a wider selection onto the dragged card and selecting the
    // dragged card are different things; only the first is in scope here.
    // With nothing selected there is nothing to collapse, so a drag must not
    // manufacture a one-card batch the user never asked for.
    if (this.selection.size === 0) {
      return;
    }

    const candidate = resolveCandidate(this.host.rootElement, itemElement);
    if (!candidate?.orderable) {
      return;
    }

    this.selection.replace({ type: candidate.type, id: candidate.id }, candidate.listKey);
    this.renderSelection('selection');
  }

  readonly handleClick = (event:MouseEvent):void => {
    // Ctrl-click is the secondary click on Apple platforms, where it opens
    // the card's contextual menu and Cmd is the multi-select key instead.
    // Returning before classification matters: merely treating it as
    // unmodified would send it down the ordinary-click path, which replaces
    // the batch with this card — the opposite of leaving the gesture alone.
    if (event.ctrlKey && !event.metaKey && !event.shiftKey && isApplePlatform()) {
      return;
    }

    const multiSelect = event.metaKey || event.ctrlKey;
    const modified = event.shiftKey || multiSelect;
    const candidate = this.candidateForGesture(event.target);
    if (!candidate) {
      return;
    }

    if (!modified) {
      // Consumed before the busy check, like the modified branch below:
      // falling through mid-move would let the card's own click delay open
      // the details pane on a card the batch was not allowed to follow, so
      // the pane and the list would disagree about what the user picked.
      if (this.host.busy) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // An ordinary click deliberately collapses the batch onto the clicked
      // card and is then allowed through, so the details pane still opens.
      // That collapse applies whether or not the card itself is selectable:
      // the card only joins the batch when it is orderable, but a fixed
      // card must not be able to leave an unrelated batch selected behind it.
      if (candidate.orderable) {
        this.selection.replace({ type: candidate.type, id: candidate.id }, candidate.listKey);
        this.renderSelection('navigation');
      } else {
        this.selection.clear();
        this.renderSelection('navigation');
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

    if (this.host.busy) {
      return;
    }

    if (!candidate.orderable) {
      this.announceSelection('not_selectable');
      return;
    }

    if (event.shiftKey) {
      this.extendSelectionTo(candidate);
    } else {
      this.toggleWithinCohort(candidate);
      this.renderSelection('selection');
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
    const candidate = resolveCandidate(this.host.rootElement, target);
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

  readonly handleKeydown = (event:KeyboardEvent):void => {
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

    // A held Space would otherwise toggle the card over and over, with a
    // contradictory announcement for each flip.
    if (event.repeat) {
      return;
    }

    if (this.host.busy) {
      return;
    }

    if (!candidate.orderable) {
      this.announceSelection('not_selectable');
      return;
    }

    if (event.shiftKey) {
      this.extendSelectionTo(candidate);
    } else {
      this.toggleWithinCohort(candidate);
      this.renderSelection('selection');
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

    const next = neighbourItem(this.host.rootElement, candidate.itemElement, offset);
    if (!next) {
      return;
    }

    if (this.host.busy) {
      return;
    }

    this.focusAndMaybeExtend(event, next);
  }

  // Same reasoning as handleArrow: consumed as soon as the gesture lands on a
  // candidate, including both boundary no-ops below (no orderable card at all,
  // or focus already sitting on the edge), so Home/End never scrolls the page
  // out from under a card that cannot move any further.
  private handleBoundary(event:KeyboardEvent, candidate:SelectionCandidate, edge:'first'|'last'):void {
    event.preventDefault();

    const target = listBoundaryItem(this.host.rootElement, candidate.itemElement, edge);
    if (!target) {
      return;
    }

    // Focus already sitting on the boundary is only a no-op for the
    // unmodified key: with Shift held, the range still has to resize out to
    // that boundary even though focus itself has nowhere left to move.
    if (target === candidate.itemElement && !event.shiftKey) {
      return;
    }

    if (this.host.busy) {
      return;
    }

    this.focusAndMaybeExtend(event, target);
  }

  private focusAndMaybeExtend(event:KeyboardEvent, target:HTMLElement):void {
    this.focusItemElement(target);

    if (!event.shiftKey) {
      return;
    }

    const candidate = resolveCandidate(this.host.rootElement, target);
    if (!candidate) {
      return;
    }

    // The one entry point that used to skip this, so a Shift+Arrow could
    // paint a card every other gesture refuses.
    if (candidate.orderable) {
      this.extendSelectionTo(candidate);
    } else {
      this.announceSelection('not_selectable');
    }
  }

  // Focus goes through the host, which routes it to the item's own outlet so
  // the consumer decides which element inside the row holds the tab stop.
  private focusItemElement(target:HTMLElement):void {
    this.host.focusItem(target);
  }

  // Root-wide, unlike range selection: a range is confined to one list
  // because "between these two cards" is only meaningful within a single
  // list, but "everything orderable" has an unambiguous meaning across the
  // whole Backlogs root, and that is what select-all is for.
  private handleSelectAll(event:KeyboardEvent, candidate:SelectionCandidate):void {
    if (!event.metaKey && !event.ctrlKey) {
      return;
    }

    // Scoped to the anchoring candidate's type: a batch holds one kind of
    // thing, so "everything orderable" means everything of that kind.
    const cohortType = candidate.orderable ? candidate.type : this.firstOrderableCandidate()?.type;
    const items = liveOrderableItems(this.host.rootElement)
      .filter((item) => item.type === cohortType);
    // Consumed only once there is something to select. Swallowing the key on
    // a page with nothing selectable would block the browser's own
    // select-all and announce nothing in its place.
    if (items.length === 0) {
      return;
    }

    event.preventDefault();

    if (this.host.busy) {
      return;
    }

    const anchor:SelectionAnchor|null = candidate.orderable
      ? { type: candidate.type, id: candidate.id, listKey: candidate.listKey }
      : this.firstOrderableCandidate();

    this.selection.selectAll(items, anchor);
    this.renderSelection('selection');
  }

  // The design's anchor fallback when the focused card cannot itself anchor
  // the batch: the first orderable card in document order, resolved through
  // resolveCandidate like every other candidate rather than re-deriving its
  // list key from the DOM by hand.
  private firstOrderableCandidate():SelectionAnchor|null {
    for (const element of orderedItemElements(this.host.rootElement)) {
      const candidate = resolveCandidate(this.host.rootElement, element);
      if (candidate?.orderable) {
        return { type: candidate.type, id: candidate.id, listKey: candidate.listKey };
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
    this.renderSelection('selection');
  }

  /**
   * Whether a candidate belongs to the batch already being built.
   *
   * A batch holds one item type: "all of these together" has no meaning
   * across two different kinds of thing, and AGILE-278's collection move
   * sends one list of ids to one endpoint. This is orchestrator policy, not
   * a rule of the model — identity namespacing and batch compatibility are
   * different concerns, and a future consumer could legitimately act across
   * types without the framework-agnostic model having to allow it.
   */
  private cohortMatches(candidate:SelectionCandidate):boolean {
    const { anchor } = this.selection;

    return anchor === null || anchor.type === candidate.type;
  }

  /**
   * The single point where a candidate joins the batch by toggling.
   *
   * A candidate of a foreign type restarts onto itself rather than joining,
   * which is the same answer a cross-list Shift already gives. Routing every
   * adding gesture through here is what makes a mixed batch unreachable:
   * checking only ranges and select-all would still let Ctrl/Cmd-click and
   * Space build one.
   */
  private toggleWithinCohort(candidate:SelectionCandidate):void {
    if (!this.cohortMatches(candidate)) {
      this.renderRangeRestart(candidate);
      return;
    }

    this.selection.toggle({ type: candidate.type, id: candidate.id }, candidate.listKey);
    this.renderSelection('selection');
  }

  private extendSelectionTo(candidate:SelectionCandidate):void {
    const { anchor } = this.selection;

    if (anchor && !this.cohortMatches(candidate)) {
      this.renderRangeRestart(candidate);
      return;
    }

    if (!anchor) {
      this.renderRangeRestart(candidate);
      return;
    }

    const range = resolveRangeItems(
      this.host.rootElement,
      anchor,
      candidate,
      this.host.ownerRowsContainer(candidate.itemElement),
    );

    if (range.ok) {
      this.selection.range(range.items);
      this.renderSelection('selection');
      return;
    }

    if (range.reason === 'crossList') {
      this.renderRangeRestart(candidate);
      return;
    }

    // Same list, unrepresentable span: a truncated block or a fixed
    // card sits in the way, and the user needs to know which — expanding the
    // list can surface a truncated block, but it can never make a locked
    // card orderable, so the two reasons speak different messages.
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
    this.selection.replace({ type: candidate.type, id: candidate.id }, candidate.listKey);
    this.syncSelectionPresentation();
    this.lastRenderedKeys = this.selection.keys;
    this.announceSelection('range_restarted');
  }

  /**
   * Paints the selection and decides whether to announce it.
   *
   * Every call site but renderRangeRestart's narrow exception funnels through
   * here, and states which kind of gesture it is rather than its own
   * announcement policy — a fact the call site knows, so a future one cannot
   * get the policy wrong by forgetting it.
   *
   * The rule is the gesture class, not the count. A `navigation` gesture (a
   * plain click) announces only when the number of selected cards moves,
   * because the details pane it also opens is its own feedback and repeating
   * the same count on every click through the backlog would be noise. A
   * `selection` gesture announces whenever membership changes, because it has
   * no other feedback at all: a Shift-click that resizes a range to a
   * different set of the same size changed something the user must hear.
   */
  private renderSelection(kind:'navigation'|'selection'):void {
    const previous = this.lastRenderedKeys;
    this.syncSelectionPresentation();

    const current = this.selection.keys;
    this.lastRenderedKeys = current;

    const changed = kind === 'navigation'
      ? current.size !== previous.size
      : current.size !== previous.size || [...current].some((id) => !previous.has(id));

    if (changed) {
      this.announceSelection(current.size === 0 ? 'cleared' : 'selected');
    }
  }

  private syncSelectionPresentation():void {
    applySelectionPresentation(this.host.rootElement, this.selection.keys, this.host.descriptionId);
  }

  private announceSelection(key:'selected'|'cleared'|'not_selectable'|'range_unavailable'|'range_blocked'|'range_restarted'):void {
    void announce(this.selectionMessage(key), { politeness: 'polite' });
  }

  // The scope is a value rather than a constant so the shared controller can
  // speak the consumer's vocabulary: Backlogs says "work package", not "item".
  private selectionMessage(key:string):string {
    return I18n.t(`${this.host.announcementScope}.${key}`, { count: this.selection.size });
  }

  // Reconciles the model with the document after a morph, then repaints.
  // Presentation is re-synced regardless of whether prune dropped anything: a
  // morph can strip or preserve the marker attribute independently of the
  // model, so the DOM has to be brought back in line either way.
  reconcile():void {
    this.selection.prune(liveOrderableKeys(this.host.rootElement));
    this.rebindAnchorList();
    this.renderSelection('selection');
  }

  // The anchor's list key is stamped when the anchor is set — for a drag,
  // that is drag *start* — so a card dropped into another list leaves the
  // key naming the list it came from, and the next Shift gesture there reads
  // as cross-list and restarts the range instead of extending it. Runs after
  // prune, so it only ever sees an anchor that still exists.
  private rebindAnchorList():void {
    const { anchor } = this.selection;
    if (!anchor) {
      return;
    }

    // Matched on type as well as id: ids are unique per source table, so a
    // bare-id lookup can find an unrelated item of another type that happens
    // to share the id — and rebind the anchor to that item's list.
    const element = orderedItemElements(this.host.rootElement)
      .find((item) => resolveItemId(item) === anchor.id && resolveItemType(item) === anchor.type);
    const candidate = element ? resolveCandidate(this.host.rootElement, element) : null;

    if (candidate) {
      this.selection.rebindAnchor(candidate.listKey);
    }
  }

  // Removes presentation without touching the model. Whatever restores the
  // page builds a fresh orchestrator, so there is no state here worth
  // preserving — only markup that would otherwise outlive its meaning.
  clearPresentation():void {
    applySelectionPresentation(this.host.rootElement, new Set(), this.host.descriptionId);
  }

  teardown():void {
    this.clearPresentation();
  }
}
