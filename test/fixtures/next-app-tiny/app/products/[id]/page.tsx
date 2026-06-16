import ProductCard from '../../../components/ProductCard'

export default function ProductPage({ params }: { params: { id: string } }) {
  return (
    <main>
      <ProductCard title={`Product ${params.id}`} premium />
    </main>
  )
}
