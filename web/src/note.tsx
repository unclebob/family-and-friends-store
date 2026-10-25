export function Note({ text, className, label }: { text: string; className?: string; label?: string }) {
  if (!text) return null;
  return <p className={className}>{prefix(label)}{text}</p>;
}

function prefix(label: string | undefined): string {
  return label ? `${label} ` : "";
}
