import { Schema } from "effect";

import { AcpTolerantArray } from "./primitives.ts";

import { acpField, acpOptionalField, AcpMetaFields } from "./content.ts";

const AcpSessionConfigSelectOption = Schema.Struct({
  ...AcpMetaFields.fields,
  description: acpOptionalField(
    Schema.String,
    "Optional description for this option value."
  ),
  name: acpField(Schema.String, "Human-readable label for this option value."),
  value: acpField(Schema.String, "Unique identifier for this option value."),
});

const AcpSessionConfigSelectGroup = Schema.Struct({
  ...AcpMetaFields.fields,
  group: acpField(Schema.String, "Unique identifier for this group."),
  name: acpField(Schema.String, "Human-readable label for this group."),
  options: AcpTolerantArray(
    AcpSessionConfigSelectOption,
    "The set of option values in this group."
  ),
});

const AcpSessionConfigSelectOptions = Schema.Union([
  Schema.Array(AcpSessionConfigSelectOption),
  Schema.Array(AcpSessionConfigSelectGroup),
]);

const AcpSessionConfigOptionBase = Schema.Struct({
  ...AcpMetaFields.fields,
  category: acpOptionalField(
    Schema.String,
    "Optional semantic category for this option (UX only)."
  ),
  description: acpOptionalField(
    Schema.String,
    "Optional description for the Client to display to the user."
  ),
  id: acpField(
    Schema.String,
    "Unique identifier for the configuration option."
  ),
  name: acpField(Schema.String, "Human-readable label for the option."),
});

const AcpSessionConfigSelect = Schema.Struct({
  ...AcpSessionConfigOptionBase.fields,
  currentValue: acpField(Schema.String, "The currently selected value."),
  options: acpField(
    AcpSessionConfigSelectOptions,
    "The set of selectable options."
  ),
  type: acpField(Schema.Literal("select"), "ACP session config option type."),
});

const AcpSessionConfigBoolean = Schema.Struct({
  ...AcpSessionConfigOptionBase.fields,
  currentValue: acpField(
    Schema.Boolean,
    "The current value of the boolean option."
  ),
  type: acpField(Schema.Literal("boolean"), "ACP session config option type."),
});

const AcpSessionConfigOption = Schema.Union([
  AcpSessionConfigSelect,
  AcpSessionConfigBoolean,
])
  .annotate({
    description:
      "A session configuration option selector and its current state.",
    identifier: "AcpSessionConfigOption",
  })
  .pipe(Schema.toTaggedUnion("type"));

export { AcpSessionConfigOption };
