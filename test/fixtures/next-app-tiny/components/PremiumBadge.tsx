interface PremiumBadgeProps {
  tier: 'gold' | 'silver'
}

export default function PremiumBadge({ tier }: PremiumBadgeProps) {
  return <span data-test-id="premium-badge" className={`badge badge--${tier}`} />
}
