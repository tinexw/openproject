# frozen_string_literal: true

#-- copyright
# OpenProject is an open source project management software.
# Copyright (C) the OpenProject GmbH
#
# This program is free software; you can redistribute it and/or
# modify it under the terms of the GNU General Public License version 3.
#
# OpenProject is a fork of ChiliProject, which is a fork of Redmine. The copyright follows:
# Copyright (C) 2006-2013 Jean-Philippe Lang
# Copyright (C) 2010-2013 the ChiliProject Team
#
# This program is free software; you can redistribute it and/or
# modify it under the terms of the GNU General Public License
# as published by the Free Software Foundation; either version 2
# of the License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program; if not, write to the Free Software
# Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
#
# See COPYRIGHT and LICENSE files for more details.
#++

require "spec_helper"
require_relative "../../support/pages/backlog"

# Selenium, not Cuprite: modifier key combinations (Ctrl/Cmd+A,
# Shift+ArrowDown) are driven through native `send_keys`, and the unit specs
# already prove each gesture in isolation against a synthetic root. What they
# cannot prove is that the root's capture-phase listener really does beat the
# card's own click and Enter handlers in a real page — the one interaction
# most likely to regress silently.
RSpec.describe "Backlogs batch selection", :js, :selenium, :settings_reset do
  let!(:project) do
    create(:project,
           types: [type],
           enabled_module_names: %w(work_package_tracking backlogs))
  end
  let(:manage_sprint_items_role) do
    create(:project_role,
           permissions: %i(view_sprints
                           manage_sprint_items
                           view_work_packages
                           edit_work_packages))
  end

  let(:type) { create(:type) }

  let!(:sprint) { create(:sprint, project:) }
  let!(:story1) { create(:work_package, sprint:, type:, project:) }
  let!(:story2) { create(:work_package, sprint:, type:, project:) }
  let!(:story3) { create(:work_package, sprint:, type:, project:) }
  let!(:story4) { create(:work_package, sprint:, type:, project:) }
  let!(:bucket) { create(:backlog_bucket, project:, name: "Backlog bucket") }
  let!(:bucket_wp1) { create(:work_package, backlog_bucket: bucket, position: 1, type:, project:) }
  let!(:bucket_wp2) { create(:work_package, backlog_bucket: bucket, position: 2, type:, project:) }

  let(:backlogs_page) { Pages::Backlog.new(project) }

  current_user do
    create(:user, member_with_roles: { project => manage_sprint_items_role })
  end

  before do
    backlogs_page.visit!
  end

  describe "mouse gestures" do
    it "collapses a wider selection onto the clicked card, still opens its details, " \
       "and hides the count again" do
      backlogs_page.select_card(story1)
      backlogs_page.toggle_card(story2)
      backlogs_page.select_card(story3)

      expect(page).to have_css("[data-batch-selected]", count: 1)
      expect(backlogs_page.selected_card_ids).to eq([story3.id.to_s])
      backlogs_page.expect_details_view(story3)
      backlogs_page.expect_no_selection_count
    end

    it "toggles a sparse selection across two lists without navigating" do
      # Seeded with a toggle, not a plain click: a plain click schedules its
      # details-pane visit on a timer, so a navigation would still be pending
      # when the path is asserted below, and the assertion would pass whether
      # or not the capture-phase stopPropagation it exists to catch is there.
      # A modified click never navigates by design, so no visit is ever
      # pending and the assertion is real.
      backlogs_page.toggle_card(story1)
      backlogs_page.toggle_card(bucket_wp1)

      expect(page).to have_css("[data-batch-selected]", count: 2)
      expect(backlogs_page.selected_card_ids).to contain_exactly(story1.id.to_s, bucket_wp1.id.to_s)
      backlogs_page.expect_selection_count(2)
      # The modified click must never reach the card's own click handler: if it
      # did, the details pane would have opened and the path would have changed.
      expect(page).to have_current_path(backlogs_page.path, ignore_query: true)
    end

    # BatchSelection#toggle re-bases the anchor even on a deselect. Toggling
    # story2 on and back off must leave the anchor on story2, not story1, so a
    # later range starts from there.
    it "re-bases the anchor to a toggled card even when the toggle deselects it" do
      backlogs_page.select_card(story1)
      backlogs_page.toggle_card(story2)
      backlogs_page.toggle_card(story2)

      expect(page).to have_css("[data-batch-selected]", count: 1)

      backlogs_page.extend_selection_to(story4)

      expect(page).to have_css("[data-batch-selected]", count: 3)
      expect(backlogs_page.selected_card_ids).to eq([story2, story3, story4].map { it.id.to_s })
    end

    it "resizes one fixed-anchor range rather than walking it" do
      backlogs_page.select_card(story1)
      backlogs_page.extend_selection_to(story3)

      expect(page).to have_css("[data-batch-selected]", count: 3)
      expect(backlogs_page.selected_card_ids).to eq([story1, story2, story3].map { it.id.to_s })

      backlogs_page.extend_selection_to(story2)

      expect(page).to have_css("[data-batch-selected]", count: 2)
      expect(backlogs_page.selected_card_ids).to eq([story1, story2].map { it.id.to_s })
    end

    # A range cannot span lists, but the gesture is not refused outright: it
    # starts a fresh single-card selection in the new list and re-anchors
    # there, which the follow-up range proves.
    it "refuses to extend a range across lists and starts a fresh selection there" do
      backlogs_page.select_card(story1)
      backlogs_page.extend_selection_to(bucket_wp2)

      expect(page).to have_css("[data-batch-selected]", count: 1)
      expect(backlogs_page.selected_card_ids).to eq([bucket_wp2.id.to_s])

      backlogs_page.extend_selection_to(bucket_wp1)

      expect(page).to have_css("[data-batch-selected]", count: 2)
      expect(backlogs_page.selected_card_ids).to eq([bucket_wp1, bucket_wp2].map { it.id.to_s })
    end
  end

  describe "keyboard interaction" do
    it "paints a row with a different background once it is selected" do
      # A click is unsuitable as the "before" state here: it moves focus,
      # opens the details pane, and toggles batch membership all at once, so
      # comparing colours around it could not tell which of the three
      # produced any difference observed. Space changes exactly one thing —
      # batch membership — so focus is established first and held constant
      # across both reads, isolating `data-batch-selected` as the only
      # variable between them.
      backlogs_page.focus_work_package_card(story1)
      unselected_color = backlogs_page.row_background_color(story1)

      backlogs_page.work_package_card(story1).send_keys(:space)

      expect(page).to have_css("[data-batch-selected]", count: 1)
      expect(backlogs_page.row_background_color(story1)).not_to eq(unselected_color)
    end

    it "selects and clears with the keyboard" do
      backlogs_page.work_package_card(story1).send_keys(:space)

      expect(page).to have_css("[data-batch-selected]", count: 1)
      expect(backlogs_page.selected_card_ids).to eq([story1.id.to_s])

      backlogs_page.work_package_card(story1).send_keys(:escape)

      expect(page).to have_no_css("[data-batch-selected]")
      expect(backlogs_page.selected_card_ids).to be_empty
    end

    # Root-wide, not list-scoped: the fixtures span a sprint and a bucket
    # precisely so a regression that only selects the focused card's own list
    # would leave this short of all six.
    it "selects every movable card across the whole root with Ctrl/Cmd+A" do
      backlogs_page.send_work_package_card_keys(story1, [:control, "a"])

      expect(page).to have_css("[data-batch-selected]", count: 6)
      expect(backlogs_page.selected_card_ids).to contain_exactly(
        story1.id.to_s, story2.id.to_s, story3.id.to_s, story4.id.to_s,
        bucket_wp1.id.to_s, bucket_wp2.id.to_s
      )
    end

    it "extends the selection from a fixed anchor with Shift+ArrowDown" do
      backlogs_page.work_package_card(story1).send_keys(:space)
      expect(page).to have_css("[data-batch-selected]", count: 1)

      backlogs_page.send_work_package_card_keys(story1, %i[shift arrow_down])

      expect(page).to have_css("[data-batch-selected]", count: 2)
      expect(backlogs_page.selected_card_ids).to eq([story1, story2].map { it.id.to_s })
    end

    # Enter belongs to the card's own activation handler; the selection
    # controller's keydown listener deliberately leaves it unhandled. This
    # proves that holds in a real page, not only where the unit specs read it.
    it "opens details with Enter without the selection handler swallowing it" do
      backlogs_page.send_work_package_card_keys(story2, [:enter])

      backlogs_page.expect_details_view(story2)
    end
  end

  describe "selection persistence and accessibility" do
    it "keeps the batch selected when the current work package changes" do
      backlogs_page.select_card(story1)
      # A plain click's navigation is deliberately deferred (the card's own
      # click handler waits out a double-click window before it visits), so
      # without this wait the still-pending visit for story1 can land while
      # story3's lazily loaded actions menu is opening a few lines below,
      # racing the fetch a fragile popover-open sequence depends on. Every
      # other scenario either never triggers a pending visit at this point or
      # only interacts with the same card afterwards, so this is the one
      # place that race is reachable.
      backlogs_page.expect_details_view(story1)
      backlogs_page.toggle_card(story2)

      expect(page).to have_css("[data-batch-selected]", count: 2)

      backlogs_page.open_work_package_details(story3)

      expect(page).to have_css("[data-batch-selected]", count: 2)
      expect(backlogs_page.selected_card_ids).to contain_exactly(story1.id.to_s, story2.id.to_s)
    end

    it "describes a selected card to assistive technology via the shared description" do
      backlogs_page.select_card(story1)
      backlogs_page.toggle_card(story2)

      expect(page).to have_css("[data-batch-selected]", count: 2)
      # Rendered exactly once, which is what makes "one shared description"
      # below a claim about the same element rather than about two separately
      # rendered ones that happen to agree.
      backlogs_page.expect_selection_description_present

      # The card, not the row: it is the focus host, and a description is
      # computed from the focused element's own `aria-describedby` rather than
      # inherited from an ancestor. Asserting the computed description also
      # proves the browser does traverse into the permanently `hidden`
      # description element, which is only true because it is referenced
      # directly by `aria-describedby`.
      description = I18n.t("js.backlogs.selection.card_state")
      backlogs_page.expect_work_package_card_described_as(story1, description)
      backlogs_page.expect_work_package_card_described_as(story2, description)
      # The converse, without which the two above would pass just as happily if
      # every card were described whether selected or not.
      backlogs_page.expect_work_package_card_not_described(story3)
    end
  end
end
