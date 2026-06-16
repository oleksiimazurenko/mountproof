export function Nav({ items }: { items: string[] }) {
  return (
    <nav>
      {items.map((it) => (
        <a key={it} href={`/${it}`}>
          {it}
        </a>
      ))}
    </nav>
  )
}
