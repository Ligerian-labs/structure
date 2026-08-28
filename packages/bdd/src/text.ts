/**
 * Feature-text conventions shared by step definitions: whitespace-safe
 * comparison for locale-formatted values and the dd/MM/yyyy date convention
 * of business-authored tables.
 */

/**
 * Whitespace-normalized comparison: locale formatting (fr-FR money amounts)
 * emits non-breaking and narrow no-break spaces that plain string equality
 * never matches. Normalize both sides before comparing feature literals to
 * formatted values.
 */
export const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * dd/MM/yyyy (the convention of business-authored feature tables) →
 * yyyy-mm-dd (the wire format of schemas and commands).
 */
export const ddMmYyyyToIso = (featureDate: string): string => {
  const [day, month, year] = featureDate.split("/");
  if (day === undefined || month === undefined || year === undefined) {
    throw new Error(`"${featureDate}" is not a dd/MM/yyyy date`);
  }
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
};
