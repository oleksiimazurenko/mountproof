import Logo from './Logo'
import { Nav } from './Nav'
import Spinner from './Spinner'
import Avatar from './Avatar'
import PremiumBadge from './PremiumBadge'

interface HeaderProps {
  user?: { name: string } | null
  loading?: boolean
}

export function Header({ user, loading }: HeaderProps) {
  let badge = null
  if (user) {
    badge = <PremiumBadge tier="gold" />
  }
  return (
    <header className="site-header">
      <Logo />
      {loading ? <Spinner /> : <Nav items={['home', 'shop']} />}
      {user && <Avatar src={user.name} />}
      {badge}
    </header>
  )
}
