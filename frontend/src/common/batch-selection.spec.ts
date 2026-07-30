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

import { BatchSelection } from './batch-selection';

describe('BatchSelection', () => {
  let selection:BatchSelection;

  beforeEach(() => {
    selection = new BatchSelection();
  });

  it('starts empty with no anchor', () => {
    expect(selection.size).toBe(0);
    expect(selection.anchor).toBeNull();
  });

  it('replaces the batch and establishes the anchor', () => {
    selection.replace('1', 'sprint:7');
    selection.replace('2', 'sprint:7');

    expect([...selection.ids]).toEqual(['2']);
    expect(selection.anchor).toEqual({ id: '2', listKey: 'sprint:7' });
  });

  it('re-bases the anchor when toggling on', () => {
    selection.replace('1', 'sprint:7');
    selection.toggle('2', 'sprint:7');

    expect([...selection.ids]).toEqual(['1', '2']);
    expect(selection.anchor).toEqual({ id: '2', listKey: 'sprint:7' });
  });

  // The anchor deliberately survives its own deselection: the next Shift
  // gesture still measures its range from the card the user last touched.
  it('re-bases the anchor when toggling off', () => {
    selection.replace('1', 'sprint:7');
    selection.toggle('1', 'sprint:7');

    expect(selection.size).toBe(0);
    expect(selection.anchor).toEqual({ id: '1', listKey: 'sprint:7' });
  });

  it('replaces the batch with a range and preserves the anchor', () => {
    selection.replace('1', 'sprint:7');
    selection.range(['1', '2', '3']);
    selection.range(['1', '2']);

    expect([...selection.ids]).toEqual(['1', '2']);
    expect(selection.anchor).toEqual({ id: '1', listKey: 'sprint:7' });
  });

  it('selects all with an explicit anchor', () => {
    selection.selectAll(['3', '1', '2'], { id: '2', listKey: 'sprint:7' });

    expect([...selection.ids]).toEqual(['3', '1', '2']);
    expect(selection.anchor).toEqual({ id: '2', listKey: 'sprint:7' });
  });

  it('clears the batch and the anchor', () => {
    selection.replace('1', 'sprint:7');
    selection.clear();

    expect(selection.size).toBe(0);
    expect(selection.anchor).toBeNull();
  });

  it('prunes ids that are no longer live and reports the change', () => {
    selection.replace('1', 'sprint:7');
    selection.toggle('2', 'sprint:7');

    expect(selection.prune(new Set(['1']))).toBe(true);
    expect([...selection.ids]).toEqual(['1']);
    expect(selection.prune(new Set(['1']))).toBe(false);
  });

  it('drops an anchor whose card is gone', () => {
    selection.replace('1', 'sprint:7');
    selection.prune(new Set<string>());

    expect(selection.anchor).toBeNull();
  });

  it('reports membership without exposing mutable state', () => {
    selection.replace('1', 'sprint:7');

    expect(selection.has('1')).toBe(true);
    expect(selection.has('2')).toBe(false);
  });
});
