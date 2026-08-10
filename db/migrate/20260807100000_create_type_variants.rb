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

# Splits a type's configuration out of `types` and into `type_variants`. After this,
# `types` carries identity only (name, color, milestone, roadmap) and every configuration
# — including each type's base one — is a `type_variants` row.
#
# A variant stops being a `types` row entirely: the former variant rows are converted and
# then deleted, and `parent_id` is dropped so the shape cannot recur.
class CreateTypeVariants < ActiveRecord::Migration[8.0]
  ASPECTS = %w[pdf_export defaults workflows form_configuration project_attributes].freeze

  # Only these two aspects are lists a variant can narrow: form configuration drops attributes
  # and embedded queries, project attributes drops custom fields. The rest are single values
  # a variant either inherits whole or owns outright, so they get no exclusions column.
  EXCLUDABLE_ASPECTS = %w[form_configuration project_attributes].freeze

  # types column => type_variants column. `description` is renamed: on a type it
  # looked like a description of the type, but it is the default text for new
  # work packages of that configuration.
  CONFIGURATION_COLUMNS = {
    "attribute_groups" => "attribute_groups",
    "description" => "default_work_package_description",
    "patterns" => "patterns",
    "pdf_export_templates_config" => "pdf_export_templates_config"
  }.freeze

  def up
    create_type_variants
    backfill_variants
    migrate_configuration_links
    # Its rows have been consumed, and its FKs to `types` would block the delete below.
    drop_table :type_configuration_links
    repoint_workflows
    repoint_custom_fields_types
    repoint_project_custom_field_type_mappings
    repoint_project_types
    drop_variant_types
    drop_legacy_tables
  end

  def down
    raise ActiveRecord::IrreversibleMigration
  end

  private

  def create_type_variants
    define_type_variants_table
    add_type_variants_constraints
  end

  def define_type_variants_table
    create_table :type_variants do |t|
      t.references :type, null: false, foreign_key: { on_delete: :cascade }
      t.string :variant_name
      t.boolean :is_default_variant, null: false, default: false

      t.text :attribute_groups
      t.text :default_work_package_description
      t.text :patterns
      t.jsonb :pdf_export_templates_config, default: {}

      ASPECTS.each do |aspect|
        t.bigint :"#{aspect}_source_id"
      end

      EXCLUDABLE_ASPECTS.each do |aspect|
        t.text :"#{aspect}_excluded_elements", array: true, null: false, default: []
      end

      # Dropped at the end of this migration. Carries the types.id each row was built from
      # so every re-point below is a plain join rather than a correlated lookup.
      t.bigint :legacy_type_id

      t.timestamps
    end
  end

  def add_type_variants_constraints
    ASPECTS.each do |aspect|
      add_foreign_key :type_variants, :type_variants, column: :"#{aspect}_source_id", on_delete: :restrict
      add_index :type_variants, :"#{aspect}_source_id"
    end

    add_index :type_variants, :legacy_type_id

    # A base variant is exactly the one without a name, so the two cannot disagree.
    add_check_constraint :type_variants,
                         "is_default_variant = (variant_name IS NULL)",
                         name: "type_variants_base_has_no_name"

    add_index :type_variants, :type_id,
              unique: true,
              where: "is_default_variant",
              name: "index_type_variants_one_base_per_type"
    add_index :type_variants, "type_id, lower(variant_name)",
              unique: true,
              where: "variant_name IS NOT NULL",
              name: "index_type_variants_on_type_id_and_LOWER_variant_name"
  end

  def backfill_variants
    source_columns = CONFIGURATION_COLUMNS.keys.join(", ")
    target_columns = CONFIGURATION_COLUMNS.values.join(", ")

    # A root type's own configuration becomes its base variant.
    execute <<~SQL.squish
      INSERT INTO type_variants
        (type_id, variant_name, is_default_variant, #{target_columns}, legacy_type_id, created_at, updated_at)
      SELECT id, NULL, true, #{source_columns}, id, now(), now()
      FROM types
      WHERE parent_id IS NULL
    SQL

    # Each variant type becomes a named variant of the type it hung off.
    execute <<~SQL.squish
      INSERT INTO type_variants
        (type_id, variant_name, is_default_variant, #{target_columns}, legacy_type_id, created_at, updated_at)
      SELECT parent_id, name, false, #{source_columns}, id, now(), now()
      FROM types
      WHERE parent_id IS NOT NULL
    SQL
  end

  # Each (type, aspect) link row becomes the matching columns on the variant. Exclusions
  # recorded against an aspect that cannot be narrowed are dropped: nothing ever read them.
  def migrate_configuration_links
    ASPECTS.each do |aspect|
      assignments = ["#{aspect}_source_id = source.id"]
      assignments << "#{aspect}_excluded_elements = l.excluded_elements" if EXCLUDABLE_ASPECTS.include?(aspect)

      execute <<~SQL.squish
        UPDATE type_variants v
        SET #{assignments.join(', ')}
        FROM type_configuration_links l
        JOIN type_variants source ON source.legacy_type_id = l.source_id
        WHERE v.legacy_type_id = l.type_id
          AND l.aspect = #{quote(aspect)}
      SQL
    end
  end

  def repoint_workflows
    remove_index :workflows, name: "wkfs_role_type_old_status"
    move_type_reference :workflows
    add_index :workflows, %i[role_id type_variant_id old_status_id], name: "wkfs_role_type_variant_old_status"
  end

  def repoint_custom_fields_types
    remove_index :custom_fields_types, name: "custom_fields_types_unique"
    move_type_reference :custom_fields_types
    add_index :custom_fields_types, %i[custom_field_id type_variant_id],
              unique: true, name: "custom_fields_types_unique"
  end

  def repoint_project_custom_field_type_mappings
    remove_index :project_custom_field_type_mappings, name: "index_project_custom_field_type_mappings_unique"
    move_type_reference :project_custom_field_type_mappings
    add_index :project_custom_field_type_mappings, %i[type_variant_id custom_field_id],
              unique: true, name: "index_project_custom_field_type_mappings_unique"
  end

  # Swaps a table's type_id for the type_variant_id of the variant that type became.
  def move_type_reference(table)
    add_column table, :type_variant_id, :bigint

    execute <<~SQL.squish
      UPDATE #{table} t
      SET type_variant_id = v.id
      FROM type_variants v
      WHERE v.legacy_type_id = t.type_id
    SQL

    change_column_null table, :type_variant_id, false
    remove_column table, :type_id
    add_foreign_key table, :type_variants, column: :type_variant_id, on_delete: :cascade
    add_index table, :type_variant_id
  end

  # variant_id stops being "a variant, or NULL for the type's own configuration" and becomes
  # the configuration in force, always present. Every read path drops a COALESCE for it.
  def repoint_project_types
    remove_foreign_key :project_types, column: :variant_id

    execute <<~SQL.squish
      UPDATE project_types pt
      SET variant_id = v.id
      FROM type_variants v
      WHERE v.legacy_type_id = COALESCE(pt.variant_id, pt.type_id)
    SQL

    change_column_null :project_types, :variant_id, false
    add_foreign_key :project_types, :type_variants, column: :variant_id, on_delete: :restrict
  end

  def drop_variant_types
    guard_no_work_packages_on_variants

    # A custom action naming a variant has nothing to target once variants stop being types.
    execute <<~SQL.squish
      DELETE FROM custom_actions_types
      WHERE type_id IN (SELECT id FROM types WHERE parent_id IS NOT NULL)
    SQL

    # Journals snapshot the type, and nothing constrains them, so a leftover variant id would
    # simply dangle once the row is gone.
    execute <<~SQL.squish
      UPDATE work_package_journals j
      SET type_id = t.parent_id
      FROM types t
      WHERE t.id = j.type_id AND t.parent_id IS NOT NULL
    SQL

    execute "DELETE FROM types WHERE parent_id IS NOT NULL"

    remove_index :types, name: "index_types_on_LOWER_name_and_parent_id"
    remove_column :types, :parent_id
    add_index :types, "lower(name)", unique: true, name: "index_types_on_LOWER_name"

    CONFIGURATION_COLUMNS.each_key { |column| remove_column :types, column }
  end

  def drop_legacy_tables
    remove_column :type_variants, :legacy_type_id

    # Superseded by project_types in 20260804123419; nothing has read it since.
    drop_table :projects_types
  end

  # work_packages.type_id cascades on delete, so a work package still pointing at a variant
  # would be deleted along with it rather than reported. 20260804123449 retyped them all to
  # roots; refuse to proceed if anything reintroduced one.
  def guard_no_work_packages_on_variants
    stranded = select_value(<<~SQL.squish).to_i
      SELECT count(*) FROM work_packages wp
      JOIN types t ON t.id = wp.type_id
      WHERE t.parent_id IS NOT NULL
    SQL

    return if stranded.zero?

    raise ActiveRecord::IrreversibleMigration,
          "#{stranded} work package(s) still reference a variant type. Re-run 20260804123449 " \
          "before this migration: deleting those types would cascade to the work packages."
  end
end
