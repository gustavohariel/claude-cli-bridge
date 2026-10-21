export function questionText(question: Record<string, unknown>, text: string): string {
  const options = (Array.isArray(question.options) ? question.options : []).flatMap((value) => {
    const option = objectValue(value);
    const label = stringValue(option?.label)?.trim();
    const description = stringValue(option?.description)?.trim();
    return label ? [`- ${label}${description ? ` — ${description}` : ""}`] : [];
  });
  return options.length > 0 ? `${text}\n\n${options.join("\n")}` : text;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
