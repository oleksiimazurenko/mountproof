import PremiumBadge from './PremiumBadge'

interface ProductCardProps {
  title: string
  premium?: boolean
}

const ProductCard = ({ title, premium }: ProductCardProps) => (
  <article className="product-card">
    <h3>{title}</h3>
    {premium && <PremiumBadge tier="silver" />}
  </article>
)

export default ProductCard
