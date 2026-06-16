export default function BlogPage({ params }: { params: { slug: string[] } }) {
  return <main>Blog: {params.slug.join('/')}</main>
}
