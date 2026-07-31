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

/**
 * The work package from which a contiguous batch range is measured.
 *
 * `listKey` is opaque here: the model records which list a range may span
 * without learning what a list is. Its holder decides how to derive it.
 */
export interface SelectionAnchor {
  id:string;
  listKey:string;
}

/**
 * Batch selection state and anchor semantics, free of any framework.
 *
 * It stores membership and an anchor, and nothing else. It deliberately does
 * not store visual order: order is a property of the live document, and a
 * snapshot taken here would go stale the moment a morph reorders rows. Range
 * feasibility is likewise resolved outside — callers hand in an already
 * resolved range, or do not call `range` at all.
 */
export class BatchSelection {
  private selectedIds = new Set<string>();
  private selectionAnchor:SelectionAnchor|null = null;

  get ids():ReadonlySet<string> {
    return this.selectedIds;
  }

  get anchor():SelectionAnchor|null {
    return this.selectionAnchor;
  }

  get size():number {
    return this.selectedIds.size;
  }

  has(id:string):boolean {
    return this.selectedIds.has(id);
  }

  replace(id:string, listKey:string):void {
    this.selectedIds = new Set([id]);
    this.selectionAnchor = { id, listKey };
  }

  // Re-bases the anchor even when the toggle deselects: the user's last
  // touched card is where they expect the next range to start from.
  toggle(id:string, listKey:string):void {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
    } else {
      this.selectedIds.add(id);
    }

    this.selectionAnchor = { id, listKey };
  }

  // The anchor stays put so repeated Shift gestures resize one range rather
  // than walking it across the list.
  range(rangeIds:readonly string[]):void {
    this.selectedIds = new Set(rangeIds);
  }

  selectAll(ids:readonly string[], anchor:SelectionAnchor|null):void {
    this.selectedIds = new Set(ids);
    this.selectionAnchor = anchor;
  }

  clear():void {
    this.selectedIds = new Set();
    this.selectionAnchor = null;
  }

  /**
   * Drops members and an anchor that no longer exist in the document.
   *
   * @return whether membership or the anchor changed — a convenience for a
   *   caller that wants to skip redundant work when nothing did. The
   *   current caller (SortableListsController's morph heal) does not use it
   *   that way: it has to resync DOM presentation after every morph
   *   regardless of whether the model changed, so it discards this value
   *   and re-renders unconditionally. The signal is kept for a future
   *   caller that can actually act on it.
   */
  prune(liveIds:ReadonlySet<string>):boolean {
    let changed = false;

    for (const id of this.selectedIds) {
      if (!liveIds.has(id)) {
        this.selectedIds.delete(id);
        changed = true;
      }
    }

    if (this.selectionAnchor && !liveIds.has(this.selectionAnchor.id)) {
      this.selectionAnchor = null;
      changed = true;
    }

    return changed;
  }
}
