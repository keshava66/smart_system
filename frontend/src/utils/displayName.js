// "Last, First Middle" from the directory -> "First Last"; "First Middle Last" -> "First Last".
export function firstLast(name) {
  const [last, rest] = name.includes(",") ? name.split(",", 2) : [null, name];
  const words = rest.trim().split(/\s+/).filter(Boolean);
  const surname = last?.trim() || (words.length > 1 ? words[words.length - 1] : "");
  return [words[0], surname].filter(Boolean).join(" ") || name;
}
