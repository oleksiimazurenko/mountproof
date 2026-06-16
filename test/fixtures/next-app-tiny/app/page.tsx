import { Header } from '../components/Header'
import ProductCard from '../components/ProductCard'

export default function HomePage() {
  return (
    <main>
      <Header user={null} />
      <ProductCard title="Starter" />
      <ProductCard title="Pro" premium />
    </main>
  )
}
