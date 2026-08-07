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

# One configuration of a work package type: the form, workflows, subject patterns, PDF export
# settings and project attributes that apply where this variant is in force.
#
# Every type has exactly one base variant (`is_default_variant`, no name) holding the
# configuration it uses where no other has been chosen, plus any number of named variants.
# Which one applies is a property of the project (see ProjectType#variant), never of the work
# package: a work package stores its type, and the project decides the configuration.
class TypeVariant < ApplicationRecord
  ASPECTS = [
    PDF_EXPORT = "pdf_export",
    DEFAULTS = "defaults",
    WORKFLOWS = "workflows",
    FORM_CONFIGURATION = "form_configuration",
    PROJECT_ATTRIBUTES = "project_attributes"
  ].freeze

  include ::Scopes::Scoped
  include ::Type::Attributes
  include ::Type::AttributeGroups
  prepend ::TypeVariant::ConfigurationLinkable

  attribute :patterns, WorkPackageTypes::Patterns::CollectionType.new

  store_attribute :pdf_export_templates_config, :export_templates_disabled, :json
  store_attribute :pdf_export_templates_config, :export_templates_order, :json
  store_attribute :pdf_export_templates_config, :artefact_export_mode, :string

  belongs_to :type

  # The write target and the eager-loadable association.
  # Reads go through #workflows, which resolves them based on the WORKFLOWS linking mode.
  has_many :own_workflows,
           class_name: "Workflow",
           foreign_key: :type_variant_id,
           inverse_of: :type_variant,
           dependent: :delete_all do
    def copy_from_variant(source_variant)
      Workflow.copy(source_variant, nil, proxy_association.owner, nil)
    end
  end

  # The write target and the eager-loadable association.
  # Reads go through #project_custom_field_type_mappings, which resolves them based on the
  # PROJECT_ATTRIBUTES linking mode.
  has_many :own_project_custom_field_type_mappings,
           class_name: "ProjectCustomFieldTypeMapping",
           inverse_of: :type_variant,
           dependent: :destroy
  has_many :project_custom_fields, through: :own_project_custom_field_type_mappings,
                                   class_name: "ProjectCustomField"

  # Join table is still named custom_fields_types; converting to has_many :through would be a
  # separate cleanup of that legacy table name.
  has_and_belongs_to_many :custom_fields, # rubocop:disable Rails/HasAndBelongsToMany
                          class_name: "WorkPackageCustomField",
                          join_table: "#{table_name_prefix}custom_fields_types#{table_name_suffix}",
                          association_foreign_key: "custom_field_id"

  # The projects this variant is in force for.
  # autosave must stay off: assigning Type#projects builds a ProjectType, and setting its
  # variant puts that join row on this association via inverse_of. If we autosaved here,
  # the insert would only set variant_id and leave type_id NULL.
  has_many :project_types, foreign_key: :variant_id, inverse_of: :variant, dependent: :restrict_with_error,
                           autosave: false
  has_many :projects, through: :project_types

  validates :variant_name, length: { maximum: 255 }
  validates :variant_name,
            presence: true,
            uniqueness: { scope: :type_id, case_sensitive: false },
            unless: :is_default_variant?
  validate :base_variant_has_no_name

  scopes :with_effective_configuration, :with_effective_source

  scope :base, -> { where(is_default_variant: true) }
  scope :named, -> { where(is_default_variant: false) }

  # Base variants first, then the named ones alphabetically. Named variants have no user
  # ordering of their own, so every screen listing a type's variants reads this and the
  # orders cannot drift.
  scope :in_display_order, -> { order(is_default_variant: :desc, variant_name: :asc) }

  delegate :name, :color, :color_id, :is_milestone, :is_milestone?, :is_in_roadmap, :is_in_roadmap?,
           to: :type

  def self.statuses(variants, role: nil, tab: nil) # rubocop:disable Metrics/AbcSize
    workflow_table, status_table = [Workflow, Status].map(&:arel_table)
    old_id_subselect, new_id_subselect = %i[old_status_id new_status_id].map do |foreign_key|
      subquery = workflow_table.project(workflow_table[foreign_key])
                               .where(workflow_table[:type_variant_id].in(variants))
      subquery = subquery.where(workflow_table[:role_id].eq(role.id)) if role
      subquery = apply_tab_condition(subquery, workflow_table, tab) if tab
      subquery
    end
    Status.where(status_table[:id].in(old_id_subselect).or(status_table[:id].in(new_id_subselect)))
  end

  def self.apply_tab_condition(subquery, workflow_table, tab)
    case tab
    when "author"
      subquery.where(workflow_table[:author].eq(true))
    when "assignee"
      subquery.where(workflow_table[:assignee].eq(true))
    else
      subquery.where(workflow_table[:author].eq(false).and(workflow_table[:assignee].eq(false)))
    end
  end

  # What users call this configuration: a named variant by its own name, the base one by the
  # type it configures.
  def display_name
    variant_name.presence || type.name
  end

  # "Bug: Hardware" — for pickers that list variants across types, where a bare variant name
  # would not say which type it configures.
  def composite_name
    is_default_variant? ? type.name : "#{type.name}: #{variant_name}"
  end

  # Writers use #own_workflows; the flag-off branch also keeps it so an eager-loaded
  # association stays usable. When variants are on, the effective owner is resolved inside the
  # query, avoiding a separate resolution round-trip.
  def workflows
    return own_workflows unless resolve_aspect_in_sql?

    Workflow.where(Workflow.arel_table[:type_variant_id].in(effective_source_id_ref(WORKFLOWS)))
  end

  # Writers use #own_project_custom_field_type_mappings; the flag-off branch keeps it too.
  def project_custom_field_type_mappings
    return own_project_custom_field_type_mappings unless resolve_aspect_in_sql?

    mappings = ProjectCustomFieldTypeMapping.where(
      ProjectCustomFieldTypeMapping.arel_table[:type_variant_id].in(effective_source_id_ref(PROJECT_ATTRIBUTES))
    )
    excluded_ids = excluded_custom_field_ids(PROJECT_ATTRIBUTES)
    return mappings if excluded_ids.empty?

    mappings.where.not(custom_field_id: excluded_ids)
  end

  def statuses(include_default: false, role: nil, tab: nil)
    return Status.none if new_record?

    variant_ref = resolve_aspect_in_sql? ? effective_source_id_ref(WORKFLOWS) : [id]
    scope = self.class.statuses(variant_ref, role:, tab:)
    include_default ? scope.or(Status.where_default) : scope
  end

  # A project only shows custom fields its own activation includes, so fields on this
  # variant's form have to be activated wherever that form is in force, or the form silently
  # omits them.
  def activate_custom_fields_in_effective_projects!
    return if custom_field_ids.empty?

    projects.each do |project|
      project.work_package_custom_field_ids |= custom_field_ids
    end
  end

  def replacement_pattern_defined_for?(attribute)
    enabled_patterns.key?(attribute)
  end

  def enabled_patterns
    patterns.all_enabled
  end

  def pdf_export_templates
    @pdf_export_templates ||= ::Type::PdfExportTemplates.new(self)
  end

  # The store_attribute :default is not returned when the JSON key is present but nil, so
  # mirror the getter-override pattern used elsewhere to guarantee a value.
  def artefact_export_mode
    super.presence || Type::ArtefactExport::DEFAULT
  end

  def artefact_export_enabled?
    artefact_export_mode != Type::ArtefactExport::OFF
  end

  private

  # Mirrors the type_variants_base_has_no_name CHECK constraint so the disagreement surfaces
  # as a validation error rather than a database exception.
  def base_variant_has_no_name
    return if is_default_variant? == variant_name.nil?

    errors.add(:variant_name, is_default_variant? ? :must_be_blank : :blank)
  end
end
