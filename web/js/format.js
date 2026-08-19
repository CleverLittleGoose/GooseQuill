/**
 * GooseQuill — Shared display formatting.
 *
 * `money` lived in the Economics view, which was the only place that printed a
 * rate. The settings dropdown now prints the same rates from the same
 * registry, and two formatters would eventually disagree about what $1.875
 * looks like — on the same screen, in the same modal.
 */

/**
 * "$0.25", "$1.50", "$1.875" — two decimals unless the rate genuinely needs a
 * third. Rounding to two would print the half-price batch rate for a $3.75
 * model as $1.88, which is not what anyone is charged.
 */
export function money(value) {
  // Number(null) and Number("") are both 0, which would print a missing rate as
  // "$0.00" — a model that costs nothing rather than one whose price we do not
  // have. Say we do not know.
  if (value === null || value === undefined || value === "") return "—";

  const n = Number(value);
  if (!Number.isFinite(n)) return "—";

  let out = n.toFixed(3).replace(/0+$/, "");
  if (out.endsWith(".")) out = out.slice(0, -1);

  const [whole, fraction = ""] = out.split(".");
  return `$${whole}.${fraction.padEnd(2, "0")}`;
}
