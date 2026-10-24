/** Deterministic artwork gradient from a title, so cards never render blank. */
const PALETTES: [string, string][] = [
  ["#f97316", "#7c2d12"],
  ["#dc2626", "#450a0a"],
  ["#2563eb", "#172554"],
  ["#7c3aed", "#2e1065"],
  ["#0d9488", "#042f2e"],
  ["#ca8a04", "#422006"],
  ["#db2777", "#500724"],
  ["#4f46e5", "#1e1b4b"],
  ["#059669", "#022c22"],
  ["#64748b", "#0f172a"],
];

export function paletteFor(seed: string): [string, string] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return PALETTES[Math.abs(h) % PALETTES.length]!;
}
