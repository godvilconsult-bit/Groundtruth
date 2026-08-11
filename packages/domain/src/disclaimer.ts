/**
 * The non-cadastral disclaimer.
 *
 * Every export, in every format, carries this text. It is defined once, here in the
 * domain layer, so that no serialiser can ship without it and no serialiser can
 * paraphrase it. The wording is a compliance requirement, not copy — treat any
 * change as a legal review, not an edit.
 */
export const NON_CADASTRAL_DISCLAIMER: string =
  'Descriptive geospatial information. Not a cadastral survey. Does not determine ' +
  'or evidence any boundary, right, or interest in land.'; // gt-vocab-allow: the compliance text must name what it disclaims

/** Swahili rendering, for in-country delivery and the collection app. */
export const NON_CADASTRAL_DISCLAIMER_SW: string =
  'Taarifa za kijiografia za maelezo. Si upimaji wa ardhi. Haiamui wala ' +
  'haithibitishi mpaka, haki, au maslahi yoyote katika ardhi.';
