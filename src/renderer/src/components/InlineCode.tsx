/** Renders `backtick` spans as <code>; everything else stays plain text (no markdown, no HTML). */
export default function InlineCode({ text }: { text: string }): React.JSX.Element {
  // Odd-indexed parts sit between a pair of backticks; an unpaired backtick stays as text.
  const parts = text.split('`')
  const paired = parts.length % 2 === 1 ? parts : [...parts.slice(0, -2), parts.slice(-2).join('`')]
  return (
    <>
      {paired.map((part, i) => (i % 2 === 1 && part !== '' ? <code key={i}>{part}</code> : part))}
    </>
  )
}
